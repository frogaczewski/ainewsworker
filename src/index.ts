import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import { callSonnet } from './llm';
import { buildTriagePrompt, buildCompilationPrompt, buildSectionedCompilationPrompt, buildEmailBriefingPrompt, buildHeadlineEmailPrompt, buildTranslationPrompt } from './prompts';
import { classifyInBatches, urlDedupAndDropLow, semanticDedup, selectForDigest, selectedToFlat } from './classify';
import { sendDigestEmail, sendErrorEmail } from './email';
import { EMAIL_TO, EMAIL_TO_PL } from './config';
import { buildLandingPage, buildStoryPage, generateSlug } from './landing';
import type { Env, TriagedStory, FeedStatus, DigestData, SelectedDigestInput, ClassifiedItem } from './types';

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
  dryRun?: boolean;        // skip compilation, translation, and emails — just populate KV
  testMode?: boolean;      // run full pipeline but only email frogaczewski@gmail.com (skip Polish)
  classifyOnly?: boolean;  // batched path only: run Stages 1-3, write classified:{date}, stop
  selectOnly?: boolean;    // batched path only: run Stages 1-4, write selected:{date}, stop
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

  // Step 4: triage — feature-flagged between the legacy Sonnet single-call path
  // and the new batched Haiku pipeline.
  const useBatched = env.USE_BATCHED_CLASSIFICATION === 'true';
  const runDate = new Date().toISOString().slice(0, 10);
  let triagedStories: TriagedStory[];
  let selectedInput: SelectedDigestInput | null = null;
  const sortedItems = [...feedResult.items].sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  if (useBatched) {
    console.log(`[Pipeline] Step 4 (batched): classifying ${sortedItems.length} items with Haiku...`);

    // Stage 2: batched Haiku classification (each batch writes to KV for resumption)
    const classified = await classifyInBatches(env, sortedItems, runDate);
    console.log(`[Pipeline] Classified ${classified.length}/${sortedItems.length} items`);

    if (classified.length === 0) {
      throw new Error('Batched classification returned 0 items — every batch failed');
    }

    // Stage 3a: URL dedup + drop low importance
    const urlDeduped = urlDedupAndDropLow(classified);

    // Stage 3b: semantic dedup (one Haiku call over survivors)
    const fullyDeduped = await semanticDedup(env, urlDeduped);

    // Persist the deduplicated pool for auditability. 7-day TTL — enough to
    // inspect "why did story X not make today's digest?" for a reasonable window.
    try {
      await env.DIGEST_KV.put(`classified:${runDate}`, JSON.stringify(fullyDeduped), { expirationTtl: 604_800 });
    } catch (err) {
      console.log(`[Pipeline] KV write classified:${runDate} failed (non-fatal): ${err}`);
    }

    // classifyOnly dry run: stop here so we can inspect the classified pool
    if (opts.classifyOnly) {
      console.log(`[Pipeline] classifyOnly mode — wrote classified:${runDate} (${fullyDeduped.length} items), stopping`);
      return `classify-only-success:${fullyDeduped.length}`;
    }

    // Stage 4: balance-aware selection (deterministic, no LLM)
    selectedInput = selectForDigest(fullyDeduped);
    console.log(
      `[Pipeline] Selection: ${selectedInput.sections.length} sections, ` +
      `${selectedInput.sections.reduce((n, s) => n + s.stories.length, 0)} stories, ` +
      `${selectedInput.dropped?.length ?? 0} dropped, ${selectedInput.gaps?.length ?? 0} gaps`
    );

    try {
      await env.DIGEST_KV.put(`selected:${runDate}`, JSON.stringify(selectedInput), { expirationTtl: 604_800 });
    } catch (err) {
      console.log(`[Pipeline] KV write selected:${runDate} failed (non-fatal): ${err}`);
    }

    if (opts.selectOnly) {
      console.log(`[Pipeline] selectOnly mode — wrote selected:${runDate}, stopping`);
      return 'select-only-success';
    }

    triagedStories = selectedToFlat(selectedInput);
  } else {
    // Legacy path — retained behind feature flag so we can roll back instantly
    // if the batched pipeline regresses. Delete this branch once the new path
    // has been stable in production for ~1 week.
    const cappedItems = sortedItems.slice(0, 200);
    console.log(`[Pipeline] Step 4 (legacy): triaging ${cappedItems.length}/${sortedItems.length} items with Sonnet...`);

    try {
      const triagePrompt = buildTriagePrompt(cappedItems);
      const triageResponse = await callSonnet(env, triagePrompt);
      triagedStories = parseTriageResponse(triageResponse);
      console.log(`[Pipeline] Triage selected ${triagedStories.length} stories`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[Pipeline] Sonnet triage failed: ${errMsg}`);
      console.log(`[Pipeline] Falling back to raw items`);
      triagedStories = cappedItems.slice(0, 100).map(item => ({
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
  }

  // Carry over imageUrl from RSS items to triaged stories (triage prompts don't ask for it)
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

  const compilationPrompt = selectedInput
    ? buildSectionedCompilationPrompt(selectedInput, weather, markets, { total: feedResult.total, failed: feedResult.failed })
    : buildCompilationPrompt(triagedStories, weather, markets, { total: feedResult.total, failed: feedResult.failed });
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

  // Step 6: Kick off Polish translation but DO NOT block English sends on it.
  // The 03:00 cron on 2026-04-21 reached this point with only ~4 min left of the
  // 15-min wall budget; translation stalled and the worker was killed before any
  // email shipped. Running translation in parallel with English send means a
  // hung/slow translation can no longer take down the whole digest.
  console.log('[Pipeline] Step 6: Translating email briefing to Polish (parallel with English send)...');
  const polishBriefingPromise = callSonnet(env, buildTranslationPrompt(emailBriefing))
    .then((translated) => {
      console.log(`[Pipeline] Polish translation: ${translated.length} characters`);
      return translated;
    })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Pipeline] Polish translation failed, falling back to English: ${msg}`);
      return `> **Uwaga:** Automatyczne tłumaczenie było dziś niedostępne. Poniżej wersja angielska.\n\n---\n\n${emailBriefing}`;
    });

  // Step 7: Send emails.
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

  // 7a: English sends go out immediately — they don't need the translation.
  const englishTasks: Promise<void>[] = [
    sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false)).catch(async () => {
      console.log('[Pipeline] English email failed, retrying once...');
      await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false));
    }),
  ];

  // A/B test: send headline-format email only to Filip
  if (headlineEmail) {
    englishTasks.push(
      sendDigestEmail(env, greetedMarkdown(headlineEmail, EMAIL_TO.name, false), undefined, EMAIL_TO, `[NEW] Daily News Digest — ${enDateStr}`).catch((err) => {
        console.log(`[Pipeline] Headline test email failed: ${err}`);
      }),
    );
  }

  await Promise.all(englishTasks);
  console.log('[Pipeline] English emails dispatched');

  // 7b: Await the Polish translation (already in-flight) and send to PL recipients.
  const polishBriefing = await polishBriefingPromise;
  const polishTasks: Promise<void>[] = [];
  if (polishBriefing) {
    for (const plRecipient of EMAIL_TO_PL) {
      polishTasks.push(
        sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, `Codzienny Przegląd Wiadomości — ${plDateStr}`).catch(async () => {
          console.log(`[Pipeline] Polish email to ${plRecipient.email} failed, retrying once...`);
          await sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, `Codzienny Przegląd Wiadomości — ${plDateStr}`);
        }),
      );
    }
  }

  await Promise.all(polishTasks);

  // Heartbeat: tells the 03:30 retry cron that today's primary run completed.
  // Written only after all emails resolved so a partial failure won't suppress the retry.
  const heartbeatDate = new Date().toISOString().slice(0, 10);
  try {
    await env.DIGEST_KV.put('digest:lastSuccess', heartbeatDate);
  } catch (err) {
    console.error(`[Pipeline] Heartbeat write failed (non-fatal): ${err}`);
  }

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

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  // 03:30 UTC: only re-run if today's primary didn't write a heartbeat.
  // No immediate alarm on the primary failure — we wait until retry also fails
  // before paging, otherwise every transient blip generates noise.
  if (event.cron === '30 3 * * *') {
    const lastSuccess = await env.DIGEST_KV.get('digest:lastSuccess');
    if (lastSuccess === today) {
      console.log(`[Retry] Heartbeat ${lastSuccess} matches today — primary succeeded, skipping retry`);
      return;
    }
    console.log(`[Retry] Heartbeat is "${lastSuccess ?? 'missing'}" — retrying pipeline...`);
    try {
      await runPipeline(env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Retry] Retry pipeline failed: ${message}`);
      try {
        await sendErrorEmail(env, `Both 03:00 and 03:30 UTC runs failed today (${today}).\n\nLatest error: ${message}`);
      } catch (emailErr) {
        console.error(`[Retry] Failed to send alarm email: ${emailErr}`);
      }
    }
    return;
  }

  // Primary 03:00 path. Stay silent on failure — the 03:30 retry will alarm if both fail.
  try {
    await runPipeline(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Primary run failed (will retry at 03:30): ${message}`);
  }
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Manual trigger endpoint (no auth required)
    if (url.pathname === '/run' && request.method === 'POST') {
      // Run synchronously — the response keeps the connection open, giving us
      // the full wall-clock allowance. Streaming LLM calls keep it alive.
      const dryRun = url.searchParams.get('dry') === 'true';
      const testMode = url.searchParams.get('test') === 'true';
      const classifyOnly = url.searchParams.get('classifyOnly') === 'true';
      const selectOnly = url.searchParams.get('selectOnly') === 'true';
      try {
        const result = await runPipeline(env, { dryRun, testMode, classifyOnly, selectOnly });
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
