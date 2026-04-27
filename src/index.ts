import { fetchAllFeeds } from './feeds';
import { fetchWeather } from './weather';
import { fetchMarketData } from './markets';
import {
  BASELINE_CONFIG,
  VARIANT_CONFIGS,
  listEnabledVariantConfigs,
  resolveProvider,
  type VariantConfig,
} from './providers';
import {
  buildTranslationPrompt,
  buildStructuredCompilationPrompt,
} from './prompts';
import {
  parseStructuredDigest,
  assembleAll,
  DIGEST_JSON_SCHEMA,
  type AssembleOptions,
} from './digest-builder';
import type { StructuredDigest } from './types';
import {
  BATCH_SIZE,
  classifyInBatches,
  distributeBySource,
  parseClassifiedJson,
  urlDedupAndDropLow,
  semanticDedup,
  selectForDigest,
  selectedToFlat,
} from './classify';
import {
  buildClassificationPrompt,
} from './prompts';
import {
  submitBatch,
  getBatchStatus,
  getBatchResults,
  extractText,
  extractToolUseInput,
  type BatchRequest,
} from './providers/anthropic-batch';
import { sendDigestEmail, sendErrorEmail, type InlineImage } from './email';
import { generateDigestImage } from './image';
import { EMAIL_TO, EMAIL_TO_PL } from './config';
import { fetchPerPersonInterests, renderInterestsFor } from './interests';
import { buildLandingPage, buildStoryPage } from './landing';
import {
  confirmSubscriber,
  createUnsubConfirmToken,
  deriveUnsubToken,
  finalizeUnsubscribe,
  isValidEmail,
  isValidLang,
  listActiveSubscribers,
  loadSuppressionSet,
  normalizeEmail,
  startSubscribe,
  verifyUnsubToken,
} from './subscribers';
import {
  checkAndIncrementIpRateLimit,
  checkAndIncrementUnsubTokenRateLimit,
  incrementGlobalSubscribeCounter,
  shouldFireAlarm,
} from './ratelimit';
import {
  checkInboxPage,
  confirmInvalidPage,
  confirmSuccessPage,
  finalizeSuccessPage,
  genericErrorPage,
  invalidRequestPage,
  rateLimitedPage,
  unsubscribeConfirmPage,
  unsubscribeInvalidPage,
  unsubscribeSentPage,
} from './subscribe-pages';
import {
  sendRateLimitAlarmEmail,
  sendSubscribeConfirmEmail,
  sendUnsubscribeConfirmEmail,
} from './subscriber-emails';
import type {
  ClassifyBatchState,
  CompileBatchState,
  CuratedInterestItem,
  ClassifiedItem,
  Env,
  DigestData,
  Phase1Output,
  QueueMessage,
  RssItem,
  SubscriberLang,
} from './types';

