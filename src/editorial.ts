// Editorial editions: the daily quick-hit (Sun–Fri) and the Saturday weekly.
//
// Replaces the section-quota selection (classify.ts:selectForDigest) for the
// batched pipeline. The old flow judged each item in isolation and then filled
// fixed per-country buckets, so a quiet day still produced four Polish
// construction-sector op-eds, a Cypriot workplace accident and Nepali court
// gossip — while a story covered by six outlets showed up as six near-dupes or
// as one arbitrary outlet. This flow works on EVENTS instead of items:
//
//   classified items ──► cluster into events (one Opus call, structured output)
//                    ──► score each event by importance + how many outlets in
//                        how many regions covered it (+ Polish relevance)
//                    ──► candidates ──► Opus editor picks, orders, writes EN+PL
//
// Clusters are persisted per day (`clusters:{date}`) so the Saturday weekly can
// link a week of daily events into storylines.

import { regionForSource } from './config';
import { createStructuredMessage } from './providers/anthropic';
import { buildClusterPrompt, buildDailyEditionPrompt, buildWeeklyEditionPrompt } from './prompts';
import { urlDedupAndDropLow } from './classify';
import type {
  BilingualText,
  ClassifiedItem,
  ClusterItem,
  DailyEdition,
  DailySectionKind,
  EditionStory,
  Env,
  MarketData,
  Phase1Output,
  StoryCluster,
  TriagedStory,
  WeatherData,
  WeeklyEdition,
  WeeklyStory,
} from './types';

export const EDITORIAL_MODEL = 'claude-opus-5-5';
// Used for the one resubmit after a refusal / truncation / error. Batches don't
// accept the server-side `fallbacks` parameter, so we swap models ourselves.
export const EDITORIAL_FALLBACK_MODEL = 'claude-opus-4-8';

export const CLUSTERS_TTL_SECONDS = 14 * 24 * 60 * 60;
// How many clusters per day to keep in `clusters:{date}` for the weekly.
const CLUSTERS_PERSIST_LIMIT = 150;
// Upper bound on items sent to the clustering call (~35 tokens each).
const CLUSTER_INPUT_LIMIT = 900;

// ──────────────────────────────────────────────────────────────────────────────
// Clustering
// ──────────────────────────────────────────────────────────────────────────────

const CLUSTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'items'],
        properties: {
          label: { type: 'string' },
          items: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
  },
} as const;

const IMPORTANCE_RANK = { high: 0, medium: 1, low: 2 } as const;

function eventOf(item: ClassifiedItem): string {
  return (item.event || item.headline || '').trim();
}

// Group a day's classified items into events and rank them. Never throws: if
// the clustering call fails, items are grouped by identical event label only
// (still better than nothing) and the pipeline carries on.
export async function buildClusters(env: Env, date: string, classified: ClassifiedItem[]): Promise<StoryCluster[]> {
  // Drops 'low' + 'stale_commentary' and merges identical URLs.
  const pool = urlDedupAndDropLow(classified)
    .sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance])
    .slice(0, CLUSTER_INPUT_LIMIT);

  let groups: number[][] = [];
  const labels = new Map<number, string>(); // group root index → label
  try {
    const result = await createStructuredMessage<{ groups: { label: string; items: number[] }[] }>(env, {
      model: EDITORIAL_MODEL,
      prompt: buildClusterPrompt(pool.map(it => ({ source: it.source, event: eventOf(it), headline: it.headline }))),
      schema: CLUSTER_SCHEMA,
      maxTokens: 32000,
      effort: 'low',
    });
    for (const g of result.groups ?? []) {
      const members = [...new Set(g.items)].filter(i => Number.isInteger(i) && i >= 0 && i < pool.length);
      if (members.length < 2) continue;
      groups.push(members);
      labels.set(members[0], g.label);
    }
    console.log(`[Editorial] Clustered ${pool.length} items → ${groups.length} multi-outlet groups`);
  } catch (err) {
    console.log(`[Editorial] Clustering call failed, falling back to exact-label grouping: ${err instanceof Error ? err.message : err}`);
    const byLabel = new Map<string, number[]>();
    pool.forEach((it, i) => {
      const key = eventOf(it).toLowerCase();
      byLabel.set(key, [...(byLabel.get(key) ?? []), i]);
    });
    groups = [...byLabel.values()].filter(g => g.length > 1);
  }

  // Union-find so an index the model put in two groups merges them.
  const parent = pool.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const g of groups) for (const i of g.slice(1)) parent[find(i)] = find(g[0]);

  const members = new Map<number, number[]>();
  pool.forEach((_, i) => {
    const root = find(i);
    members.set(root, [...(members.get(root) ?? []), i]);
  });

  const clusters: StoryCluster[] = [];
  for (const idxs of members.values()) {
    const label = idxs.map(i => labels.get(i)).find(Boolean);
    clusters.push(clusterFromItems(idxs.map(i => pool[i]), label));
  }
  return finaliseClusters(clusters, date, '');
}

