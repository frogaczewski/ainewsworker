import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import { callHaiku, callSonnet } from './llm';
import { buildTriagePrompt, buildCompilationPrompt, buildTranslationPrompt } from './prompts';
import { sendDigestEmail, sendErrorEmail } from './email';
import { EMAIL_TO_PL } from './config';
import { buildLandingPage } from './landing';
import type { Env, TriagedStory, FeedStatus, DigestData } from './types';

interface PipelineOptions {
  dryRun?: boolean; // skip compilation, translation, and emails — just populate KV
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

  // Cap items to ~400 most recent to keep within Haiku token limits
  const sortedItems = [...feedResult.items]
    .sort((a, b) => {
      const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
      const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
      return db - da;
    })
    .slice(0, 400);
  console.log(`[Pipeline] Using ${sortedItems.length} most recent items for triage`);

  try {
    const triagePrompt = buildTriagePrompt(sortedItems);
    const triageResponse = await callHaiku(env, triagePrompt);
    triagedStories = parseTriageResponse(triageResponse);
    console.log(`[Pipeline] Triage selected ${triagedStories.length} stories`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[Pipeline] Haiku triage failed: ${errMsg}`);
    console.log(`[Pipeline] Retrying once...`);
    try {
      const triagePrompt = buildTriagePrompt(sortedItems);
      const triageResponse = await callHaiku(env, triagePrompt);
      triagedStories = parseTriageResponse(triageResponse);
      console.log(`[Pipeline] Triage retry selected ${triagedStories.length} stories`);
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.log(`[Pipeline] Haiku retry also failed: ${retryMsg}`);
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
      }));
    }
  }

  // Save triaged stories + weather + markets to KV for the landing page
  try {
    const today = new Date().toISOString().slice(0, 10);
    const digestData: DigestData = {
      date: today,
      stories: triagedStories,
      weather,
      markets,
      feedStats: { total: feedResult.total, succeeded: feedResult.total - feedResult.failed },
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

    console.log(`[Pipeline] Saved ${triagedStories.length} stories to KV (${json.length} bytes), index: ${dateIndex.length} dates`);
  } catch (err) {
    console.error(`[Pipeline] KV save failed (non-fatal): ${err}`);
  }

  // Dry run: stop after KV population, skip compilation + emails
  if (opts.dryRun) {
    console.log('[Pipeline] Dry run complete — KV populated, skipping compilation and emails');
    return 'dry-run-success';
  }

  // Step 5: Sonnet compilation
  console.log('[Pipeline] Step 5: Compiling digest with Sonnet...');
  let digest: string;

  try {
    const compilationPrompt = buildCompilationPrompt(
      triagedStories,
      weather,
      markets,
      { total: feedResult.total, failed: feedResult.failed },
    );
    digest = await callSonnet(env, compilationPrompt);
  } catch (err) {
    console.log('[Pipeline] Sonnet compilation failed, retrying once...');
    const compilationPrompt = buildCompilationPrompt(
      triagedStories,
      weather,
      markets,
      { total: feedResult.total, failed: feedResult.failed },
    );
    digest = await callSonnet(env, compilationPrompt);
  }

  console.log(`[Pipeline] Digest compiled (${digest.length} characters)`);

  // Step 6: Translate to Polish with Sonnet
  console.log('[Pipeline] Step 6: Translating digest to Polish with Sonnet...');
  let polishDigest: string;

  try {
    const translationPrompt = buildTranslationPrompt(digest);
    polishDigest = await callSonnet(env, translationPrompt);
  } catch (err) {
    console.log('[Pipeline] Polish translation failed, retrying once...');
    try {
      const translationPrompt = buildTranslationPrompt(digest);
      polishDigest = await callSonnet(env, translationPrompt);
    } catch (retryErr) {
      const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.log(`[Pipeline] Polish translation retry also failed: ${retryMsg}`);
      polishDigest = ''; // Skip Polish email if translation fails
    }
  }

  console.log(`[Pipeline] Polish translation: ${polishDigest.length} characters`);

  // Step 7: Send emails (English + Polish in parallel)
  console.log('[Pipeline] Step 7: Sending emails...');

  const today = new Date();
  const plDateStr = today.toLocaleDateString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const emailTasks: Promise<void>[] = [
    sendDigestEmail(env, digest, feedResult.feedStatuses).catch(async () => {
      console.log('[Pipeline] English email failed, retrying once...');
      await sendDigestEmail(env, digest, feedResult.feedStatuses);
    }),
  ];

  if (polishDigest) {
    emailTasks.push(
      sendDigestEmail(env, polishDigest, feedResult.feedStatuses, EMAIL_TO_PL, `Codzienny Przegląd Wiadomości — ${plDateStr}`).catch(async () => {
        console.log('[Pipeline] Polish email failed, retrying once...');
        await sendDigestEmail(env, polishDigest, feedResult.feedStatuses, EMAIL_TO_PL, `Codzienny Przegląd Wiadomości — ${plDateStr}`);
      }),
    );
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

    // Manual trigger endpoint
    if (url.pathname === '/run' && request.method === 'POST') {
      // Simple auth: require ?token=<TRIGGER_TOKEN> or Authorization header
      const token = url.searchParams.get('token') || request.headers.get('Authorization')?.replace('Bearer ', '');
      if (env.TRIGGER_TOKEN && token !== env.TRIGGER_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Run synchronously — the response keeps the connection open, giving us
      // the full wall-clock allowance. Streaming LLM calls keep it alive.
      const dryRun = url.searchParams.get('dry') === 'true';
      try {
        const result = await runPipeline(env, { dryRun });
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

    return new Response('Not found', { status: 404 });
  },
};
