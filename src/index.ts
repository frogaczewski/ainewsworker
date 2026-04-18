import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import { callHaiku, callSonnet } from './llm';
import { buildTriagePrompt, buildCompilationPrompt, buildEmailBriefingPrompt, buildHeadlineEmailPrompt, buildTranslationPrompt } from './prompts';
import { sendDigestEmail, sendErrorEmail } from './email';
import { EMAIL_TO, EMAIL_TO_PL } from './config';
import { buildLandingPage, buildStoryPage, generateSlug } from './landing';
import type { Env, TriagedStory, FeedStatus, DigestData } from './types';

function greetedMarkdown(markdown: string, recipientName: string, polish: boolean): string {
  const firstName = recipientName.split(' ')[0];
  const greeting = polish ? `Dzień dobry, ${firstName}!` : `Good morning, ${firstName}!`;
  return `${greeting}\n\n${markdown}`;
}

/**
 * Replace generic website links in the email briefing with proper /story/{date}/{slug} links.
 * Finds each "Read ... →" link pointing to the base websiteUrl, looks at the nearest
 * preceding h2/h3 header, generates a slug from it, and rewrites the link.
 */
function rewriteStoryLinks(markdown: string, websiteUrl: string, date: string): string {
  const lines = markdown.split('\n');
  let lastHeaderSlug = '';
  const baseUrl = websiteUrl.replace(/\/$/, '');

  for (let i = 0; i < lines.length; i++) {
    // Track the most recent h2/h3 header
    const headerMatch = lines[i].match(/^#{2,3}\s+(.+)/);
    if (headerMatch) {
      lastHeaderSlug = generateSlug(headerMatch[1]);
    }

    // Replace generic links with story-specific links
    if (lastHeaderSlug && (lines[i].includes(`](${websiteUrl})`) || lines[i].includes(`](${baseUrl})`))) {
      const storyUrl = `${baseUrl}/story/${date}/${lastHeaderSlug}`;
      lines[i] = lines[i]
        .replace(`](${websiteUrl})`, `](${storyUrl})`)
        .replace(`](${baseUrl})`, `](${storyUrl})`);
    }
  }

  return lines.join('\n');
}

interface PipelineOptions {
  dryRun?: boolean;  // skip compilation, translation, and emails — just populate KV
  testMode?: boolean; // run full pipeline but only email frogaczewski@gmail.com (skip Polish)
}

async function runPipeline(env: Env, opts: PipelineOptions = {}): Promise<string> {
  console.log('[Pipeline] Starting daily news digest...');

  // Step 1-3: Fetch RSS, weather, and market data in parallel
  console.log('[Pipeline] Step 1-3: Fetching RSS feeds, weather, and market data...');

  let feedResult, weather, markets;
  try {
    [feedResult, weather, markets] = await Promise.all([
      fetchAllFeeds(),
      fetchWeather(),
      fetchMarketData(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] FATAL: Steps 1-3 failed: ${msg}`);
    throw err;
  }

  console.log(`[Pipeline] RSS: ${feedResult.items.length} items from ${feedResult.total - feedResult.failed}/${feedResult.total} feeds`);
  if (feedResult.errors.length > 0) {
    console.log(`[Pipeline] Feed errors: ${feedResult.errors.join('; ')}`);
  }

  if (feedResult.items.length === 0) {
    throw new Error('No RSS items fetched — all feeds failed');
  }

  // Step 4: Haiku triage
  console.log(`[Pipeline] Step 4: Triaging ${feedResult.items.length} items with Haiku...`);
  let triagedStories: TriagedStory[];

  // Cap items to ~200 most recent. 400 was pushing the triage stream past
  // Cloudflare's ~180s subrequest budget; 200 still gives Haiku plenty to
  // pick 60–90 stories from while halving streaming time.
  const sortedItems = [...feedResult.items]
    .sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    })
    .slice(0, 200);
  console.log(`[Pipeline] Using ${sortedItems.length} most recent items for triage`);

  try {
    const triagePrompt = buildTriagePrompt(sortedItems);
    const triageResponse = await callHaiku(env, triagePrompt);
    triagedStories = parseTriageResponse(triageResponse);
    console.log(`[Pipeline] Triage selected ${triagedStories.length} stories`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[Pipeline] Haiku triage failed: ${errMsg}`);
    console.log(`[Pipeline] Falling back to raw items for Sonnet`);
    triagedStories = sortedItems.slice(0, 100).map(item => ({
      headline: item.title,
      summary: item.summary,
      source: item.source,
      link: item.link,
      country_tags: [],
      category_tags: [],
      importance: 'medium' as const,
      duplicate_of: null,
      editorial: item.editorial,
      ...(item.imageUrl && { imageUrl: item.imageUrl }),
    }));
  }

  // Carry over imageUrl from RSS items to triaged stories (Haiku doesn't return it)
  const imagesByLink = new Map<string, string>();
  for (const item of sortedItems) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const story of triagedStories) {
    if (!story.imageUrl && story.link && imagesByLink.has(story.link)) {
      story.imageUrl = imagesByLink.get(story.link);
    }
  }

  // Build story images map for the landing page
  // Key by base URL (no query params) since Sonnet often strips tracking params
  const storyImages: Record<string, string> = {};
  for (const story of triagedStories) {
    if (story.imageUrl && story.link) {
      const baseUrl = story.link.split('?')[0];
      storyImages[baseUrl] = story.imageUrl;
      if (baseUrl !== story.link) storyImages[story.link] = story.imageUrl;
    }
  }
  const imageCount = Object.keys(storyImages).length;
  if (imageCount > 0) {
    console.log(`[Pipeline] Found ${imageCount} story images from RSS feeds`);
  }

  // Dry run: save triaged stories to KV without compilation, then stop
  if (opts.dryRun) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const digestData: DigestData = {
        date: today,
        stories: triagedStories,
        weather,
        markets,
        feedStats: { total: feedResult.total, succeeded: feedResult.total - feedResult.failed },
        storyImages,
      };
      const json = JSON.stringify(digestData);
      await env.DIGEST_KV.put('digest:latest', json);
      await env.DIGEST_KV.put(`digest:${today}`, json);
      console.log(`[Pipeline] Dry run: saved ${triagedStories.length} stories to KV (${json.length} bytes, ${imageCount} images)`);
    } catch (err) {
      console.error(`[Pipeline] KV save failed: ${err}`);
    }
    console.log('[Pipeline] Dry run complete — KV populated, skipping compilation and emails');
    return 'dry-run-success';
  }

  // Step 5a: Sonnet — full digest for website
  console.log('[Pipeline] Step 5a: Compiling full digest with Sonnet...');
  let fullDigest: string;

  const compilationPrompt = buildCompilationPrompt(
    triagedStories,
    weather,
    markets,
    { total: feedResult.total, failed: feedResult.failed },
  );
  fullDigest = await callSonnet(env, compilationPrompt);

  console.log(`[Pipeline] Full digest compiled (${fullDigest.length} characters)`);

  // Steps 5b + 5c: email briefing and headline email. Both depend only on
  // fullDigest, so run them in parallel — saves ~90s wall-clock.
  console.log('[Pipeline] Steps 5b + 5c: Generating email briefing and headline email in parallel...');
  const websiteUrl = 'https://ainewsworker.rogaczewski-dev.workers.dev';
  const todayDate = new Date().toISOString().slice(0, 10);

  const [briefingRaw, headlineRaw] = await Promise.all([
    callSonnet(env, buildEmailBriefingPrompt(fullDigest, websiteUrl)),
    callSonnet(env, buildHeadlineEmailPrompt(fullDigest, websiteUrl)).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Pipeline] Headline email failed, skipping A/B test: ${msg}`);
      return '';
    }),
  ]);

  let emailBriefing = rewriteStoryLinks(briefingRaw, websiteUrl, todayDate);
  console.log(`[Pipeline] Email briefing compiled (${emailBriefing.length} characters)`);

  const headlineEmail = headlineRaw ? rewriteStoryLinks(headlineRaw, websiteUrl, todayDate) : '';
  if (headlineEmail) {
    console.log(`[Pipeline] Headline email compiled (${headlineEmail.length} characters)`);
  }

  // Save everything to KV — full digest + email briefing
  try {
    const today = new Date().toISOString().slice(0, 10);
    const digestData: DigestData = {
      date: today,
      stories: triagedStories,
      weather,
      markets,
      feedStats: { total: feedResult.total, succeeded: feedResult.total - feedResult.failed },
      digestMarkdown: fullDigest,
      emailMarkdown: emailBriefing,
      storyImages,
    };
    const json = JSON.stringify(digestData);
    await Promise.all([
      env.DIGEST_KV.put('digest:latest', json),
      env.DIGEST_KV.put(`digest:${today}`, json),
    ]);

    // Maintain a date index for archive/pagination
    const indexRaw = await env.DIGEST_KV.get('articles:index');
    const dateIndex: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    if (!dateIndex.includes(today)) dateIndex.unshift(today);
    if (dateIndex.length > 90) dateIndex.length = 90; // keep ~3 months
    await env.DIGEST_KV.put('articles:index', JSON.stringify(dateIndex));

    console.log(`[Pipeline] Saved digest to KV (${json.length} bytes), index: ${dateIndex.length} dates`);
  } catch (err) {
    console.error(`[Pipeline] KV save failed (non-fatal): ${err}`);
  }

  // Test mode: send only English emails to Filip, skip Polish
  if (opts.testMode) {
    console.log('[Pipeline] Test mode — sending emails only to Filip...');
    await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false));
    if (headlineEmail) {
      await sendDigestEmail(env, greetedMarkdown(headlineEmail, EMAIL_TO.name, false), undefined, EMAIL_TO, `[NEW] Daily News Digest — ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`);
    }
    console.log('[Pipeline] Test mode complete');
    return 'test-success';
  }

  // Step 6: Translate email briefing to Polish with Sonnet
  console.log('[Pipeline] Step 6: Translating email briefing to Polish...');
  let polishBriefing: string;

  try {
    polishBriefing = await callSonnet(env, buildTranslationPrompt(emailBriefing));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Pipeline] Polish translation failed, falling back to English: ${msg}`);
    polishBriefing = `> **Uwaga:** Automatyczne tłumaczenie było dziś niedostępne. Poniżej wersja angielska.\n\n---\n\n${emailBriefing}`;
  }

  console.log(`[Pipeline] Polish translation: ${polishBriefing.length} characters`);

  // Step 7: Send emails (English + Polish in parallel)
  console.log('[Pipeline] Step 7: Sending emails...');

  const today = new Date();
  const plDateStr = today.toLocaleDateString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const enDateStr = today.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const emailTasks: Promise<void>[] = [
    sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false)).catch(async () => {
      console.log('[Pipeline] English email failed, retrying once...');
      await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false));
    }),
  ];

  // A/B test: send headline-format email only to Filip
  if (headlineEmail) {
    emailTasks.push(
      sendDigestEmail(env, greetedMarkdown(headlineEmail, EMAIL_TO.name, false), undefined, EMAIL_TO, `[NEW] Daily News Digest — ${enDateStr}`).catch((err) => {
        console.log(`[Pipeline] Headline test email failed: ${err}`);
      }),
    );
  }

  if (polishBriefing) {
    for (const plRecipient of EMAIL_TO_PL) {
      emailTasks.push(
        sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, `Codzienny Przegląd Wiadomości — ${plDateStr}`).catch(async () => {
          console.log(`[Pipeline] Polish email to ${plRecipient.email} failed, retrying once...`);
          await sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, `Codzienny Przegląd Wiadomości — ${plDateStr}`);
        }),
      );
    }
  }

  await Promise.all(emailTasks);

  console.log('[Pipeline] Daily digest sent successfully!');
  return 'success';
}