// Aggregate one event's items: one entry per outlet, signals unioned from the
// most important items, outlet regions interleaved so the first few items the
// prompt shows come from different parts of the world.
function clusterFromItems(items: ClassifiedItem[], label?: string): StoryCluster {
  const sorted = [...items].sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]);
  const importance = sorted[0].importance;
  const top = sorted.filter(it => it.importance === importance);

  const byOutlet = new Map<string, ClusterItem>();
  for (const it of sorted) {
    const candidates: ClusterItem[] = [{
      source: it.source,
      region: regionForSource(it.source),
      headline: it.headline,
      summary: it.summary,
      link: it.link,
      pubDate: it.pubDate,
      ...(it.imageUrl && { imageUrl: it.imageUrl }),
    }];
    // URL-dedup folded same-link reposts into all_sources; count those outlets too.
    for (const s of it.all_sources ?? []) {
      if (s.name !== it.source) {
        candidates.push({ source: s.name, region: regionForSource(s.name), headline: it.headline, summary: '', link: s.link, pubDate: it.pubDate });
      }
    }
    for (const c of candidates) {
      const existing = byOutlet.get(c.source);
      if (!existing || (!existing.summary && c.summary)) byOutlet.set(c.source, c);
    }
  }

  const byRegion = new Map<string, ClusterItem[]>();
  for (const ci of byOutlet.values()) byRegion.set(ci.region, [...(byRegion.get(ci.region) ?? []), ci]);
  const interleaved: ClusterItem[] = [];
  for (let round = 0; interleaved.length < byOutlet.size; round++) {
    for (const list of byRegion.values()) if (list[round]) interleaved.push(list[round]);
  }

  return {
    id: '',
    date: '',
    event: label || eventOf(sorted[0]),
    importance,
    country_tags: [...new Set(top.flatMap(it => it.country_tags ?? []))],
    category_tags: [...new Set(top.flatMap(it => it.category_tags ?? []))],
    outletCount: byOutlet.size,
    regionCount: byRegion.size,
    score: 0,
    items: interleaved,
  };
}

// Countries close enough to Poland that their news tends to land there.
const NEIGHBOURHOOD = new Set(['UA', 'RU', 'BY', 'DE', 'LT', 'CZ', 'SK', 'EU']);
const IMPORTANCE_POINTS = { high: 6, medium: 3, low: 0 } as const;

// The ranking signal: triage importance, plus coverage breadth (distinct
// outlets, log-scaled, and distinct outlet regions), plus relevance to a
// Polish reader. Cyprus- or Nepal-only stories sink unless triage called them
// high. The Opus editor makes the final call; this decides what it sees.
export function scoreCluster(c: Pick<StoryCluster, 'importance' | 'outletCount' | 'regionCount' | 'country_tags'>): number {
  let score = IMPORTANCE_POINTS[c.importance];
  score += 2.5 * Math.log2(1 + c.outletCount);
  score += 1.2 * Math.min(Math.max(c.regionCount - 1, 0), 5);
  const countries = new Set(c.country_tags);
  if (countries.has('PL')) score += 3;
  else if ([...countries].some(cc => NEIGHBOURHOOD.has(cc))) score += 1;
  const onlyCyNp = countries.size > 0 && [...countries].every(cc => cc === 'CY' || cc === 'NP');
  if (onlyCyNp && c.importance !== 'high') score -= 5;
  return Math.round(score * 10) / 10;
}