const WEBSITE_URL = 'https://ainewsworker.rogaczewski-dev.workers.dev';
const PHASE1_TTL_SECONDS = 604_800; // 7 days

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// Date label for the digest about to be prepared at 23 UTC. Used by Stage A
// only — at 23 UTC the UTC day hasn't ticked over yet but the email ships the
// next morning, so the digest is labeled with tomorrow's UTC date. The 01/03
// UTC fallbacks already see the rolled-over `todayUtc()` and stay consistent.
function tomorrowUtc(): string {
  const t = new Date();
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
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

  // Cache the raw (sorted) feed for A/B variant pipelines. Variants read from
  // this cache instead of re-fetching RSS N times. Non-fatal on failure — the
  // baseline pipeline doesn't depend on the cache.
  try {
    await env.DIGEST_KV.put(`rss:${runDate}`, JSON.stringify(sortedItems), {
      expirationTtl: PHASE1_TTL_SECONDS,
    });
  } catch (err) {
    console.log(`[Phase1] KV write rss:${runDate} failed (non-fatal): ${err}`);
  }

  // Step 4: batched classification via the baseline variant config's cheap-tier
  // provider (each batch checkpoints to KV).
  // The legacy Sonnet path has been removed — see commit history if you need it back.
  console.log(`[Phase1] Step 4 (batched): classifying ${sortedItems.length} items (${BASELINE_CONFIG.id})...`);
  const classified = await classifyInBatches(env, BASELINE_CONFIG, sortedItems, runDate);
  console.log(`[Phase1] Classified ${classified.length}/${sortedItems.length} items`);
  if (classified.length === 0) {
    throw new Error('Batched classification returned 0 items — every batch failed');
  }

  // Stage 3a: URL dedup + drop low importance
  const urlDeduped = urlDedupAndDropLow(classified);

  // Stage 3b: semantic dedup
  const fullyDeduped = await semanticDedup(env, BASELINE_CONFIG, urlDeduped);

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

  // Per-person interest sections (cycling, etc.). Non-fatal: returns {} on any
  // issue, which renderInterestsFor treats as "no interest section this run".
  let interestItems: Record<string, CuratedInterestItem[]> = {};
  try {
    interestItems = await fetchPerPersonInterests(env, BASELINE_CONFIG);
  } catch (err) {
    console.log(`[Phase1] fetchPerPersonInterests failed (non-fatal): ${err}`);
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
    interestItems,
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

// Compiled digest in EN + PL — produced from a single Sonnet call against
// buildStructuredCompilationPrompt and assembled to markdown in code.
// fullDigestPl and structured are optional only because the legacy KV
// resumption path (cached EN markdown from before the structured refactor)
// lacks them — fresh compileStructured calls always produce all five.
interface CompiledDigest {
  fullDigestEn: string;
  briefingEn: string;
  briefingPl: string;
  fullDigestPl?: string;
  structured?: StructuredDigest;
}

function assembleOptionsFor(phase1: Phase1Output): AssembleOptions {
  return {
    websiteUrl: WEBSITE_URL,
    date: new Date(),
    dateString: phase1.date,
    feedStats: { total: phase1.feedStats.total, failed: phase1.feedStats.failed },
    weather: phase1.weather,
    markets: phase1.markets,
    input: phase1.selectedInput,
  };
}

// Single Sonnet call producing EN + PL prose; markdown is assembled in code.
// On parse failure or any thrown error the call propagates — no fallback.
async function compileStructured(
  env: Env,
  config: VariantConfig,
  phase1: Phase1Output,
): Promise<CompiledDigest> {
  const prompt = buildStructuredCompilationPrompt(
    phase1.selectedInput,
    phase1.markets,
    { total: phase1.feedStats.total, failed: phase1.feedStats.failed },
  );
  const provider = resolveProvider(config, 'standard');
  // Prefer native structured output (Anthropic tool_use). The model is
  // mechanically constrained to emit JSON matching DIGEST_JSON_SCHEMA, which
  // eliminates the entire class of text-mode JSON parse failures (trailing
  // commas, Polish curly-quote/straight-quote pairing, etc.). Providers
  // without callJson fall back to text + parseStructuredDigest.
  let structured: StructuredDigest;
  if (provider.callJson) {
    structured = await provider.callJson<StructuredDigest>(
      env,
      'standard',
      prompt,
      DIGEST_JSON_SCHEMA,
      32000,
    );
  } else {
    const raw = await provider.call(env, 'standard', prompt, 32000);
    structured = parseStructuredDigest(raw);
  }
  const assembled = assembleAll(structured, assembleOptionsFor(phase1));
  console.log(
    `[Compile] Structured (${config.id}, ${provider.callJson ? 'tool_use' : 'text'}) OK — ` +
      `EN ${assembled.fullDigestEn.length}c / PL ${assembled.fullDigestPl.length}c, ` +
      `briefings EN ${assembled.briefingEn.length}c / PL ${assembled.briefingPl.length}c`,
  );
  return { ...assembled, structured };
}

// Re-assemble all four markdown forms from a previously-persisted structured
// digest. Lets a Phase 2 retry skip the Sonnet call entirely when the prior
// run made it past compilation but failed before send.
function assembleFromCachedStructured(
  structured: StructuredDigest,
  phase1: Phase1Output,
): CompiledDigest {
  const assembled = assembleAll(structured, assembleOptionsFor(phase1));
  return { ...assembled, structured };
}

// Resumption-aware compile for Phase 2:
//   1. structuredDigest in KV → re-assemble (no LLM call)
//   2. digestMarkdown + emailMarkdown in KV (cached digests written before
//      the structured-output refactor) → reuse + on-demand PL translation
//   3. Fresh compileStructured call. No fallback chain — if Sonnet returns
//      unparsable JSON, Phase 2 throws and the queue retries.
async function loadOrCompileForPhase2(
  env: Env,
  phase1: Phase1Output,
  date: string,
): Promise<CompiledDigest> {
  const cachedStructured = await readCachedDigestField(env, date, 'structuredDigest');
  if (cachedStructured) {
    try {
      const structured = JSON.parse(cachedStructured) as StructuredDigest;
      const result = assembleFromCachedStructured(structured, phase1);
      console.log(`[Phase2] Reused cached structured digest (${cachedStructured.length} bytes)`);
      return result;
    } catch (err) {
      console.log(`[Phase2] Cached structuredDigest unparsable (${err}); re-compiling`);
    }
  }

  const cachedFullEn = await readCachedDigestField(env, date, 'digestMarkdown');
  const cachedBriefingEn = await readCachedDigestField(env, date, 'emailMarkdown');
  if (cachedFullEn && cachedBriefingEn) {
    console.log(`[Phase2] Reusing cached EN digest+briefing pair; re-translating PL`);
    const briefingPl = await translateToPolish(env, BASELINE_CONFIG, cachedBriefingEn);
    return { fullDigestEn: cachedFullEn, briefingEn: cachedBriefingEn, briefingPl };
  }

  console.log(`[Phase2] Step 5: Compiling structured digest (${BASELINE_CONFIG.id})...`);
  const compiled = await compileStructured(env, BASELINE_CONFIG, phase1);
  await persistDigest(env, phase1, {
    digestMarkdown: compiled.fullDigestEn,
    emailMarkdown: compiled.briefingEn,
    digestMarkdownPl: compiled.fullDigestPl,
    emailMarkdownPl: compiled.briefingPl,
    structuredDigest: compiled.structured ? JSON.stringify(compiled.structured) : undefined,
  });
  return compiled;
}

async function runPhase2(env: Env, date: string, opts: Phase2Options = {}): Promise<string> {
  console.log(`[Phase2] Starting compile+send for ${date} (testMode=${!!opts.testMode})`);

  const raw = await env.DIGEST_KV.get(`phase1:${date}`);
  if (!raw) {
    throw new Error(`[Phase2] No phase1:${date} in KV — Phase 1 didn't complete`);
  }
  const phase1: Phase1Output = JSON.parse(raw);

  // ── Step 5: structured compilation (one Sonnet call, EN+PL out) ────────────
  // Resumption order: cached structured JSON → cached EN markdown pair →
  // fresh compile. Only the structured JSON path also gives us PL forms; the
  // legacy cache only carries EN.
  const compiled = await loadOrCompileForPhase2(env, phase1, date);

  // ── Step 5c: generate illustration (owner-only, gated by ENABLE_DIGEST_IMAGE) ──
  let inlineImage: InlineImage | undefined;
  if (env.ENABLE_DIGEST_IMAGE === 'true') {
    const img = await generateDigestImage(env, compiled.briefingEn).catch(err => {
      console.log(`[Phase2] Image generation threw (non-fatal): ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (img) inlineImage = img;
  }

  // ── Step 6 + 7: send (no in-flight translation — briefingPl is ready) ──────
  await sendAllEmails(env, compiled.briefingEn, compiled.briefingPl, {
    ...opts,
    inlineImage,
    interestItems: phase1.interestItems,
  });

  // Heartbeat: only after every recipient resolved. The 03:30 retry uses this
  // to decide whether to re-enqueue.
  try {
    await env.DIGEST_KV.put('digest:lastSuccess', date);
  } catch (err) {
    console.error(`[Phase2] Heartbeat write failed (non-fatal): ${err}`);
  }

  // External heartbeat: ping the uptime monitor if configured. If this ping
  // stops arriving, the monitor emails us — independent of Cloudflare being
  // up, so it catches account-level outages our own watchdog can't.
  await pingExternalHeartbeat(env);

  console.log(`[Phase2] Complete for ${date}`);
  return 'success';
}

// ──────────────────────────────────────────────────────────────────────────────
// A/B variant pipelines. For each enabled variant config, run a full
// classify → compile → send flow on the same day's raw RSS cache and deliver
// a single labelled email to the configured recipient (frogaczewski@gmail.com
// by default). Baseline Claude pipeline is untouched — variants use isolated
// KV keys suffixed with the config id and cannot interfere with the main
// digest or the landing page.
// ──────────────────────────────────────────────────────────────────────────────

// Enqueue one variant message per enabled config for the given date. Caller
// is expected to have already enqueued the baseline `compile-and-send`.
async function enqueueVariants(env: Env, date: string): Promise<void> {
  const variants = listEnabledVariantConfigs(env);
  if (variants.length === 0) return;
  for (const config of variants) {
    try {
      await env.DIGEST_QUEUE.send({
        kind: 'compile-and-send',
        date,
        variant: { configId: config.id, recipient: EMAIL_TO },
      });
      console.log(`[Variants] Enqueued "${config.id}" for ${date} → ${EMAIL_TO.email}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Variants] Failed to enqueue "${config.id}": ${msg}`);
    }
  }
}

interface VariantCoreInput {
  sortedItems: RssItem[];
  weather: Phase1Output['weather'];
  markets: Phase1Output['markets'];
  feedStats: Phase1Output['feedStats'];
}

interface VariantCoreOptions {
  persistKv: boolean;
  subjectPrefix?: string;
  logTag?: string; // defaults to "Variant"
  // 'pl' (default) — translate briefing to Polish, Polish subject + greeting.
  // 'en' — skip translation, ship the English briefing as-is.
  language?: 'en' | 'pl';
}

// Shared classify → compile → brief → translate → send pipeline for any variant
// config. Used by both the queued production variant (runVariantPipeline) and
// the synchronous test endpoint (runTestVariant). KV writes are opt-in so
// test runs don't overwrite production variant state.
async function runVariantCore(
  env: Env,
  config: VariantConfig,
  date: string,
  input: VariantCoreInput,
  recipient: { email: string; name: string },
  opts: VariantCoreOptions,
): Promise<void> {
  const tag = opts.logTag ?? 'Variant';

  const classified = await classifyInBatches(env, config, input.sortedItems, date);
  if (classified.length === 0) {
    throw new Error(`[${tag} ${config.id}] classification returned 0 items`);
  }
  const urlDeduped = urlDedupAndDropLow(classified);
  const fullyDeduped = await semanticDedup(env, config, urlDeduped);
  const selectedInput = selectForDigest(fullyDeduped);
  const triagedStories = selectedToFlat(selectedInput);

  // Carry imageUrl from RSS items (classification prompts don't request it).
  const imagesByLink = new Map<string, string>();
  for (const item of input.sortedItems) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const story of triagedStories) {
    if (!story.imageUrl && story.link && imagesByLink.has(story.link)) {
      story.imageUrl = imagesByLink.get(story.link);
    }
  }
  const storyImages: Record<string, string> = {};
  for (const story of triagedStories) {
    if (story.imageUrl && story.link) {
      const baseUrl = story.link.split('?')[0];
      storyImages[baseUrl] = story.imageUrl;
      if (baseUrl !== story.link) storyImages[story.link] = story.imageUrl;
    }
  }

  const phase1Variant: Phase1Output = {
    date,
    selectedInput,
    triagedStories,
    weather: input.weather,
    markets: input.markets,
    feedStats: input.feedStats,
    storyImages,
  };

  const producedBy = {
    configId: config.id,
    classifyModel: resolveProvider(config, 'cheap').modelFor('cheap'),
    composeModel: resolveProvider(config, 'standard').modelFor('standard'),
    timestamp: Date.now(),
  };

  if (opts.persistKv) {
    try {
      await env.DIGEST_KV.put(
        `phase1:${date}:${config.id}`,
        JSON.stringify({ ...phase1Variant, producedBy }),
        { expirationTtl: PHASE1_TTL_SECONDS },
      );
    } catch (err) {
      console.log(`[${tag} ${config.id}] KV write phase1:${date}:${config.id} failed (non-fatal): ${err}`);
    }
  }

  const language = opts.language ?? 'pl';

  const compiled = await compileStructured(env, config, phase1Variant);
  console.log(
    `[${tag} ${config.id}] Compiled — EN ${compiled.fullDigestEn.length}c, ` +
      `briefings EN ${compiled.briefingEn.length}c / PL ${compiled.briefingPl.length}c`,
  );
  const finalBriefing = language === 'pl' ? compiled.briefingPl : compiled.briefingEn;

  if (opts.persistKv) {
    try {
      const variantDigest: DigestData & { producedBy: typeof producedBy } = {
        date,
        stories: triagedStories,
        weather: input.weather,
        markets: input.markets,
        feedStats: { total: input.feedStats.total, succeeded: input.feedStats.succeeded },
        storyImages,
        digestMarkdown: compiled.fullDigestEn,
        emailMarkdown: compiled.briefingEn,
        ...(compiled.fullDigestPl ? { digestMarkdownPl: compiled.fullDigestPl } : {}),
        emailMarkdownPl: compiled.briefingPl,
        ...(compiled.structured ? { structuredDigest: JSON.stringify(compiled.structured) } : {}),
        producedBy,
      };
      await env.DIGEST_KV.put(`digest:${date}:${config.id}`, JSON.stringify(variantDigest), {
        expirationTtl: PHASE1_TTL_SECONDS,
      });
    } catch (err) {
      console.log(`[${tag} ${config.id}] KV write digest:${date}:${config.id} failed (non-fatal): ${err}`);
    }
  }

  const now = new Date();
  const subject = language === 'pl'
    ? `${opts.subjectPrefix ?? ''}Codzienny Przegląd Wiadomości — ${now.toLocaleDateString('pl-PL', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })}`
    : `${opts.subjectPrefix ?? ''}Daily News Digest — ${now.toLocaleDateString('en-GB', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      })}`;
  // sendDigestEmail's HTML template handles the greeting line (☕ Good morning
  // / Dzień dobry) — pass the briefing as-is.
  await sendDigestEmail(
    env,
    finalBriefing,
    undefined,
    recipient,
    subject,
    config.label,
  );
  console.log(`[${tag} ${config.id}] Email dispatched to ${recipient.email} (${language})`);
}

// Production variant pipeline: reads RSS + baseline weather/markets from KV
// (populated by the most recent Phase 1 run) and persists variant state.
async function runVariantPipeline(
  env: Env,
  config: VariantConfig,
  date: string,
  recipient: { email: string; name: string },
): Promise<void> {
  console.log(`[Variant ${config.id}] Starting pipeline for ${date} → ${recipient.email}`);

  const rssRaw = await env.DIGEST_KV.get(`rss:${date}`);
  if (!rssRaw) {
    throw new Error(`[Variant ${config.id}] No rss:${date} in KV — baseline Phase 1 didn't complete`);
  }
  const sortedItems: RssItem[] = JSON.parse(rssRaw);

  // Weather + market data are genuinely provider-agnostic — reuse baseline's
  // fetched values rather than re-fetching.
  const baselineRaw = await env.DIGEST_KV.get(`phase1:${date}`);
  if (!baselineRaw) {
    throw new Error(`[Variant ${config.id}] No phase1:${date} in KV — baseline Phase 1 didn't complete`);
  }
  const baseline: Phase1Output = JSON.parse(baselineRaw);

  await runVariantCore(
    env,
    config,
    date,
    {
      sortedItems,
      weather: baseline.weather,
      markets: baseline.markets,
      feedStats: baseline.feedStats,
    },
    recipient,
    { persistKv: true },
  );
}

// Test endpoint: fetches fresh RSS + weather + markets and runs the full
// variant pipeline synchronously, sending one email to EMAIL_TO with a
// `[TEST]` subject prefix. Language is caller-selected — 'pl' (default)
// translates to Polish, 'en' ships the briefing as-is. Skips all KV writes
// so production variant state (`phase1:{date}:{configId}`,
// `digest:{date}:{configId}`) is untouched.
async function runTestVariant(
  env: Env,
  config: VariantConfig,
  language: 'en' | 'pl' = 'pl',
): Promise<void> {
  console.log(`[TestVariant ${config.id}] Starting fresh sync test run (lang=${language})`);

  const [feedResult, weather, markets] = await Promise.all([
    fetchAllFeeds(),
    fetchWeather(),
    fetchMarketData(),
  ]);

  if (feedResult.items.length === 0) {
    throw new Error('No RSS items fetched — all feeds failed');
  }

  const sortedItems = [...feedResult.items].sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  await runVariantCore(
    env,
    config,
    todayUtc(),
    {
      sortedItems,
      weather,
      markets,
      feedStats: {
        total: feedResult.total,
        failed: feedResult.failed,
        succeeded: feedResult.total - feedResult.failed,
      },
    },
    EMAIL_TO,
    { persistKv: false, subjectPrefix: '[TEST] ', logTag: 'TestVariant', language },
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Batched async pipeline (Anthropic Message Batches API).
//
// Three queue-driven stages replace the legacy single-cron Phase 1 / Phase 2
// streaming flow. Each invocation is one ~30s worker call; progression
// between stages is driven by self-polling queue messages with adaptive
// `delaySeconds`.
//
//   23:00 UTC  Stage A — fetch + submit Haiku classification batch.
//                        Enqueues poll-classify (5 min delay).
//   ?         poll-classify — when batch ends, runs dedup + select +
//                        submits Sonnet structured-compile batch, then
//                        enqueues poll-compile.
//   ?         poll-compile — when batch ends, runs assembleAll + send.
//   01:00 UTC  cron fallback for poll-classify (no-op if Stage B done).
//   03:00 UTC  cron fallback for poll-compile  (no-op if Stage C done).
//   04:30 UTC  watchdog alarms if `digest:lastSuccess != date`.
//
// Why this exists: the streaming Sonnet call hit Cloudflare's 15-min queue
// wall-time ceiling repeatedly when Anthropic returned empty/stalled streams
// (see exceededCpu / wallTimeMs=899996 incidents in late April 2026). The
// batches API is async with a 24-hour SLA — no streaming, no per-attempt
// timeout cascade burning the worker budget. 50% cost discount is incidental.
// ──────────────────────────────────────────────────────────────────────────────

const HAIKU_BATCH_MODEL = 'claude-haiku-4-5-20251001';
const SONNET_BATCH_MODEL = 'claude-sonnet-4-6';
const STRUCTURED_TOOL_NAME = 'emit_structured_output';

// Stage B time budget — past this, we accept partial results if at least
// half succeeded, otherwise abort + alarm. Anchored to the Stage A submission
// time so a stuck Anthropic batch doesn't perpetually defer.
const STAGE_B_BUDGET_MS = 4 * 60 * 60 * 1000;

// Adaptive re-poll delays for an in_progress Haiku batch. Picked as a
// function of elapsed time since Stage A submission so we poll cheaply early
// and tighten as the 4-hour budget approaches.
function haikuRepollDelaySeconds(elapsedMs: number, testMode: boolean): number {
  const scale = testMode ? 0.1 : 1;
  if (elapsedMs < 60 * 60 * 1000) return Math.round(300 * scale);          // < 1h: 5 min
  if (elapsedMs < 3 * 60 * 60 * 1000) return Math.round(900 * scale);       // 1–3h: 15 min
  if (elapsedMs < STAGE_B_BUDGET_MS) return Math.round(300 * scale);        // 3–4h: 5 min (urgent)
  return Math.round(1800 * scale);                                          // ≥ 4h: 30 min (watchdog handles)
}

function sonnetRepollDelaySeconds(elapsedMs: number, testMode: boolean): number {
  const scale = testMode ? 0.1 : 1;
  if (elapsedMs < 60 * 60 * 1000) return Math.round(300 * scale);  // < 1h: 5 min
  return Math.round(180 * scale);                                  // ≥ 1h: 3 min
}

function customIdForClassifyBatch(date: string, batchIdx: number): string {
  return `classify-${date}-${batchIdx}`;
}

function customIdForCompile(date: string): string {
  return `compile-${date}`;
}

// Carry imageUrl from RssItem→ClassifiedItem. The classification prompt
// doesn't ask for it, so it gets dropped on the round trip; we restore it
// from a (link → imageUrl) lookup over the original RSS items.
function carryImageUrls(items: ClassifiedItem[], rssItems: RssItem[]): void {
  const imagesByLink = new Map<string, string>();
  for (const item of rssItems) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const it of items) {
    if (!it.imageUrl && it.link && imagesByLink.has(it.link)) {
      it.imageUrl = imagesByLink.get(it.link);
    }
  }
}

// Stage A: fetch RSS / weather / markets / interests, slice the items into
// source-diverse batches, submit ONE Haiku classification batch, persist
// the state needed for Stage B, enqueue the first poll-classify.
//
// Idempotent: if `batch:classify:{date}` already exists for the day, exit
// early — the queued poll handler is still in flight (or watchdog will
// surface a stuck batch). Re-running this for the same date never submits
// twice.
async function runStageA(env: Env, date: string, opts: { testMode?: boolean } = {}): Promise<void> {
  const testMode = !!opts.testMode;

  const existingRaw = await env.DIGEST_KV.get(`batch:classify:${date}`);
  if (existingRaw) {
    console.log(`[StageA] batch:classify:${date} already exists — skipping submit (idempotent)`);
    return;
  }

  console.log(`[StageA] Starting${testMode ? ' (testMode)' : ''} for ${date}`);

  const [feedResult, weather, markets] = await Promise.all([
    fetchAllFeeds(),
    fetchWeather(),
    fetchMarketData(),
  ]);

  console.log(`[StageA] RSS: ${feedResult.items.length} items from ${feedResult.total - feedResult.failed}/${feedResult.total} feeds`);
  if (feedResult.errors.length > 0) {
    console.log(`[StageA] Feed errors: ${feedResult.errors.join('; ')}`);
  }
  if (feedResult.items.length === 0) {
    throw new Error('[StageA] No RSS items fetched — all feeds failed');
  }

  const sortedItems = [...feedResult.items].sort((a, b) => {
    const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return db - da;
  });

  // Cache raw RSS for variant pipelines (existing behavior). Non-fatal.
  try {
    await env.DIGEST_KV.put(`rss:${date}`, JSON.stringify(sortedItems), {
      expirationTtl: PHASE1_TTL_SECONDS,
    });
  } catch (err) {
    console.log(`[StageA] KV write rss:${date} failed (non-fatal): ${err}`);
  }

  // Per-person interest sections — sync Haiku call against curated sources.
  // Small enough to keep inline; non-fatal failure (returns {}).
  let interestItems: Record<string, CuratedInterestItem[]> = {};
  try {
    interestItems = await fetchPerPersonInterests(env, BASELINE_CONFIG);
  } catch (err) {
    console.log(`[StageA] fetchPerPersonInterests failed (non-fatal): ${err}`);
  }

  // Source-diverse round-robin batching: each source's items get spread
  // across all batches so a single batch failure can't wipe out one outlet.
  const batches = distributeBySource(sortedItems, BATCH_SIZE);
  const customIdToBatchIdx: Record<string, number> = {};
  const requests: BatchRequest[] = batches.map((batch, idx) => {
    const customId = customIdForClassifyBatch(date, idx);
    customIdToBatchIdx[customId] = idx;
    return {
      custom_id: customId,
      params: {
        model: HAIKU_BATCH_MODEL,
        max_tokens: 12000,
        messages: [{ role: 'user', content: buildClassificationPrompt(batch) }],
      },
    };
  });

  const { id: batchId } = await submitBatch(env, requests);
  console.log(`[StageA] Submitted Haiku batch ${batchId} with ${requests.length} requests`);

  const state: ClassifyBatchState = {
    batchId,
    submittedAt: Date.now(),
    customIdToBatchIdx,
    totalRequests: requests.length,
    sortedItems,
    weather,
    markets,
    feedStats: {
      total: feedResult.total,
      failed: feedResult.failed,
      succeeded: feedResult.total - feedResult.failed,
    },
    interestItems,
    testMode,
  };
  await env.DIGEST_KV.put(`batch:classify:${date}`, JSON.stringify(state), {
    expirationTtl: PHASE1_TTL_SECONDS,
  });
  await env.DIGEST_KV.put('digest:stageASuccess', date, { expirationTtl: PHASE1_TTL_SECONDS });

  // Enqueue first self-poll. 5 min default; 30 s in test mode.
  await env.DIGEST_QUEUE.send({
    kind: 'poll-classify',
    date,
    attempt: 1,
    testMode: testMode || undefined,
  }, { delaySeconds: testMode ? 30 : 300 });
  console.log(`[StageA] Enqueued first poll-classify (delay=${testMode ? 30 : 300}s)`);
}

// Stage B core: read the day's Haiku batch, decide what to do based on
// processing_status + request_counts, and either: re-enqueue ourselves with
// adaptive delay; proceed (collect results, dedup, select, submit Sonnet
// batch); or abort with alarm.
//
// Returns true when Stage B's work is complete (Sonnet batch submitted),
// false when we re-enqueued and should ack. Throws on unrecoverable error.
async function pollClassifyOnce(env: Env, date: string, attempt: number, testMode: boolean): Promise<boolean> {
  // If Stage C is already in flight (or done), stop polling Haiku.
  const stageBDone = await env.DIGEST_KV.get('digest:stageBSuccess');
  if (stageBDone === date) {
    console.log(`[PollClassify] Stage B already done for ${date} — skipping`);
    return true;
  }

  const stateRaw = await env.DIGEST_KV.get(`batch:classify:${date}`);
  if (!stateRaw) {
    throw new Error(`[PollClassify] No batch:classify:${date} in KV — Stage A never ran`);
  }
  const state = JSON.parse(stateRaw) as ClassifyBatchState;

  const status = await getBatchStatus(env, state.batchId);
  const elapsedMs = Date.now() - state.submittedAt;
  const total = state.totalRequests;
  const succeeded = status.request_counts.succeeded;
  const rate = total > 0 ? succeeded / total : 0;

  console.log(
    `[PollClassify] attempt=${attempt} batchId=${state.batchId} status=${status.processing_status} ` +
      `processing=${status.request_counts.processing} succeeded=${succeeded}/${total} ` +
      `elapsedMin=${Math.round(elapsedMs / 60000)}`,
  );

  if (status.processing_status === 'canceling') {
    // Treat canceling as terminal-ish; fall through to next poll.
    await reEnqueuePollClassify(env, date, attempt, haikuRepollDelaySeconds(elapsedMs, testMode), testMode);
    return false;
  }

  if (status.processing_status === 'in_progress') {
    if (elapsedMs >= STAGE_B_BUDGET_MS) {
      // Past 4h still in_progress. Anthropic should have ended the batch by
      // now — keep polling slowly; the watchdog will alarm at 04:30 if the
      // digest didn't ship.
      console.warn(`[PollClassify] batch still in_progress past 4h budget — continuing to poll`);
    }
    await reEnqueuePollClassify(env, date, attempt, haikuRepollDelaySeconds(elapsedMs, testMode), testMode);
    return false;
  }

  // status === 'ended' from here on. request_counts is now meaningful.
  if (rate < 0.5) {
    if (elapsedMs >= STAGE_B_BUDGET_MS) {
      const msg =
        `[PollClassify] ABORTING — batch ended with only ${succeeded}/${total} succeeded ` +
        `(${Math.round(rate * 100)}%), past 4h budget`;
      console.error(msg);
      await sendErrorEmail(env, msg).catch(() => undefined);
      return true; // ack — nothing more to do
    }
    // Re-poll in 1h hoping for a manual intervention or better understanding.
    // Ended is final on Anthropic's side, but we honour the user's "wait 1h"
    // policy before giving up.
    console.warn(`[PollClassify] ended below 50% (${succeeded}/${total}) — waiting 1h before final decision`);
    await reEnqueuePollClassify(env, date, attempt, testMode ? 360 : 3600, testMode);
    return false;
  }

  if (rate < 0.8 && elapsedMs < STAGE_B_BUDGET_MS) {
    // 50–80% with budget remaining: wait 1h then accept whatever's there.
    console.log(`[PollClassify] ended at ${Math.round(rate * 100)}% — waiting 1h before proceeding`);
    await reEnqueuePollClassify(env, date, attempt, testMode ? 360 : 3600, testMode);
    return false;
  }

  // Proceed: rate ≥ 0.8, OR rate ≥ 0.5 and budget exhausted.
  console.log(`[PollClassify] Proceeding to Stage B compose (rate=${Math.round(rate * 100)}%)`);
  await runStageBCompose(env, date, state);
  return true;
}

async function reEnqueuePollClassify(
  env: Env,
  date: string,
  attempt: number,
  delaySeconds: number,
  testMode: boolean,
): Promise<void> {
  await env.DIGEST_QUEUE.send(
    { kind: 'poll-classify', date, attempt: attempt + 1, testMode: testMode || undefined },
    { delaySeconds },
  );
  console.log(`[PollClassify] Re-enqueued (attempt=${attempt + 1}, delay=${delaySeconds}s)`);
}

// Drives the second half of Stage B: download Haiku results, run dedup +
// select, write phase1, submit Sonnet structured-compile batch, enqueue
// first poll-compile.
async function runStageBCompose(env: Env, date: string, state: ClassifyBatchState): Promise<void> {
  const results = await getBatchResults(env, state.batchId);

  // Reassemble classified items by custom_id. Failed/missing custom_ids
  // contribute zero items — same fail-soft shape as the legacy
  // classifyInBatches Promise.allSettled behavior.
  const allClassified: ClassifiedItem[] = [];
  let parsedBatches = 0;
  let failedBatches = 0;
  for (const [customId, batchIdx] of Object.entries(state.customIdToBatchIdx)) {
    const record = results.get(customId);
    if (!record || record.result.type !== 'succeeded') {
      failedBatches++;
      console.log(`[StageB] Batch ${batchIdx} (${customId}) result missing or non-succeeded`);
      continue;
    }
    try {
      const text = extractText(record);
      const items = parseClassifiedJson(text);
      allClassified.push(...items);
      parsedBatches++;
    } catch (err) {
      failedBatches++;
      console.log(`[StageB] Batch ${batchIdx} parse failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(
    `[StageB] Parsed ${parsedBatches}/${parsedBatches + failedBatches} batches → ${allClassified.length} classified items`,
  );

  if (allClassified.length === 0) {
    throw new Error('[StageB] No classified items extracted from Haiku batch results');
  }

  carryImageUrls(allClassified, state.sortedItems);

  // URL dedup → semantic dedup (sync Haiku, small) → balance-aware select.
  const urlDeduped = urlDedupAndDropLow(allClassified);
  const fullyDeduped = await semanticDedup(env, BASELINE_CONFIG, urlDeduped);
  const selectedInput = selectForDigest(fullyDeduped);
  console.log(
    `[StageB] Selection: ${selectedInput.sections.length} sections, ` +
      `${selectedInput.sections.reduce((n, s) => n + s.stories.length, 0)} stories`,
  );
  const triagedStories = selectedToFlat(selectedInput);

  // Build the storyImages map (mirrors runPhase1 logic).
  const imagesByLink = new Map<string, string>();
  for (const item of state.sortedItems) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const story of triagedStories) {
    if (!story.imageUrl && story.link && imagesByLink.has(story.link)) {
      story.imageUrl = imagesByLink.get(story.link);
    }
  }
  const storyImages: Record<string, string> = {};
  for (const story of triagedStories) {
    if (story.imageUrl && story.link) {
      const baseUrl = story.link.split('?')[0];
      storyImages[baseUrl] = story.imageUrl;
      if (baseUrl !== story.link) storyImages[story.link] = story.imageUrl;
    }
  }

  const phase1: Phase1Output = {
    date,
    selectedInput,
    triagedStories,
    weather: state.weather,
    markets: state.markets,
    feedStats: state.feedStats,
    storyImages,
    interestItems: state.interestItems,
  };

  await env.DIGEST_KV.put(`phase1:${date}`, JSON.stringify(phase1), {
    expirationTtl: PHASE1_TTL_SECONDS,
  });
  await env.DIGEST_KV.put('digest:phase1Success', date);

  // Submit the single-request Sonnet structured-compile batch. Same prompt
  // and tool_use schema as the streaming compileStructured path; the API
  // server validates the tool_use input against DIGEST_JSON_SCHEMA.
  const compilePrompt = buildStructuredCompilationPrompt(
    selectedInput,
    state.markets,
    { total: state.feedStats.total, failed: state.feedStats.failed },
  );
  const customId = customIdForCompile(date);
  const { id: compileBatchId } = await submitBatch(env, [{
    custom_id: customId,
    params: {
      model: SONNET_BATCH_MODEL,
      max_tokens: 32000,
      messages: [{ role: 'user', content: compilePrompt }],
      tools: [{
        name: STRUCTURED_TOOL_NAME,
        description: 'Emit the structured digest output. The model MUST invoke this tool — its `input` is parsed and used directly downstream.',
        input_schema: DIGEST_JSON_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
    },
  }]);
  console.log(`[StageB] Submitted Sonnet compile batch ${compileBatchId}`);

  const compileState: CompileBatchState = {
    batchId: compileBatchId,
    submittedAt: Date.now(),
    customId,
    retryCount: 0,
    testMode: state.testMode,
  };
  await env.DIGEST_KV.put(`batch:compile:${date}`, JSON.stringify(compileState), {
    expirationTtl: PHASE1_TTL_SECONDS,
  });
  await env.DIGEST_KV.put('digest:stageBSuccess', date, { expirationTtl: PHASE1_TTL_SECONDS });

  await env.DIGEST_QUEUE.send(
    { kind: 'poll-compile', date, attempt: 1, testMode: state.testMode || undefined },
    { delaySeconds: state.testMode ? 30 : 300 },
  );
  console.log(`[StageB] Enqueued first poll-compile`);
}

// Stage C core: poll the day's Sonnet compile batch and either re-enqueue
// or run assembleAll + send. Returns true when done (ack), false when
// re-enqueued.
async function pollCompileOnce(env: Env, date: string, attempt: number, testMode: boolean): Promise<boolean> {
  const lastSuccess = await env.DIGEST_KV.get('digest:lastSuccess');
  if (lastSuccess === date) {
    console.log(`[PollCompile] digest:lastSuccess=${date} — already shipped, skipping`);
    return true;
  }

  const stateRaw = await env.DIGEST_KV.get(`batch:compile:${date}`);
  if (!stateRaw) {
    throw new Error(`[PollCompile] No batch:compile:${date} in KV — Stage B never ran`);
  }
  const state = JSON.parse(stateRaw) as CompileBatchState;

  const status = await getBatchStatus(env, state.batchId);
  const elapsedMs = Date.now() - state.submittedAt;
  console.log(
    `[PollCompile] attempt=${attempt} batchId=${state.batchId} status=${status.processing_status} ` +
      `processing=${status.request_counts.processing} succeeded=${status.request_counts.succeeded} ` +
      `errored=${status.request_counts.errored} elapsedMin=${Math.round(elapsedMs / 60000)}`,
  );

  if (status.processing_status === 'in_progress' || status.processing_status === 'canceling') {
    await env.DIGEST_QUEUE.send(
      { kind: 'poll-compile', date, attempt: attempt + 1, testMode: testMode || undefined },
      { delaySeconds: sonnetRepollDelaySeconds(elapsedMs, testMode) },
    );
    return false;
  }

  // status === 'ended' — fetch the single result.
  const results = await getBatchResults(env, state.batchId);
  const record = results.get(state.customId);
  if (!record) {
    throw new Error(`[PollCompile] No result for ${state.customId} in batch ${state.batchId}`);
  }

  if (record.result.type !== 'succeeded') {
    if (state.retryCount >= 1) {
      const msg =
        `[PollCompile] ABORTING — Sonnet compile batch errored twice ` +
        `(date=${date}, batchId=${state.batchId}, last result=${record.result.type})`;
      console.error(msg);
      await sendErrorEmail(env, msg).catch(() => undefined);
      return true;
    }
    // First failure — resubmit the same prompt as a fresh batch.
    console.warn(`[PollCompile] Sonnet result=${record.result.type}, resubmitting once`);
    await resubmitCompileBatch(env, date, state, testMode);
    return false;
  }

  // Succeeded: extract structured input directly (API server already validated
  // it against DIGEST_JSON_SCHEMA), assemble, send.
  const structured = extractToolUseInput<StructuredDigest>(record, STRUCTURED_TOOL_NAME);
  console.log(
    `[PollCompile] structured shape: sectionsType=${typeof (structured as { sections?: unknown }).sections} ` +
      `sectionsLen=${Array.isArray((structured as { sections?: unknown }).sections) ? (structured as { sections: unknown[] }).sections.length : 'n/a'} ` +
      `topKeys=[${Object.keys(structured as object).join(',')}]`,
  );
  await runStageCSendDigest(env, date, structured, !!testMode);
  return true;
}

async function resubmitCompileBatch(
  env: Env,
  date: string,
  state: CompileBatchState,
  testMode: boolean,
): Promise<void> {
  const phase1Raw = await env.DIGEST_KV.get(`phase1:${date}`);
  if (!phase1Raw) {
    throw new Error(`[PollCompile] Cannot resubmit — phase1:${date} missing from KV`);
  }
  const phase1 = JSON.parse(phase1Raw) as Phase1Output;
  const compilePrompt = buildStructuredCompilationPrompt(
    phase1.selectedInput,
    phase1.markets,
    { total: phase1.feedStats.total, failed: phase1.feedStats.failed },
  );
  const customId = customIdForCompile(date);
  const { id: newBatchId } = await submitBatch(env, [{
    custom_id: customId,
    params: {
      model: SONNET_BATCH_MODEL,
      max_tokens: 32000,
      messages: [{ role: 'user', content: compilePrompt }],
      tools: [{
        name: STRUCTURED_TOOL_NAME,
        description: 'Emit the structured digest output. The model MUST invoke this tool — its `input` is parsed and used directly downstream.',
        input_schema: DIGEST_JSON_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
    },
  }]);
  const newState: CompileBatchState = {
    batchId: newBatchId,
    submittedAt: Date.now(),
    customId,
    retryCount: state.retryCount + 1,
    testMode: state.testMode,
  };
  await env.DIGEST_KV.put(`batch:compile:${date}`, JSON.stringify(newState), {
    expirationTtl: PHASE1_TTL_SECONDS,
  });
  await env.DIGEST_QUEUE.send(
    { kind: 'poll-compile', date, attempt: 1, testMode: testMode || undefined },
    { delaySeconds: testMode ? 30 : 180 },
  );
  console.log(`[PollCompile] Resubmitted Sonnet batch ${newBatchId} (retry=${newState.retryCount})`);
}

// Stage C terminal step: assemble the four markdown forms from the
// structured Sonnet output and dispatch emails. Mirrors the runPhase2
// post-compile flow.
async function runStageCSendDigest(
  env: Env,
  date: string,
  structured: StructuredDigest,
  testMode: boolean,
): Promise<void> {
  const phase1Raw = await env.DIGEST_KV.get(`phase1:${date}`);
  if (!phase1Raw) {
    throw new Error(`[StageC] phase1:${date} missing — Stage B did not write it`);
  }
  const phase1 = JSON.parse(phase1Raw) as Phase1Output;

  const assembled = assembleAll(structured, assembleOptionsFor(phase1));
  console.log(
    `[StageC] Assembled — EN ${assembled.fullDigestEn.length}c / PL ${assembled.fullDigestPl.length}c, ` +
      `briefings EN ${assembled.briefingEn.length}c / PL ${assembled.briefingPl.length}c`,
  );

  await persistDigest(env, phase1, {
    digestMarkdown: assembled.fullDigestEn,
    emailMarkdown: assembled.briefingEn,
    digestMarkdownPl: assembled.fullDigestPl,
    emailMarkdownPl: assembled.briefingPl,
    structuredDigest: JSON.stringify(structured),
  });

  let inlineImage: InlineImage | undefined;
  if (env.ENABLE_DIGEST_IMAGE === 'true') {
    const img = await generateDigestImage(env, assembled.briefingEn).catch(err => {
      console.log(`[StageC] Image generation threw (non-fatal): ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (img) inlineImage = img;
  }

  await sendAllEmails(env, assembled.briefingEn, assembled.briefingPl, {
    testMode,
    inlineImage,
    interestItems: phase1.interestItems,
  });

  try {
    await env.DIGEST_KV.put('digest:lastSuccess', date);
  } catch (err) {
    console.error(`[StageC] Heartbeat write failed (non-fatal): ${err}`);
  }
  await pingExternalHeartbeat(env);
  console.log(`[StageC] Complete for ${date}`);
}

// Cron fallback wrappers — invoked at 01 UTC and 03 UTC. They never call the
// poll handlers directly. Instead they enqueue a fresh poll message: the
// queue's max_concurrency=1 serializes handler runs, and the in-handler
// stageBSuccess / lastSuccess guards make duplicate enqueues safe. A direct
// sync poll could race a concurrently-running queue handler and double-submit
// the Sonnet batch.
async function checkpointStageB(env: Env, date: string): Promise<void> {
  const stageBDone = await env.DIGEST_KV.get('digest:stageBSuccess');
  if (stageBDone === date) {
    console.log(`[Checkpoint01] Stage B already done for ${date}`);
    return;
  }
  const stateRaw = await env.DIGEST_KV.get(`batch:classify:${date}`);
  if (!stateRaw) {
    console.warn(`[Checkpoint01] No batch:classify:${date} — Stage A never ran today`);
    return;
  }
  const state = JSON.parse(stateRaw) as ClassifyBatchState;
  await env.DIGEST_QUEUE.send({
    kind: 'poll-classify',
    date,
    attempt: 0,
    testMode: state.testMode || undefined,
  });
  console.log(`[Checkpoint01] Re-enqueued poll-classify for ${date}`);
}

async function checkpointStageC(env: Env, date: string): Promise<void> {
  const lastSuccess = await env.DIGEST_KV.get('digest:lastSuccess');
  if (lastSuccess === date) {
    console.log(`[Checkpoint03] Already shipped for ${date}`);
    return;
  }
  const stateRaw = await env.DIGEST_KV.get(`batch:compile:${date}`);
  if (!stateRaw) {
    console.warn(`[Checkpoint03] No batch:compile:${date} — Stage B never ran today`);
    return;
  }
  const state = JSON.parse(stateRaw) as CompileBatchState;
  await env.DIGEST_QUEUE.send({
    kind: 'poll-compile',
    date,
    attempt: 0,
    testMode: state.testMode || undefined,
  });
  console.log(`[Checkpoint03] Re-enqueued poll-compile for ${date}`);
}

// GET the monitor URL on Phase 2 success. Silent no-op if not configured;
// logs but doesn't throw if the ping fails — a failed ping must never cause
// us to mark Phase 2 as failed.
async function pingExternalHeartbeat(env: Env): Promise<void> {
  if (!env.HEARTBEAT_URL) return;
  try {
    const res = await fetch(env.HEARTBEAT_URL, {
      method: 'GET',
      // 10s cap — the worker has already done its job; a slow monitor must
      // not hold up our invocation's wall time.
      signal: AbortSignal.timeout(10_000),
    });
    console.log(`[Heartbeat] External ping → HTTP ${res.status}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Heartbeat] External ping failed (non-fatal): ${msg}`);
  }
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

// Write digest:{date} + digest:latest, optionally with the markdown / Polish
// markdown / structured-digest fields populated.
interface PersistPartial {
  digestMarkdown?: string;
  emailMarkdown?: string;
  digestMarkdownPl?: string;
  emailMarkdownPl?: string;
  structuredDigest?: string;
}

async function persistDigest(
  env: Env,
  phase1: Phase1Output,
  partial: PersistPartial,
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
    ...(partial.digestMarkdownPl ? { digestMarkdownPl: partial.digestMarkdownPl } : {}),
    ...(partial.emailMarkdownPl ? { emailMarkdownPl: partial.emailMarkdownPl } : {}),
    ...(partial.structuredDigest ? { structuredDigest: partial.structuredDigest } : {}),
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
  // Attached only on the send to EMAIL_TO (owner). Polish recipients never
  // receive it. Generated once per Phase 2 run; resends skip image generation.
  inlineImage?: InlineImage;
  // Per-interest curated picks from Phase 1 (cycling, etc.). renderInterestsFor
  // in src/interests.ts decides per-recipient whether a block is appended —
  // absent / empty means no recipient gets a per-person section.
  interestItems?: Record<string, CuratedInterestItem[]>;
}

// Dispatch the English digest + every Polish recipient. Used by both the
// cron path (via runPhase2) and the manual /resend endpoint. Both briefings
// are pre-computed by the structured-output compile path; the legacy chain
// produces them up front too.
interface DigestRecipient {
  email: string;
  name: string;
  lang: SubscriberLang;
}

/**
 * Union hardcoded recipients (config.ts) with active KV subscribers, then
 * subtract anyone in the suppression overlay. Called once per send — cheap
 * at expected scale (~20-100 recipients, ~3 KV reads per email).
 */
async function resolveDigestRecipients(
  env: Env,
  lang: SubscriberLang,
): Promise<DigestRecipient[]> {
  const hardcoded: DigestRecipient[] = lang === 'pl'
    ? EMAIL_TO_PL.map(r => ({ email: normalizeEmail(r.email), name: r.name, lang: 'pl' }))
    : [{ email: normalizeEmail(EMAIL_TO.email), name: EMAIL_TO.name, lang: 'en' }];

  const kv = await listActiveSubscribers(env, lang);
  const kvEmails = new Set(kv.map(s => s.email));
  const hardcodedMinusKv = hardcoded.filter(r => !kvEmails.has(r.email));

  const unioned: DigestRecipient[] = [
    ...hardcodedMinusKv,
    ...kv.map(s => ({
      email: s.email,
      name: s.name && s.name.trim().length > 0 ? s.name : s.email,
      lang,
    } as DigestRecipient)),
  ];

  if (unioned.length === 0) return unioned;

  const suppressed = await loadSuppressionSet(env, unioned.map(r => r.email));
  return unioned.filter(r => !suppressed.has(r.email));
}

async function sendAllEmails(
  env: Env,
  emailBriefing: string,
  polishBriefing: string,
  opts: SendOptions = {},
): Promise<void> {
  const today = new Date();
  const plDateStr = today.toLocaleDateString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const plSubject = `Codzienny Przegląd Wiadomości — ${plDateStr}`;

  const baselineLabel = BASELINE_CONFIG.label;
  const ownerEmail = normalizeEmail(EMAIL_TO.email);
  const imageForOwner = (email: string): InlineImage | undefined =>
    opts.inlineImage && normalizeEmail(email) === ownerEmail ? opts.inlineImage : undefined;

  // English-only per-person interest injection. Appends a curated subsection
  // (e.g. 🚴 Cycling) for recipients in SUBSCRIBER_INTERESTS; everyone else
  // receives the untouched briefing.
  const enBriefingFor = (email: string): string =>
    emailBriefing + renderInterestsFor(email, opts.interestItems);

  // Only-one-recipient override: send a single message in whichever language
  // matches the recipient list. English by default unless they're in EMAIL_TO_PL
  // or their KV subscriber record is 'pl'.
  if (opts.onlyTo) {
    const normTo = normalizeEmail(opts.onlyTo.email);
    const isHardcodedPl = EMAIL_TO_PL.some(r => normalizeEmail(r.email) === normTo);
    const kvPlEmails = new Set((await listActiveSubscribers(env, 'pl')).map(s => s.email));
    const isPl = isHardcodedPl || kvPlEmails.has(normTo);
    const unsubLang: SubscriberLang = isPl ? 'pl' : 'en';
    const unsubToken = await deriveUnsubToken(env, normTo, unsubLang);
    if (isPl) {
      await sendDigestEmail(env, polishBriefing, undefined, opts.onlyTo, plSubject, baselineLabel, unsubToken);
    } else {
      await sendDigestEmail(env, enBriefingFor(opts.onlyTo.email), undefined, opts.onlyTo, undefined, baselineLabel, unsubToken, imageForOwner(opts.onlyTo.email));
    }
    console.log(`[Email] Sent to single recipient ${opts.onlyTo.email}`);
    return;
  }

  const [enList, plList] = await Promise.all([
    resolveDigestRecipients(env, 'en'),
    resolveDigestRecipients(env, 'pl'),
  ]);

  if (opts.testMode) {
    console.log('[Email] Test mode — sending only to Filip');
    const filip: DigestRecipient = { email: normalizeEmail(EMAIL_TO.email), name: EMAIL_TO.name, lang: 'en' };
    const unsubToken = await deriveUnsubToken(env, filip.email, 'en');
    await sendDigestEmail(env, enBriefingFor(filip.email), undefined, filip, undefined, baselineLabel, unsubToken, imageForOwner(filip.email));
    return;
  }

  const enTasks: Promise<void>[] = [];
  for (const recipient of enList) {
    const unsubToken = await deriveUnsubToken(env, recipient.email, 'en');
    const image = imageForOwner(recipient.email);
    const send = () => sendDigestEmail(
      env,
      enBriefingFor(recipient.email),
      undefined,
      { email: recipient.email, name: recipient.name },
      undefined,
      baselineLabel,
      unsubToken,
      image,
    );
    enTasks.push(
      send().catch(async () => {
        console.log(`[Email] English to ${recipient.email} failed, retrying once...`);
        await send();
      }),
    );
  }
  await Promise.all(enTasks);
  console.log(`[Email] English emails dispatched (${enList.length} recipients)`);

  if (!polishBriefing) {
    console.log('[Email] No Polish briefing — skipping PL recipients');
    return;
  }

  const plTasks: Promise<void>[] = [];
  for (const recipient of plList) {
    const unsubToken = await deriveUnsubToken(env, recipient.email, 'pl');
    const send = () => sendDigestEmail(
      env,
      polishBriefing,
      undefined,
      { email: recipient.email, name: recipient.name },
      plSubject,
      baselineLabel,
      unsubToken,
    );
    plTasks.push(
      send().catch(async () => {
        console.log(`[Email] Polish to ${recipient.email} failed, retrying once...`);
        await send();
      }),
    );
  }
  await Promise.all(plTasks);
  console.log(`[Email] All Polish emails dispatched (${plList.length} recipients)`);
}

async function translateToPolish(
  env: Env,
  config: VariantConfig,
  emailBriefing: string,
): Promise<string> {
  try {
    const provider = resolveProvider(config, 'standard');
    const translated = await provider.call(env, 'standard', buildTranslationPrompt(emailBriefing), 16000);
    console.log(`[Email] Polish translation (${config.id}): ${translated.length} characters`);
    return translated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[Email] Polish translation (${config.id}) failed, falling back to English: ${msg}`);
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
  // The day for which we should ship a digest is "today UTC" at 23:00 cron
  // boundary too — Stage A submits a batch for the next morning's edition,
  // and todayUtc() at 23:00 is already the date the email will carry.
  const today = todayUtc();

  if (event.cron === '30 4 * * *') {
    // Watchdog: 30 min after the latest planned cron. A separate invocation
    // with its own 15-min budget, so it runs cleanly even if earlier crons
    // were killed by the platform.
    await runWatchdog(env, today);
    return;
  }

  if (event.cron === '0 23 * * *') {
    // Stage A — fetch RSS, submit Haiku classification batch, enqueue first
    // poll-classify. Use tomorrow's UTC date because the email ships at ~03
    // UTC the next morning; labeling it with today (the cron's UTC day) would
    // give recipients an email dated "yesterday".
    // Variants (currently disabled) still go through the legacy queue path.
    const digestDate = tomorrowUtc();
    try {
      await runStageA(env, digestDate);
      await enqueueVariants(env, digestDate);
      console.log(`[Pipeline] Stage A complete for ${digestDate}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Pipeline] Stage A failed: ${msg}`);
      await sendErrorEmail(env, `Stage A failed for ${digestDate}: ${msg}`).catch(() => undefined);
    }
    return;
  }

  if (event.cron === '0 1 * * *') {
    // Belt-and-suspenders: if poll-classify never ran (e.g. queue message lost),
    // run one poll iteration synchronously here. No-op if Stage B already done.
    await checkpointStageB(env, today);
    return;
  }

  if (event.cron === '0 3 * * *') {
    // Same idea for Stage C.
    await checkpointStageC(env, today);
    return;
  }

  console.warn(`[Pipeline] Unknown cron trigger: ${event.cron}`);
}

// Watchdog: silent if today's digest shipped, else emails frogaczewski@gmail.com
// with enough context to diagnose. Summarises which stage completed and points
// to the recovery endpoint so the fix is a one-liner.
async function runWatchdog(env: Env, today: string): Promise<void> {
  const lastSuccess = await env.DIGEST_KV.get('digest:lastSuccess');
  if (lastSuccess === today) {
    console.log(`[Watchdog] digest:lastSuccess == ${today} — healthy, no alarm`);
    return;
  }

  const stageA = await env.DIGEST_KV.get('digest:stageASuccess');
  const stageB = await env.DIGEST_KV.get('digest:stageBSuccess');
  const phase1 = await env.DIGEST_KV.get('digest:phase1Success');
  const stageADone = stageA === today;
  const stageBDone = stageB === today;
  const phase1Done = phase1 === today;

  const lines: string[] = [
    `The ${today} digest has NOT completed by 04:30 UTC.`,
    '',
    `digest:lastSuccess     = ${lastSuccess ?? '<unset>'}`,
    `digest:stageASuccess   = ${stageA ?? '<unset>'}`,
    `digest:stageBSuccess   = ${stageB ?? '<unset>'}`,
    `digest:phase1Success   = ${phase1 ?? '<unset>'}`,
    '',
  ];

  const baseUrl = 'https://ainewsworker.rogaczewski-dev.workers.dev';
  if (stageBDone || phase1Done) {
    lines.push(
      'Stage B succeeded — Sonnet compile is in flight or failed.',
      'Inspect batch:compile:{date} in KV; rerun Stage C:',
      `  curl -X POST "${baseUrl}/run-stage-c?date=${today}"`,
      '',
      'If the structured digest already landed and you just need to resend:',
      `  curl -X POST "${baseUrl}/resend"`,
    );
  } else if (stageADone) {
    lines.push(
      'Stage A succeeded — Haiku batch is still in flight, or Stage B failed.',
      'Inspect batch:classify:{date} in KV; force one Stage B poll iteration:',
      `  curl -X POST "${baseUrl}/run-stage-b?date=${today}"`,
    );
  } else {
    lines.push(
      'Stage A never completed today. The 23 UTC cron must have failed or',
      'been killed by the platform.',
      '',
      'Fastest recovery — submit the full batched pipeline now:',
      `  curl -X POST "${baseUrl}/run-stage-a?date=${today}"`,
      '',
      'Or fall back to the legacy synchronous flow:',
      `  curl -X POST --max-time 900 "${baseUrl}/run"`,
    );
  }

  const body = lines.join('\n');
  console.error(`[Watchdog] ALARM: ${body.split('\n')[0]}`);
  try {
    await sendErrorEmail(env, body);
    console.log('[Watchdog] Alarm email dispatched');
  } catch (err) {
    console.error(`[Watchdog] Alarm email failed: ${err}`);
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
        if (body.variant) {
          const config = VARIANT_CONFIGS[body.variant.configId];
          if (!config) {
            console.error(`[Queue] Unknown variant configId "${body.variant.configId}" — skipping`);
            msg.ack();
            continue;
          }
          console.log(`[Queue] variant "${config.id}" for ${body.date} → ${body.variant.recipient.email}`);
          await runVariantPipeline(env, config, body.date, body.variant.recipient);
        } else {
          console.log(`[Queue] compile-and-send for ${body.date} (testMode=${!!body.testMode})`);
          await runPhase2(env, body.date, { testMode: body.testMode });
        }
        msg.ack();
      } else if (body.kind === 'poll-classify') {
        // Always ack on success OR error — if we threw partway through Stage
        // B compose (e.g. after the Sonnet batch was submitted but before KV
        // state was persisted), a queue-driven retry would cause a duplicate
        // Sonnet submission. The 01/03 UTC cron fallbacks pick up missed work.
        console.log(`[Queue] poll-classify for ${body.date} (attempt=${body.attempt}, testMode=${!!body.testMode})`);
        try {
          await pollClassifyOnce(env, body.date, body.attempt, !!body.testMode);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Queue] poll-classify threw for ${body.date}: ${errMsg}`);
          await sendErrorEmail(env, `[poll-classify] ${body.date}: ${errMsg}`).catch(() => undefined);
        }
        msg.ack();
      } else if (body.kind === 'poll-compile') {
        console.log(`[Queue] poll-compile for ${body.date} (attempt=${body.attempt}, testMode=${!!body.testMode})`);
        try {
          await pollCompileOnce(env, body.date, body.attempt, !!body.testMode);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[Queue] poll-compile threw for ${body.date}: ${errMsg}`);
          await sendErrorEmail(env, `[poll-compile] ${body.date}: ${errMsg}`).catch(() => undefined);
        }
        msg.ack();
      } else if (body.kind === 'resend') {
        console.log(`[Queue] resend for ${body.date} (testMode=${!!body.testMode}, onlyTo=${body.onlyTo?.email ?? 'all'})`);
        const cached = await env.DIGEST_KV.get(`digest:${body.date}`);
        if (!cached) throw new Error(`No digest:${body.date} in KV`);
        const data = JSON.parse(cached) as DigestData;
        if (!data.emailMarkdown) throw new Error(`digest:${body.date} has no emailMarkdown`);
        // Polish: prefer the persisted Polish briefing (structured path) but
        // translate on demand if the cached digest predates the structured
        // refactor.
        const polish = data.emailMarkdownPl
          ?? await translateToPolish(env, BASELINE_CONFIG, data.emailMarkdown);
        // Resend the original per-person interest picks too (if that day's Phase 1
        // wrote any). Missing phase1 record is fine — resend still works without them.
        let interestItems: Record<string, CuratedInterestItem[]> | undefined;
        const phase1Raw = await env.DIGEST_KV.get(`phase1:${body.date}`);
        if (phase1Raw) {
          try {
            interestItems = (JSON.parse(phase1Raw) as Phase1Output).interestItems;
          } catch {
            // ignore — resend continues without interest sections
          }
        }
        await sendAllEmails(env, data.emailMarkdown, polish, {
          testMode: body.testMode,
          onlyTo: body.onlyTo,
          interestItems,
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

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      const configParam = url.searchParams.get('config');
      const langParam = url.searchParams.get('lang');

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
          // ?config=X runs a full variant pipeline synchronously against the
          // named config (sent to EMAIL_TO, no KV writes). ?lang=en|pl picks
          // the output language (defaults to pl). Without config, the baseline
          // English sync test runs as before.
          if (configParam) {
            const config = VARIANT_CONFIGS[configParam];
            if (!config) {
              return new Response(
                JSON.stringify({
                  status: 'error',
                  error: `Unknown config "${configParam}". Available: ${Object.keys(VARIANT_CONFIGS).join(', ')}`,
                }),
                { status: 400, headers: JSON_HEADERS },
              );
            }
            if (langParam && langParam !== 'en' && langParam !== 'pl') {
              return new Response(
                JSON.stringify({ status: 'error', error: `Unknown lang "${langParam}". Use "en" or "pl".` }),
                { status: 400, headers: JSON_HEADERS },
              );
            }
            const language = (langParam as 'en' | 'pl' | null) ?? 'pl';
            await runTestVariant(env, config, language);
            return new Response(
              JSON.stringify({ status: 'success', test: true, config: config.id, label: config.label, lang: language }),
              { headers: JSON_HEADERS },
            );
          }
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
        await enqueueVariants(env, phase1.date);
        return new Response(
          JSON.stringify({
            status: 'success',
            phase1: `phase1-complete:${phase1.triagedStories.length}`,
            phase2: 'enqueued',
            variants: listEnabledVariantConfigs(env).map(c => c.id),
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

    // POST /run-stage-a — manually kick off Stage A (fetch + submit Haiku
    // batch). Idempotent: skips if today's batch:classify already exists.
    //   ?date=YYYY-MM-DD     → override date (defaults to todayUtc()).
    //   ?test=true           → testMode: compressed polling, [TEST] email only.
    if (url.pathname === '/run-stage-a' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      const testMode = url.searchParams.get('test') === 'true';
      try {
        await runStageA(env, date, { testMode });
        return new Response(JSON.stringify({ status: 'submitted', date, testMode }), { headers: JSON_HEADERS });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

    // POST /run-stage-b — synchronously run one poll-classify iteration.
    // Useful when poll-classify never fired (lost queue message) or to nudge
    // a stuck classify batch.
    //   ?date=YYYY-MM-DD     → override date.
    if (url.pathname === '/run-stage-b' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      try {
        const stateRaw = await env.DIGEST_KV.get(`batch:classify:${date}`);
        if (!stateRaw) {
          return new Response(
            JSON.stringify({ status: 'not-found', error: `No batch:classify:${date} — run /run-stage-a first` }),
            { status: 404, headers: JSON_HEADERS },
          );
        }
        const state = JSON.parse(stateRaw) as ClassifyBatchState;
        const done = await pollClassifyOnce(env, date, 0, !!state.testMode);
        return new Response(JSON.stringify({ status: done ? 'done' : 'in-progress', date }), { headers: JSON_HEADERS });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

    // POST /run-stage-c — synchronously run one poll-compile iteration.
    //   ?date=YYYY-MM-DD     → override date.
    if (url.pathname === '/run-stage-c' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      try {
        const stateRaw = await env.DIGEST_KV.get(`batch:compile:${date}`);
        if (!stateRaw) {
          return new Response(
            JSON.stringify({ status: 'not-found', error: `No batch:compile:${date} — Stage B hasn't run` }),
            { status: 404, headers: JSON_HEADERS },
          );
        }
        const state = JSON.parse(stateRaw) as CompileBatchState;
        const done = await pollCompileOnce(env, date, 0, !!state.testMode);
        return new Response(JSON.stringify({ status: done ? 'done' : 'in-progress', date }), { headers: JSON_HEADERS });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new Response(JSON.stringify({ status: 'error', error: message }), {
          status: 500,
          headers: JSON_HEADERS,
        });
      }
    }

    // POST /test-batched-pipeline — kick off the full A→B→C pipeline in
    // testMode. Polling delays are scaled to 0.1× so the whole flow fits in
    // ~10–25 min of wall clock. Email goes only to Filip with [TEST] subject.
    if (url.pathname === '/test-batched-pipeline' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? todayUtc();
      try {
        await runStageA(env, date, { testMode: true });
        return new Response(
          JSON.stringify({ status: 'submitted', date, testMode: true, note: 'poll-classify will run in 30s; check /run-stage-b or wait for self-poll' }),
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
          const polish = data.emailMarkdownPl
            ?? await translateToPolish(env, BASELINE_CONFIG, data.emailMarkdown);
          let interestItems: Record<string, CuratedInterestItem[]> | undefined;
          const phase1Raw = await env.DIGEST_KV.get(`phase1:${date}`);
          if (phase1Raw) {
            try {
              interestItems = (JSON.parse(phase1Raw) as Phase1Output).interestItems;
            } catch {
              // ignore — sync resend continues without interest sections
            }
          }
          await sendAllEmails(env, data.emailMarkdown, polish, { testMode, onlyTo, interestItems });
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

    // ── Subscribe / unsubscribe endpoints ────────────────────────────────────
    // Double-opt-in subscribe flow:
    //   POST /api/subscribe         → pending record + confirmation email
    //   GET  /confirm               → moves pending → active
    // Double-opt-out unsubscribe:
    //   GET  /unsubscribe           → page 1, shows confirm button (HMAC-verified)
    //   POST /api/unsubscribe       → sends a second confirmation email
    //   GET  /finalize-unsubscribe  → completes the unsubscribe, sets suppress
    //
    // Responses to /api/subscribe are intentionally uniform ("check your inbox")
    // regardless of whether the email was new, pending, active, or suppressed,
    // so this endpoint cannot be used to enumerate subscribers. CSRF is not
    // mitigated because double-opt-in requires inbox access to complete — an
    // attacker can only cause a confirmation email to be sent, which is the
    // exact scenario the flow is designed for.

    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      try {
        const { email, lang, name, website, isForm } = await parseSubscribeBody(request);

        if (website && website.trim().length > 0) {
          // Honeypot tripped — pretend success to avoid giving bots a signal.
          return subscribeCheckInboxResponse(email || 'your address', isForm);
        }
        if (!email || !isValidEmail(email)) {
          return isForm
            ? invalidRequestPage('That email address looks invalid. Please try again.')
            : jsonResponse({ status: 'error', error: 'invalid-email' }, 400);
        }
        if (!isValidLang(lang)) {
          return isForm
            ? invalidRequestPage('Please choose a language.')
            : jsonResponse({ status: 'error', error: 'invalid-lang' }, 400);
        }

        const normEmail = normalizeEmail(email);
        const ip = request.headers.get('CF-Connecting-IP');
        const ipCheck = await checkAndIncrementIpRateLimit(env, ip);
        if (!ipCheck.allowed) {
          return isForm ? rateLimitedPage() : jsonResponse({ status: 'error', error: 'rate-limited' }, 429);
        }

        const result = await startSubscribe(env, normEmail, lang, name);

        // Send the confirmation email out-of-band so the form response comes
        // back immediately. Only send for newly-created/refreshed records —
        // silent no-op for already-active (enumeration resistance).
        if (result.action !== 'already-active' && result.pending) {
          const pending = result.pending;
          ctx.waitUntil(
            sendSubscribeConfirmEmail(env, pending.email, pending.name, pending.lang, pending.confirmToken).catch(err => {
              console.error(`[Subscribe] Confirm email to ${pending.email} failed: ${err}`);
            }),
          );
        } else {
          console.log(`[Subscribe] Silent no-op for ${normEmail} — already active`);
        }

        // Global rate-limit counter + alarm. Run in waitUntil so the user is
        // never blocked on the alarm path.
        ctx.waitUntil((async () => {
          try {
            const count = await incrementGlobalSubscribeCounter(env);
            if (await shouldFireAlarm(env, count)) {
              const windowLabel = new Date().toISOString().slice(0, 13);
              console.log(`[Subscribe] ALARM: ${count} subscribes in window ${windowLabel}`);
              await sendRateLimitAlarmEmail(env, { globalCount: count, windowLabel });
            }
          } catch (err) {
            console.error(`[Subscribe] Global counter/alarm error: ${err}`);
          }
        })());

        return subscribeCheckInboxResponse(normEmail, isForm);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Subscribe] Error: ${msg}`);
        return jsonResponse({ status: 'error', error: 'internal' }, 500);
      }
    }

    if (url.pathname === '/confirm' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return confirmInvalidPage();
      try {
        const result = await confirmSubscriber(env, token);
        if (result.status === 'ok' && result.subscriber) {
          return confirmSuccessPage(result.subscriber.email, result.subscriber.lang);
        }
        return confirmInvalidPage();
      } catch (err) {
        console.error(`[Confirm] Error: ${err}`);
        return genericErrorPage('We could not confirm your subscription. Please try subscribing again.');
      }
    }

    if (url.pathname === '/unsubscribe' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return unsubscribeInvalidPage();
      try {
        const target = await verifyUnsubToken(env, token);
        if (!target) return unsubscribeInvalidPage();
        return unsubscribeConfirmPage(token, target.email);
      } catch (err) {
        console.error(`[Unsubscribe page] Error: ${err}`);
        return genericErrorPage('We could not load the unsubscribe page. Please try again.');
      }
    }

    if (url.pathname === '/api/unsubscribe' && request.method === 'POST') {
      try {
        const token = await parseUnsubscribeBody(request);
        if (!token) return unsubscribeInvalidPage();

        const tokenRate = await checkAndIncrementUnsubTokenRateLimit(env, token);
        if (!tokenRate.allowed) {
          return rateLimitedPage();
        }

        const target = await verifyUnsubToken(env, token);
        if (!target) return unsubscribeInvalidPage();

        const confirmToken = await createUnsubConfirmToken(env, target.email, target.lang);
        ctx.waitUntil(
          sendUnsubscribeConfirmEmail(env, target.email, target.lang, confirmToken).catch(err => {
            console.error(`[Unsubscribe] Confirm email to ${target.email} failed: ${err}`);
          }),
        );
        return unsubscribeSentPage();
      } catch (err) {
        console.error(`[Unsubscribe POST] Error: ${err}`);
        return genericErrorPage('We could not process your unsubscribe request. Please try again.');
      }
    }

    if (url.pathname === '/finalize-unsubscribe' && request.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return unsubscribeInvalidPage();
      try {
        const result = await finalizeUnsubscribe(env, token);
        if (result.status === 'ok' && result.email) {
          return finalizeSuccessPage(result.email);
        }
        return unsubscribeInvalidPage();
      } catch (err) {
        console.error(`[Finalize unsubscribe] Error: ${err}`);
        return genericErrorPage('We could not complete your unsubscribe. Please try again.');
      }
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Subscribe endpoint helpers ─────────────────────────────────────────────

interface SubscribeInput {
  email: string;
  lang: string;
  name?: string;
  website?: string;
  isForm: boolean;
}

async function parseSubscribeBody(request: Request): Promise<SubscribeInput> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as Partial<SubscribeInput>;
    return {
      email: String(body.email ?? '').trim(),
      lang: String(body.lang ?? ''),
      name: body.name ? String(body.name) : undefined,
      website: body.website ? String(body.website) : undefined,
      isForm: false,
    };
  }
  // Treat everything else (including application/x-www-form-urlencoded and
  // multipart/form-data) as a browser form submission.
  const form = await request.formData();
  return {
    email: String(form.get('email') ?? '').trim(),
    lang: String(form.get('lang') ?? ''),
    name: form.get('name') ? String(form.get('name')) : undefined,
    website: form.get('website') ? String(form.get('website')) : undefined,
    isForm: true,
  };
}

async function parseUnsubscribeBody(request: Request): Promise<string | null> {
  const contentType = request.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    const body = (await request.json()) as { token?: string };
    return body.token ?? null;
  }
  const form = await request.formData();
  const t = form.get('token');
  return t ? String(t) : null;
}

function subscribeCheckInboxResponse(email: string, isForm: boolean): Response {
  if (isForm) return checkInboxPage(email);
  return jsonResponse({ status: 'ok', message: 'Check your inbox to confirm.' });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
