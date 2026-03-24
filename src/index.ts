import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import { callHaiku, callSonnet } from './llm';
import { buildTriagePrompt, buildCompilationPrompt } from './prompts';
import { sendDigestEmail, sendErrorEmail } from './email';
import type { Env, TriagedStory } from './types';

async function runPipeline(env: Env): Promise<void> {
  console.log('[Pipeline] Starting daily news digest...');

  // Step 1-3: Fetch RSS, weather, and market data in parallel
  console.log('[Pipeline] Step 1-3: Fetching RSS feeds, weather, and market data...');
  const [feedResult, weather, markets] = await Promise.all([
    fetchAllFeeds(),
    fetchWeather(),
    fetchMarketData(),
  ]);

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
        country_tags: [],
        category_tags: [],
        importance: 'medium' as const,
        duplicate_of: null,
      }));
    }
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

  // Step 6: Send email
  console.log('[Pipeline] Step 6: Sending email...');
  try {
    await sendDigestEmail(env, digest);
  } catch (err) {
    console.log('[Pipeline] Email failed, retrying once...');
    await sendDigestEmail(env, digest);
  }

  console.log('[Pipeline] Daily digest sent successfully!');
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
      return new Response(JSON.stringify({ status: 'Pipeline started' }), {
        headers: { 'Content-Type': 'application/json' },
      });
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

    return new Response('AI News Digest Worker. POST /run to trigger manually, POST /test-email to test email.', { status: 200 });
  },
};
