import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import { callSonnet } from './llm';
import {
  buildSectionedCompilationPrompt,
  buildEmailBriefingPrompt,
  buildTranslationPrompt,
} from './prompts';
import {
  classifyInBatches,
  urlDedupAndDropLow,
  semanticDedup,
  selectForDigest,
  selectedToFlat,
} from './classify';
import { sendDigestEmail, sendErrorEmail } from './email';
import { EMAIL_TO, EMAIL_TO_PL } from './config';
import { buildLandingPage, buildStoryPage, generateSlug } from './landing';
import type { Env, DigestData, Phase1Output, QueueMessage } from './types';

const WEBSITE_URL = 'https://ainewsworker.rogaczewski-dev.workers.dev';
const PHASE1_TTL_SECONDS = 604_800; // 7 days

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

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
    const headerMatch = lines[i].match(/^#{2,3}\s+(.+)/);
    if (headerMatch) {
      lastHeaderSlug = generateSlug(headerMatch[1]);
    }

    if (lastHeaderSlug && (lines[i].includes(`](${websiteUrl})`) || lines[i].includes(`](${baseUrl})`))) {
      const storyUrl = `${baseUrl}/story/${date}/${lastHeaderSlug}`;
      lines[i] = lines[i]
        .replace(`](${websiteUrl})`, `](${storyUrl})`)
        .replace(`](${baseUrl})`, `](${storyUrl})`);
    }
  }

  return lines.join('\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 1: data collection (RSS → classify → dedup → select).
// Writes phase1:{date} and selected:{date} to KV. Cheap to re-run.
// ──────────────────────────────────────────────────────────────────────────────

interface Phase1Options {
  classifyOnly?: boolean;
  selectOnly?: boolean;
}

async function runPhase1(env: Env, opts: Phase1Options = {}): Promise<Phase1Output | null> {
  console.log('[Phase1] Starting data collection...');

  const runDate = todayUtc();

  // Steps 1-3: fetch RSS, weather, markets in parallel.
  let feedResult, weather, markets;
  try {
    [feedResult, weather, markets] = await Promise.all([
      fetchAllFeeds(),
      fetchWeather(),
      fetchMarketData(),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Phase1] FATAL: Steps 1-3 failed: ${msg}`);
    throw err;
  }

  console.log(`[Phase1] RSS: ${feedResult.items.length} items from ${feedResult.total - feedResult.failed}/${feedResult.total} feeds`);
  if (feedResult.errors.length > 0) {
    console.log(`[Phase1] Feed errors: ${feedResult.errors.join('; ')}`);
  }
  if (feedResult.items.length === 0) {
    throw new Error('No RSS items fetched — all feeds failed');
  }

  const sortedItems = [...feedResult.items].sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  // Step 4: batched Haiku classification (each batch checkpoints to KV).
  // The legacy Sonnet path has been removed — see commit history if you need it back.
  console.log(`[Phase1] Step 4 (batched): classifying ${sortedItems.length} items with Haiku...`);
  const classified = await classifyInBatches(env, sortedItems, runDate);
  console.log(`[Phase1] Classified ${classified.length}/${sortedItems.length} items`);
  if (classified.length === 0) {
    throw new Error('Batched classification returned 0 items — every batch failed');
  }

  // Stage 3a: URL dedup + drop low importance
  const urlDeduped = urlDedupAndDropLow(classified);

  // Stage 3b: semantic dedup
  const fullyDeduped = await semanticDedup(env, urlDeduped);

  try {
    await env.DIGEST_KV.put(`classified:${runDate}`, JSON.stringify(fullyDeduped), {
      expirationTtl: PHASE1_TTL_SECONDS,
    });
  } catch (err) {
    console.log(`[Phase1] KV write classified:${runDate} failed (non-fatal): ${err}`);
  }

  if (opts.classifyOnly) {
    console.log(`[Phase1] classifyOnly mode — wrote classified:${runDate} (${fullyDeduped.length} items), stopping`);
    return null;
  }

  // Stage 4: balance-aware selection (deterministic, no LLM)
  const selectedInput = selectForDigest(fullyDeduped);
  console.log(
    `[Phase1] Selection: ${selectedInput.sections.length} sections, ` +
      `${selectedInput.sections.reduce((n, s) => n + s.stories.length, 0)} stories, ` +
      `${selectedInput.dropped?.length ?? 0} dropped, ${selectedInput.gaps?.length ?? 0} gaps`,
  );

  try {
    await env.DIGEST_KV.put(`selected:${runDate}`, JSON.stringify(selectedInput), {
      expirationTtl: PHASE1_TTL_SECONDS,
    });
  } catch (err) {
    console.log(`[Phase1] KV write selected:${runDate} failed (non-fatal): ${err}`);
  }

  const triagedStories = selectedToFlat(selectedInput);

  // Carry over imageUrl from RSS items (classification prompt doesn't ask for it).
  const imagesByLink = new Map<string, string>();
  for (const item of sortedItems) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const story of triagedStories) {
    if (!story.imageUrl && story.link && imagesByLink.has(story.link)) {
      story.imageUrl = imagesByLink.get(story.link);
    }
  }

  // Build a base-URL keyed map for the landing page (Sonnet often strips query params).
  const storyImages: Record<string, string> = {};
  for (const story of triagedStories) {
    if (story.imageUrl && story.link) {
      const baseUrl = story.link.split('?')[0];
      storyImages[baseUrl] = story.imageUrl;
      if (baseUrl !== story.link) storyImages[story.link] = story.imageUrl;
    }
  }
  if (Object.keys(storyImages).length > 0) {
    console.log(`[Phase1] Found ${Object.keys(storyImages).length} story images from RSS feeds`);
  }

  const phase1: Phase1Output = {
    date: runDate,
    selectedInput,
    triagedStories,
    weather,
    markets,
    feedStats: {
      total: feedResult.total,
      failed: feedResult.failed,
      succeeded: feedResult.total - feedResult.failed,
    },
    storyImages,
  };

  try {
    await env.DIGEST_KV.put(`phase1:${runDate}`, JSON.stringify(phase1), {
      expirationTtl: PHASE1_TTL_SECONDS,
    });
    await env.DIGEST_KV.put('digest:phase1Success', runDate);
  } catch (err) {
    console.error(`[Phase1] KV write phase1:${runDate} failed: ${err}`);
    throw err;
  }

  if (opts.selectOnly) {
    console.log(`[Phase1] selectOnly mode — wrote selected:${runDate}, stopping`);
    return phase1;
  }

  console.log(`[Phase1] Complete — phase1:${runDate} written`);
  return phase1;
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 2: compile + send (Sonnet compilation, email briefing, translation,
// dispatch). Reads phase1:{date} from KV, persists partial state at every
// milestone so a retry never re-does completed work.
// ──────────────────────────────────────────────────────────────────────────────

interface Phase2Options {
  testMode?: boolean;
}

async function runPhase2(env: Env, date: string, opts: Phase2Options = {}): Promise<string> {
  console.log(`[Phase2] Starting compile+send for ${date} (testMode=${!!opts.testMode})`);

  const raw = await env.DIGEST_KV.get(`phase1:${date}`);
  if (!raw) {
    throw new Error(`[Phase2] No phase1:${date} in KV — Phase 1 didn't complete`);
  }
  const phase1: Phase1Output = JSON.parse(raw);

  // ── Step 5a: compile full digest with Sonnet ───────────────────────────────
  let fullDigest = await readCachedDigestField(env, date, 'digestMarkdown');
  if (fullDigest) {
    console.log(`[Phase2] Reusing cached digestMarkdown (${fullDigest.length} chars)`);
  } else {
    console.log('[Phase2] Step 5a: Compiling full digest with Sonnet...');
    const compilationPrompt = buildSectionedCompilationPrompt(
      phase1.selectedInput,
      phase1.weather,
      phase1.markets,
      { total: phase1.feedStats.total, failed: phase1.feedStats.failed },
    );
    fullDigest = await callSonnet(env, compilationPrompt);
    console.log(`[Phase2] Full digest compiled (${fullDigest.length} characters)`);

    // Persist immediately so a Step 5b failure doesn't force us to recompile.
    await persistDigest(env, phase1, { digestMarkdown: fullDigest });
  }

  // ── Step 5b: email briefing ────────────────────────────────────────────────
  let emailBriefing = await readCachedDigestField(env, date, 'emailMarkdown');
  if (emailBriefing) {
    console.log(`[Phase2] Reusing cached emailMarkdown (${emailBriefing.length} chars)`);
  } else {
    console.log('[Phase2] Step 5b: Generating email briefing...');
    const briefingRaw = await callSonnet(env, buildEmailBriefingPrompt(fullDigest, WEBSITE_URL));
    emailBriefing = rewriteStoryLinks(briefingRaw, WEBSITE_URL, date);
    console.log(`[Phase2] Email briefing compiled (${emailBriefing.length} characters)`);

    await persistDigest(env, phase1, { digestMarkdown: fullDigest, emailMarkdown: emailBriefing });
  }

  // ── Step 6 + 7: translate (parallel) and send ──────────────────────────────
  await sendAllEmails(env, emailBriefing, opts);

  // Heartbeat: only after every recipient resolved. The 03:30 retry uses this
  // to decide whether to re-enqueue.
  try {
    await env.DIGEST_KV.put('digest:lastSuccess', date);
  } catch (err) {
    console.error(`[Phase2] Heartbeat write failed (non-fatal): ${err}`);
  }

  console.log(`[Phase2] Complete for ${date}`);
  return 'success';
}

// Pull a single field out of digest:{date} without forcing the caller to JSON-parse.
async function readCachedDigestField<K extends keyof DigestData>(
  env: Env,
  date: string,
  field: K,
): Promise<DigestData[K] | undefined> {
  try {
    const raw = await env.DIGEST_KV.get(`digest:${date}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as DigestData;
    return parsed[field];
  } catch (err) {
    console.log(`[Phase2] Failed to read cached digest field ${String(field)}: ${err}`);
    return undefined;
  }
}

// Write digest:{date} + digest:latest, optionally with digestMarkdown / emailMarkdown.
async function persistDigest(
  env: Env,
  phase1: Phase1Output,
  partial: { digestMarkdown?: string; emailMarkdown?: string },
): Promise<void> {
  const data: DigestData = {
    date: phase1.date,
    stories: phase1.triagedStories,
    weather: phase1.weather,
    markets: phase1.markets,
    feedStats: {
      total: phase1.feedStats.total,
      succeeded: phase1.feedStats.succeeded,
    },
    storyImages: phase1.storyImages,
    ...(partial.digestMarkdown ? { digestMarkdown: partial.digestMarkdown } : {}),
    ...(partial.emailMarkdown ? { emailMarkdown: partial.emailMarkdown } : {}),
  };

  const json = JSON.stringify(data);
  try {
    await Promise.all([
      env.DIGEST_KV.put('digest:latest', json),
      env.DIGEST_KV.put(`digest:${phase1.date}`, json),
    ]);

    const indexRaw = await env.DIGEST_KV.get('articles:index');
    const dateIndex: string[] = indexRaw ? JSON.parse(indexRaw) : [];
    if (!dateIndex.includes(phase1.date)) dateIndex.unshift(phase1.date);
    if (dateIndex.length > 90) dateIndex.length = 90;
    await env.DIGEST_KV.put('articles:index', JSON.stringify(dateIndex));

    console.log(`[Phase2] Persisted digest (${json.length} bytes)${partial.emailMarkdown ? ' + email' : ''}`);
  } catch (err) {
    console.error(`[Phase2] persistDigest failed (non-fatal): ${err}`);
  }
}

interface SendOptions {
  testMode?: boolean;
  onlyTo?: { email: string; name: string };
}

// Translate to Polish (in parallel with the English send) and dispatch the
// English digest + every Polish recipient. Used by both the cron path
// (via runPhase2) and the manual /resend endpoint.
async function sendAllEmails(env: Env, emailBriefing: string, opts: SendOptions = {}): Promise<void> {
  const today = new Date();
  const plDateStr = today.toLocaleDateString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const plSubject = `Codzienny Przegląd Wiadomości — ${plDateStr}`;

  // Onlt-one-recipient override: send a single message in whichever language
  // matches the recipient list. English by default unless they're in EMAIL_TO_PL.
  if (opts.onlyTo) {
    const isPl = EMAIL_TO_PL.some(r => r.email.toLowerCase() === opts.onlyTo!.email.toLowerCase());
    if (isPl) {
      const polish = await translateToPolish(env, emailBriefing);
      await sendDigestEmail(env, greetedMarkdown(polish, opts.onlyTo.name, true), undefined, opts.onlyTo, plSubject);
    } else {
      await sendDigestEmail(env, greetedMarkdown(emailBriefing, opts.onlyTo.name, false), undefined, opts.onlyTo);
    }
    console.log(`[Email] Sent to single recipient ${opts.onlyTo.email}`);
    return;
  }

  // Kick off Polish translation in parallel — English send doesn't wait on it.
  const polishBriefingPromise = translateToPolish(env, emailBriefing);

  if (opts.testMode) {
    console.log('[Email] Test mode — sending only to Filip');
    await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false));
    // Drain the translation so it doesn't dangle if waitUntil isn't holding it.
    await polishBriefingPromise.catch(() => undefined);
    return;
  }

  await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false)).catch(async () => {
    console.log('[Email] English send failed, retrying once...');
    await sendDigestEmail(env, greetedMarkdown(emailBriefing, EMAIL_TO.name, false));
  });
  console.log('[Email] English email dispatched');

  const polishBriefing = await polishBriefingPromise;
  if (!polishBriefing) {
    console.log('[Email] No Polish briefing — skipping PL recipients');
    return;
  }

  const tasks: Promise<void>[] = [];
  for (const plRecipient of EMAIL_TO_PL) {
    tasks.push(
      sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, plSubject)
        .catch(async () => {
          console.log(`[Email] Polish to ${plRecipient.email} failed, retrying once...`);
          await sendDigestEmail(env, greetedMarkdown(polishBriefing, plRecipient.name, true), undefined, plRecipient, plSubject);
        }),
    );
  }
  await Promise.all(tasks);
  console.log(`[Email] All Polish emails dispatched (${EMAIL_TO_PL.length} recipients)`);
}

async function translateToPolish(env: Env, emailBriefing: string): Promise<string> {
  try {
    const translated = await callSonnet(env, buildTranslationPrompt(emailBriefing));
    console.log(`[Email] Polish translation: ${translated.length} characters`);
    return translated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Email] Polish translation failed, falling back to English: ${msg}`);
    return `> **Uwaga:** Automatyczne tłumaczenie było dziś niedostępne. Poniżej wersja angielska.\n\n---\n\n${emailBriefing}`;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Dry-run path (no compile, no send) — preserved for ad-hoc debugging.
// ──────────────────────────────────────────────────────────────────────────────

async function runDryRun(env: Env): Promise<string> {
  const phase1 = await runPhase1(env);
  if (!phase1) return 'dry-run-stopped-early';
  await persistDigest(env, phase1, {});
  console.log('[DryRun] Saved triaged stories to KV without compiling or sending');
  return 'dry-run-success';
}

// ──────────────────────────────────────────────────────────────────────────────
// Scheduled (cron) handler.
// ──────────────────────────────────────────────────────────────────────────────

async function handleScheduled(event: ScheduledEvent, env: Env): Promise<void> {
  const today = todayUtc();

  if (event.cron === '30 3 * * *') {
    // Retry path. Look at what already succeeded today and re-trigger only
    // the missing phase rather than redoing everything.
    const lastSuccess = await env.DIGEST_KV.get('digest:lastSuccess');
    if (lastSuccess === today) {
      console.log(`[Retry] Heartbeat ${lastSuccess} matches today — already succeeded, skipping`);
      return;
    }

    const phase1Success = await env.DIGEST_KV.get('digest:phase1Success');
    if (phase1Success === today) {
      console.log('[Retry] Phase 1 already done — re-enqueueing Phase 2');
      try {
        await env.DIGEST_QUEUE.send({ kind: 'compile-and-send', date: today });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Retry] Failed to enqueue Phase 2: ${msg}`);
        await sendErrorEmail(env, `Phase 1 succeeded but enqueueing Phase 2 retry failed: ${msg}`).catch(() => undefined);
      }
      return;
    }

    console.log('[Retry] Re-running Phase 1...');
    try {
      await runPhase1(env);
      await env.DIGEST_QUEUE.send({ kind: 'compile-and-send', date: today });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Retry] Phase 1 retry failed: ${msg}`);
      await sendErrorEmail(env, `Both 03:00 and 03:30 UTC Phase-1 runs failed today (${today}).\n\n${msg}`).catch(() => undefined);
    }
    return;
  }

  // Primary 03:00 path. Stay silent on failure — the 03:30 retry will alarm if both fail.
  try {
    await runPhase1(env);
    await env.DIGEST_QUEUE.send({ kind: 'compile-and-send', date: today });
    console.log('[Pipeline] Phase 1 complete; Phase 2 enqueued');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Pipeline] Primary Phase 1 failed (will retry at 03:30): ${msg}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Queue handler — drives Phase 2 and the manual /resend flow. The DLQ
// consumer is the same handler, switched on `batch.queue`.
// ──────────────────────────────────────────────────────────────────────────────

async function handleQueue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  if (batch.queue === 'ainewsworker-digest-dlq') {
    for (const msg of batch.messages) {
      console.error(`[DLQ] Message exhausted retries: ${JSON.stringify(msg.body)}`);
      try {
        const body = msg.body as Partial<{ kind: string; date: string }>;
        await sendErrorEmail(
          env,
          `A queued job exhausted its retries and landed in the DLQ.\n\n` +
            `kind: ${body.kind ?? 'unknown'}\n` +
            `date: ${body.date ?? 'unknown'}\n\n` +
            `Manual intervention needed — inspect KV for partial state and consider POST /resend.`,
        );
      } catch (err) {
        console.error(`[DLQ] Alarm email failed: ${err}`);
      }
      msg.ack();
    }
    return;
  }

  for (const msg of batch.messages) {
    const body = msg.body;
    try {
      if (body.kind === 'compile-and-send') {
        console.log(`[Queue] compile-and-send for ${body.date} (testMode=${!!body.testMode})`);
        await runPhase2(env, body.date, { testMode: body.testMode });
        msg.ack();
      } else if (body.kind === 'resend') {
        console.log(`[Queue] resend for ${body.date} (testMode=${!!body.testMode}, onlyTo=${body.onlyTo?.email ?? 'all'})`);
        const cached = await env.DIGEST_KV.get(`digest:${body.date}`);
        if (!cached) throw new Error(`No digest:${body.date} in KV`);
        const data = JSON.parse(cached) as DigestData;
        if (!data.emailMarkdown) throw new Error(`digest:${body.date} has no emailMarkdown`);
        await sendAllEmails(env, data.emailMarkdown, {
          testMode: body.testMode,
          onlyTo: body.onlyTo,
        });
        msg.ack();
      } else {
        // Unknown kind — ack so we don't burn retries on a bad message.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        console.error(`[Queue] Unknown message kind: ${(body as any).kind}`);
        msg.ack();
      }
    } catch (err) {
      const msgText = err instanceof Error ? err.message : String(err);
      console.error(`[Queue] Handler failed for ${body.kind}/${(body as { date?: string }).date ?? '?'}: ${msgText}`);
      msg.retry({ delaySeconds: 60 });
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP handler.
// ──────────────────────────────────────────────────────────────────────────────

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleQueue(batch, env);
  },

  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // POST /run — full production flow. Runs Phase 1 synchronously (so the
    // caller sees errors), then enqueues Phase 2 for the queue consumer.
    // Query params:
    //   ?dry=true          → save triaged stories to KV, no compile, no send.
    //   ?test=true         → run BOTH phases sync, emails only to Filip.
    //   ?classifyOnly=true → Phase 1 stops after classification.
    //   ?selectOnly=true   → Phase 1 stops after selection.
    if (url.pathname === '/run' && request.method === 'POST') {
      const dryRun = url.searchParams.get('dry') === 'true';
      const testMode = url.searchParams.get('test') === 'true';
      const classifyOnly = url.searchParams.get('classifyOnly') === 'true';
      const selectOnly = url.searchParams.get('selectOnly') === 'true';

      try {
        if (dryRun) {
          const result = await runDryRun(env);
          return new Response(JSON.stringify({ status: 'success', result }), { headers: JSON_HEADERS });
        }

        if (classifyOnly || selectOnly) {
          const result = await runPhase1(env, { classifyOnly, selectOnly });
          return new Response(
            JSON.stringify({
              status: 'success',
              phase: 'phase1',
              result: result ? `phase1-complete:${result.triagedStories.length}` : 'classify-only',
            }),
            { headers: JSON_HEADERS },
          );
        }

        if (testMode) {
          // Sync end-to-end so the caller sees every step.
          const phase1 = await runPhase1(env);
          if (!phase1) throw new Error('Phase 1 returned null in test mode');
          const result = await runPhase2(env, phase1.date, { testMode: true });
          return new Response(JSON.stringify({ status: 'success', result }), { headers: JSON_HEADERS });
        }

        // Default: Phase 1 sync, Phase 2 queued.
        const phase1 = await runPhase1(env);
        if (!phase1) throw new Error('Phase 1 returned null');
        await env.DIGEST_QUEUE.send({ kind: 'compile-and-send', date: phase1.date });
        return new Response(
          JSON.stringify({
            status: 'success',
            phase1: `phase1-complete:${phase1.triagedStories.length}`,
            phase2: 'enqueued',
          }),
          { headers: JSON_HEADERS },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(`[Pipeline] Fatal error: ${message}`);
        if (stack) console.error(`[Pipeline] Stack: ${stack}`);
        try {
          await sendErrorEmail(env, message);
        } catch (emailErr) {
          console.error(`[Pipeline] Failed to send error email: ${emailErr}`);
        }
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

    // POST /run-phase-2 — manually trigger Phase 2 only (uses today's KV state
    // by default). Useful when Phase 1 already wrote phase1:{date} but Phase 2
    // never ran or got stuck before the queue could pick it up.
    //   ?date=YYYY-MM-DD   → use a specific date's phase1 output.
    //   ?test=true         → email only Filip.
    //   ?sync=true         → run inline (returns when emails sent); else queued.
    if (url.pathname === '/run-phase-2' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      const testMode = url.searchParams.get('test') === 'true';
      const sync = url.searchParams.get('sync') === 'true';

      try {
        if (sync) {
          const result = await runPhase2(env, date, { testMode });
          return new Response(JSON.stringify({ status: 'success', date, result }), { headers: JSON_HEADERS });
        }
        await env.DIGEST_QUEUE.send({ kind: 'compile-and-send', date, testMode });
        return new Response(JSON.stringify({ status: 'enqueued', date, testMode }), { headers: JSON_HEADERS });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

    // POST /resend — re-send the cached email briefing to all recipients (or
    // a subset). Doesn't recompute anything; reads digest:{date}.emailMarkdown.
    //   ?date=YYYY-MM-DD      → which day's digest to resend (default: today).
    //   ?test=true            → only Filip.
    //   ?to=email@example.com → only this recipient (looks up name in config if known).
    //   ?sync=true            → send inline; else queued (default).
    if (url.pathname === '/resend' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      const testMode = url.searchParams.get('test') === 'true';
      const toEmail = url.searchParams.get('to');
      const sync = url.searchParams.get('sync') === 'true';

      try {
        // Existence check before enqueueing — we want a 404 here, not a DLQ.
        const cached = await env.DIGEST_KV.get(`digest:${date}`);
        if (!cached) {
          return new Response(JSON.stringify({ status: 'not-found', error: `No digest for ${date}` }), {
            status: 404,
            headers: JSON_HEADERS,
          });
        }
        const data = JSON.parse(cached) as DigestData;
        if (!data.emailMarkdown) {
          return new Response(
            JSON.stringify({
              status: 'not-found',
              error: `No emailMarkdown cached for ${date} — Phase 2 never completed for that date`,
            }),
            { status: 404, headers: JSON_HEADERS },
          );
        }

        let onlyTo: { email: string; name: string } | undefined;
        if (toEmail) {
          const known = [EMAIL_TO, ...EMAIL_TO_PL].find(r => r.email.toLowerCase() === toEmail.toLowerCase());
          onlyTo = known ?? { email: toEmail, name: toEmail.split('@')[0] };
        }

        if (sync) {
          await sendAllEmails(env, data.emailMarkdown, { testMode, onlyTo });
          return new Response(
            JSON.stringify({ status: 'sent', date, testMode, onlyTo: onlyTo?.email ?? 'all' }),
            { headers: JSON_HEADERS },
          );
        }

        await env.DIGEST_QUEUE.send({ kind: 'resend', date, testMode, onlyTo });
        return new Response(
          JSON.stringify({ status: 'enqueued', date, testMode, onlyTo: onlyTo?.email ?? 'all' }),
          { headers: JSON_HEADERS },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

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
          working: working.sort((a, b) => b.itemCount - a.itemCount).map(f => ({ name: f.name, items: f.itemCount })),
          failing: failing.map(f => ({ name: f.name, error: f.error })),
        };
        return new Response(JSON.stringify(response, null, 2), { headers: JSON_HEADERS });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), { status: 500, headers: JSON_HEADERS });
      }
    }

    if (url.pathname === '/test-email' && request.method === 'POST') {
      try {
        await sendDigestEmail(env, '# Test Digest\n\nThis is a test email from the AI News Digest worker.\n\n---\n\n## 🌤️ Weather\n\nSunny in Cyprus, rainy in Gdańsk.\n\n| Day | Conditions | High / Low |\n|---|---|---|\n| Monday | Clear sky | 24°C / 15°C |\n| Tuesday | Partly cloudy | 22°C / 14°C |');
        return new Response(JSON.stringify({ status: 'Test email sent' }), { headers: JSON_HEADERS });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ error: msg }), { status: 500, headers: JSON_HEADERS });
      }
    }

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

    if (url.pathname.startsWith('/story/') && request.method === 'GET') {
      const parts = url.pathname.split('/');
      const date = parts[2];
      const slug = parts[3];
      if (!date || !slug) return new Response('Not found', { status: 404 });

      let digestData: DigestData | null = null;
      try {
        const raw = await env.DIGEST_KV.get(`digest:${date}`);
        if (raw) digestData = JSON.parse(raw) as DigestData;
      } catch (err) {
        console.error(`[Story] KV read failed: ${err}`);
      }
      if (!digestData?.digestMarkdown) return new Response('Not found', { status: 404 });
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