function finaliseClusters(clusters: StoryCluster[], date: string, idPrefix: string): StoryCluster[] {
  for (const c of clusters) c.score = scoreCluster(c);
  clusters.sort((a, b) => b.score - a.score);
  clusters.forEach((c, n) => {
    c.id = `${date}#${idPrefix}${n}`;
    c.date = date;
  });
  return clusters;
}

export function clustersForPersistence(clusters: StoryCluster[]): StoryCluster[] {
  return clusters.slice(0, CLUSTERS_PERSIST_LIMIT).map(c => ({ ...c, items: c.items.slice(0, 8) }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Candidate selection
// ──────────────────────────────────────────────────────────────────────────────

const isSport = (c: StoryCluster) => c.category_tags.includes('sports');
const isCulture = (c: StoryCluster) => c.category_tags.includes('culture') && !isSport(c);
const isPolish = (c: StoryCluster) => c.country_tags.includes('PL');

interface CandidateQuota { general: number; polish: number; sports: number; culture: number }

// Highest-scoring general news plus guaranteed slots for Polish news, sport
// and culture, so the editor can build those sections when they are worth it.
// Input must be score-sorted; output keeps score order.
function pickCandidates(clusters: StoryCluster[], quota: CandidateQuota): StoryCluster[] {
  const chosen = new Set<StoryCluster>();
  const take = (pred: (c: StoryCluster) => boolean, n: number) => {
    for (const c of clusters) {
      if (n <= 0) break;
      if (!chosen.has(c) && pred(c)) { chosen.add(c); n--; }
    }
  };
  take(c => !isSport(c) && !isCulture(c), quota.general);
  take(c => isPolish(c) && !isSport(c) && !isCulture(c), quota.polish);
  take(isSport, quota.sports);
  take(isCulture, quota.culture);
  return clusters.filter(c => chosen.has(c));
}

export function pickDailyCandidates(clusters: StoryCluster[]): StoryCluster[] {
  return pickCandidates(clusters, { general: 30, polish: 8, sports: 8, culture: 5 });
}

const WEEKLY_DAILY_QUOTA: CandidateQuota = { general: 22, polish: 5, sports: 3, culture: 2 };

// ──────────────────────────────────────────────────────────────────────────────
// Weekly: the week's clusters, day by day
// ──────────────────────────────────────────────────────────────────────────────

export function isWeeklyDate(date: string): boolean {
  return new Date(date + 'T12:00:00Z').getUTCDay() === 6;
}

function shiftDate(date: string, days: number): string {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// A digest dated D covers the news of D-1 (Stage A runs at 23 UTC the night before).
export function newsDayFor(digestDate: string): string {
  return shiftDate(digestDate, -1);
}

export interface WeekDay { date: string; newsDay: string; clusters: StoryCluster[] }

// The weekly dated Saturday D covers digests D-6 … D (news Saturday … Friday).
// Each past day comes from `clusters:{d}`; days that predate this pipeline fall
// back to that day's `phase1:{d}` selection (7-day TTL) so the first weekly
// after deploy still sees the whole week.
export async function loadWeek(env: Env, date: string, todayClusters: StoryCluster[]): Promise<WeekDay[]> {
  const days: WeekDay[] = [];
  for (let offset = -6; offset <= 0; offset++) {
    const d = shiftDate(date, offset);
    let clusters: StoryCluster[] = [];
    if (offset === 0) {
      clusters = todayClusters;
    } else {
      try {
        const raw = await env.DIGEST_KV.get(`clusters:${d}`);
        if (raw) {
          clusters = JSON.parse(raw) as StoryCluster[];
        } else {
          const p1 = await env.DIGEST_KV.get(`phase1:${d}`);
          if (p1) clusters = clustersFromLegacyPhase1(JSON.parse(p1) as Phase1Output, d);
        }
      } catch (err) {
        console.log(`[Weekly] Could not load ${d}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (clusters.length > 0) {
      days.push({ date: d, newsDay: newsDayFor(d), clusters: pickCandidates(clusters, WEEKLY_DAILY_QUOTA) });
    }
  }
  console.log(`[Weekly] Loaded ${days.length}/7 days: ${days.map(d => `${d.date}(${d.clusters.length})`).join(' ')}`);
  return days;
}

function clustersFromLegacyPhase1(phase1: Phase1Output, date: string): StoryCluster[] {
  if (phase1.clusters?.length) return phase1.clusters;
  // Legacy all_sources came from a deliberately over-merging dedup and carry no
  // summaries, so they can list outlets that covered a different event. Keep
  // only each story's own outlet rather than print wrong links under a storyline.
  const items = (phase1.selectedInput?.sections ?? []).flatMap(s => s.stories);
  const clusters = items.map(it => clusterFromItems([{ ...it, all_sources: undefined }]));
  return finaliseClusters(clusters, date, 'L');
}

// ──────────────────────────────────────────────────────────────────────────────
// Compile requests (Message Batches params, structured outputs)
// ──────────────────────────────────────────────────────────────────────────────

const BILINGUAL = {
  type: 'object',
  additionalProperties: false,
  required: ['en', 'pl'],
  properties: { en: { type: 'string' }, pl: { type: 'string' } },
} as const;

const SECTION_KINDS: DailySectionKind[] = ['top', 'poland', 'world', 'business', 'science_tech', 'sports', 'culture'];

const DAILY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'weatherAlert', 'marketNote'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'stories'],
        properties: {
          kind: { type: 'string', enum: SECTION_KINDS },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'headline', 'body', 'coverage'],
              properties: { id: { type: 'string' }, headline: BILINGUAL, body: BILINGUAL, coverage: BILINGUAL },
            },
          },
        },
      },
    },
    weatherAlert: BILINGUAL,
    marketNote: BILINGUAL,
  },
} as const;

const WEEKLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intro', 'stories', 'alsoThisWeek'],
  properties: {
    intro: BILINGUAL,
    stories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ids', 'headline', 'narrative', 'timeline', 'coverage'],
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
          headline: BILINGUAL,
          narrative: BILINGUAL,
          timeline: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['day', 'text'],
              properties: { day: { type: 'string' }, text: BILINGUAL },
            },
          },
          coverage: BILINGUAL,
        },
      },
    },
    alsoThisWeek: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ids', 'headline', 'text'],
        properties: { ids: { type: 'array', items: { type: 'string' } }, headline: BILINGUAL, text: BILINGUAL },
      },
    },
  },
} as const;

export function buildDailyRequest(
  candidates: StoryCluster[],
  weather: WeatherData[],
  markets: MarketData,
  date: string,
): Record<string, unknown> {
  return {
    model: EDITORIAL_MODEL,
    // Adaptive thinking is always on for Opus 5.5 and shares this budget.
    max_tokens: 32000,
    messages: [{ role: 'user', content: buildDailyEditionPrompt(candidates, weather, markets, date) }],
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: DAILY_SCHEMA } },
  };
}

export function buildWeeklyRequest(days: WeekDay[]): Record<string, unknown> {
  return {
    model: EDITORIAL_MODEL,
    // A test run on a real week used ~40k (thinking at effort high + ~12
    // bilingual storylines); batches have no HTTP timeout, so leave headroom.
    max_tokens: 100000,
    messages: [{ role: 'user', content: buildWeeklyEditionPrompt(days) }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: WEEKLY_SCHEMA } },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Output validation — structured outputs guarantee the shape; these guard the
// semantics (unknown / reused ids, empty sections) before rendering.
// ──────────────────────────────────────────────────────────────────────────────

function text(value: unknown): BilingualText {
  const v = (value ?? {}) as Partial<BilingualText>;
  const en = typeof v.en === 'string' ? v.en.trim() : '';
  const pl = typeof v.pl === 'string' ? v.pl.trim() : '';
  return { en: en || pl, pl: pl || en };
}

export function normaliseDailyEdition(raw: unknown, clusters: StoryCluster[]): DailyEdition {
  const known = new Set(clusters.map(c => c.id));
  const used = new Set<string>();
  const input = (raw ?? {}) as Partial<DailyEdition>;
  const sections: DailyEdition['sections'] = [];
  for (const s of input.sections ?? []) {
    if (!SECTION_KINDS.includes(s.kind)) continue;
    const stories: EditionStory[] = [];
    for (const st of s.stories ?? []) {
      if (!known.has(st.id) || used.has(st.id)) continue;
      used.add(st.id);
      stories.push({ id: st.id, headline: text(st.headline), body: text(st.body), coverage: text(st.coverage) });
    }
    if (stories.length === 0) continue;
    const existing = sections.find(x => x.kind === s.kind);
    if (existing) existing.stories.push(...stories);
    else sections.push({ kind: s.kind, stories });
  }
  // "top" leads, whatever order the model chose for the rest.
  sections.sort((a, b) => (a.kind === 'top' ? -1 : 0) - (b.kind === 'top' ? -1 : 0));
  return { sections, weatherAlert: text(input.weatherAlert), marketNote: text(input.marketNote) };
}

export function normaliseWeeklyEdition(raw: unknown, clusters: StoryCluster[]): WeeklyEdition {
  const known = new Set(clusters.map(c => c.id));
  const input = (raw ?? {}) as Partial<WeeklyEdition>;
  const ids = (list: unknown) => [...new Set(Array.isArray(list) ? list.filter((id): id is string => known.has(id)) : [])];
  const stories: WeeklyStory[] = (input.stories ?? []).map(st => ({
    ids: ids(st.ids),
    headline: text(st.headline),
    narrative: text(st.narrative),
    timeline: (st.timeline ?? []).map(t => ({ day: String(t.day ?? ''), text: text(t.text) })).sort((a, b) => a.day.localeCompare(b.day)),
    coverage: text(st.coverage),
  })).filter(st => st.headline.en && st.narrative.en);
  const alsoThisWeek = (input.alsoThisWeek ?? []).map(a => ({ ids: ids(a.ids), headline: text(a.headline), text: text(a.text) }))
    .filter(a => a.text.en);
  return { intro: text(input.intro), stories, alsoThisWeek };
}

// ──────────────────────────────────────────────────────────────────────────────
// Landing-page / KV helpers
// ──────────────────────────────────────────────────────────────────────────────

// Flatten clusters to the TriagedStory shape DigestData.stories expects
// (landing-page thumbnails, archive).
export function clustersToTriaged(clusters: StoryCluster[]): TriagedStory[] {
  return clusters.map(c => {
    const lead = c.items[0];
    const imageUrl = c.items.find(it => it.imageUrl)?.imageUrl;
    return {
      headline: lead?.headline ?? c.event,
      summary: lead?.summary ?? '',
      source: lead?.source ?? '',
      link: lead?.link ?? '',
      country_tags: c.country_tags,
      category_tags: c.category_tags,
      importance: c.importance === 'low' ? 'medium' : c.importance,
      duplicate_of: null,
      ...(imageUrl && { imageUrl }),
      all_sources: c.items.map(it => ({ name: it.source, link: it.link })),
    };
  });
}

export function storyImagesFor(clusters: StoryCluster[]): Record<string, string> {
  const images: Record<string, string> = {};
  for (const c of clusters) {
    for (const it of c.items) {
      if (!it.imageUrl || !it.link) continue;
      images[it.link] = it.imageUrl;
      const base = it.link.split('?')[0];
      if (base !== it.link) images[base] = it.imageUrl;
    }
  }
  return images;
}