function parseTriageResponse(response: string): TriagedStory[] {
  // Extract JSON array from response (may have markdown code fences)
  let jsonStr = response.trim();

  // Strip markdown code fences if present
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  // Find the JSON array
  const arrayStart = jsonStr.indexOf('[');
  if (arrayStart === -1) {
    throw new Error('No JSON array found in triage response');
  }

  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  } else {
    // Truncated response — try to salvage by finding the last complete object
    jsonStr = jsonStr.slice(arrayStart);
  }

  // Try parsing as-is first
  try {
    const parsed = JSON.parse(jsonStr) as TriagedStory[];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // Truncated JSON — find the last complete object and close the array
    const lastCompleteObj = jsonStr.lastIndexOf('}');
    if (lastCompleteObj === -1) {
      throw new Error('No complete JSON objects found in triage response');
    }

    // Trim to last complete object, remove any trailing comma, close array
    let salvaged = jsonStr.slice(0, lastCompleteObj + 1).trimEnd();
    if (salvaged.endsWith(',')) {
      salvaged = salvaged.slice(0, -1);
    }
    salvaged += ']';

    const parsed = JSON.parse(salvaged) as TriagedStory[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('Triage returned empty result after salvage');
    }
    console.log(`[Pipeline] Salvaged ${parsed.length} stories from truncated JSON`);
    return parsed;
  }

  throw new Error('Triage returned empty or non-array result');
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runPipeline(env).catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Pipeline] Fatal error: ${message}`);
        try {
          await sendErrorEmail(env, message);
        } catch (emailErr) {
          console.error(`[Pipeline] Failed to send error email: ${emailErr}`);
        }
      })
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Manual trigger endpoint (no auth required)
    if (url.pathname === '/run' && request.method === 'POST') {
      // Run synchronously — the response keeps the connection open, giving us
      // the full wall-clock allowance. Streaming LLM calls keep it alive.
      const dryRun = url.searchParams.get('dry') === 'true';
      const testMode = url.searchParams.get('test') === 'true';
      try {
        const result = await runPipeline(env, { dryRun, testMode });
        return new Response(JSON.stringify({ status: 'success', result }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(`[Pipeline] Fatal error: ${message}`);
        console.error(`[Pipeline] Stack: ${stack}`);
        try {
          await sendErrorEmail(env, message);
        } catch (emailErr) {
          console.error(`[Pipeline] Failed to send error email: ${emailErr}`);
        }
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Feed health check endpoint (public, read-only)
    if (url.pathname === '/feeds/health' && request.method === 'GET') {
      try {
        const result = await fetchAllFeeds();
        const working = result.feedStatuses.filter(f => f.ok);
        const failing = result.feedStatuses.filter(f => !f.ok);

        const response = {
          summary: {
            total: result.total,
            working: working.length,
            failing: failing.length,
            totalItems: result.items.length,
          },
          working: working
            .sort((a, b) => b.itemCount - a.itemCount)
            .map(f => ({ name: f.name, items: f.itemCount })),
          failing: failing.map(f => ({ name: f.name, error: f.error })),
        };

        return new Response(JSON.stringify(response, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/test-email' && request.method === 'POST') {
      try {
        await sendDigestEmail(env, '# Test Digest\n\nThis is a test email from the AI News Digest worker.\n\n---\n\n## 🌤️ Weather\n\nSunny in Cyprus, rainy in Gdańsk.\n\n| Day | Conditions | High / Low |\n|---|---|---|\n| Monday | Clear sky | 24°C / 15°C |\n| Tuesday | Partly cloudy | 22°C / 14°C |');
        return new Response(JSON.stringify({ status: 'Test email sent' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // Landing page
    if (url.pathname === '/' && request.method === 'GET') {
      let digestData: DigestData | null = null;
      try {
        const raw = await env.DIGEST_KV.get('digest:latest');
        if (raw) digestData = JSON.parse(raw) as DigestData;
      } catch (err) {
        console.error(`[Landing] KV read failed: ${err}`);
      }

      return new Response(buildLandingPage(digestData), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }

    // Story page: /story/{date}/{slug}
    if (url.pathname.startsWith('/story/') && request.method === 'GET') {
      const parts = url.pathname.split('/');
      const date = parts[2]; // e.g. '2026-04-01'
      const slug = parts[3]; // e.g. 'iran-war-main-briefing'

      if (!date || !slug) {
        return new Response('Not found', { status: 404 });
      }

      let digestData: DigestData | null = null;
      try {
        const raw = await env.DIGEST_KV.get(`digest:${date}`);
        if (raw) digestData = JSON.parse(raw) as DigestData;
      } catch (err) {
        console.error(`[Story] KV read failed: ${err}`);
      }

      if (!digestData?.digestMarkdown) {
        return new Response('Not found', { status: 404 });
      }

      return new Response(buildStoryPage(digestData, slug), {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
