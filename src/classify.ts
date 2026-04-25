import { resolveProvider, type VariantConfig } from './providers';
import { buildClassificationPrompt, buildSemanticDedupPrompt } from './prompts';
import type {
  Env,
  RssItem,
  ClassifiedItem,
  SectionKey,
  SelectedDigestSection,
  SelectedDigestInput,
} from './types';

// ==============================================================================
// Stage 2: batched Haiku classification with per-batch KV checkpoints
// ==============================================================================

const BATCH_SIZE = 75;
const MAX_PARALLEL = 3;

export async function classifyInBatches(
  env: Env,
  config: VariantConfig,
  items: RssItem[],
  date: string,
): Promise<ClassifiedItem[]> {
  const batches: RssItem[][] = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    batches.push(items.slice(i, i + BATCH_SIZE));
  }
  console.log(`[Classify] Split ${items.length} items into ${batches.length} batches of up to ${BATCH_SIZE}`);

  const results: ClassifiedItem[][] = new Array(batches.length).fill(null).map(() => []);

  // Process batches in waves of MAX_PARALLEL. One wave's failure does not
  // kill others — allSettled means a bad batch contributes 0 items but the
  // pipeline continues.
  for (let wave = 0; wave < batches.length; wave += MAX_PARALLEL) {
    const waveBatches = batches.slice(wave, wave + MAX_PARALLEL);
    const waveIndices = waveBatches.map((_, j) => wave + j);

    const settled = await Promise.allSettled(
      waveBatches.map((batch, j) => classifyOneBatch(env, config, batch, waveIndices[j], date)),
    );

    for (let j = 0; j < settled.length; j++) {
      const idx = waveIndices[j];
      const outcome = settled[j];
      if (outcome.status === 'fulfilled') {
        results[idx] = outcome.value;
      } else {
        console.log(`[Classify] Batch ${idx} failed: ${outcome.reason?.message ?? outcome.reason}`);
        results[idx] = [];
      }
    }
  }

  return results.flat();
}

interface ClassifiedBatchCache {
  classifiedBy: { configId: string; model: string; timestamp: number };
  items: ClassifiedItem[];
}

async function classifyOneBatch(
  env: Env,
  config: VariantConfig,
  batch: RssItem[],
  batchIdx: number,
  date: string,
): Promise<ClassifiedItem[]> {
  const kvKey = `classified:batch:${date}:${config.id}:${batchIdx}`;
  const provider = resolveProvider(config, 'cheap');

  // Resumption: if the 03:00 run wrote this batch to KV before crashing,
  // the 03:30 retry picks it up instead of re-paying the LLM call.
  try {
    const existing = await env.DIGEST_KV.get(kvKey);
    if (existing) {
      const parsed = JSON.parse(existing) as ClassifiedBatchCache;
      const cachedItems = parsed?.items;
      if (Array.isArray(cachedItems) && cachedItems.length > 0) {
        console.log(`[Classify] Batch ${batchIdx} (${config.id}): resumed ${cachedItems.length} items from KV`);
        return cachedItems;
      }
    }
  } catch (err) {
    console.log(`[Classify] Batch ${batchIdx} (${config.id}): KV resume failed (${err}), re-running`);
  }

  const prompt = buildClassificationPrompt(batch);
  const response = await provider.call(env, 'cheap', prompt, 8000);
  const parsed = parseClassifiedJson(response);

  // Carry imageUrl from RSS item to classified item (prompt doesn't ask for it)
  const imagesByLink = new Map<string, string>();
  for (const item of batch) {
    if (item.imageUrl && item.link) imagesByLink.set(item.link, item.imageUrl);
  }
  for (const item of parsed) {
    if (!item.imageUrl && item.link && imagesByLink.has(item.link)) {
      item.imageUrl = imagesByLink.get(item.link);
    }
  }

  console.log(`[Classify] Batch ${batchIdx} (${config.id}): classified ${parsed.length}/${batch.length} items`);

  try {
    const payload: ClassifiedBatchCache = {
      classifiedBy: { configId: config.id, model: provider.modelFor('cheap'), timestamp: Date.now() },
      items: parsed,
    };
    // 2h TTL — batch outputs only need to survive the 03:30 retry window.
    await env.DIGEST_KV.put(kvKey, JSON.stringify(payload), { expirationTtl: 7200 });
  } catch (err) {
    console.log(`[Classify] Batch ${batchIdx} (${config.id}): KV write failed (non-fatal): ${err}`);
  }

  return parsed;
}

function parseClassifiedJson(response: string): ClassifiedItem[] {
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const arrayStart = jsonStr.indexOf('[');
  if (arrayStart === -1) throw new Error('No JSON array in classification response');
  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  } else {
    jsonStr = jsonStr.slice(arrayStart);
  }

  try {
    const parsed = JSON.parse(jsonStr) as ClassifiedItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const lastObj = jsonStr.lastIndexOf('}');
    if (lastObj === -1) return [];
    let salvaged = jsonStr.slice(0, lastObj + 1).trimEnd();
    if (salvaged.endsWith(',')) salvaged = salvaged.slice(0, -1);
    salvaged += ']';
    try {
      const parsed = JSON.parse(salvaged) as ClassifiedItem[];
      console.log(`[Classify] Salvaged ${parsed.length} items from truncated JSON`);
      return parsed;
    } catch {
      return [];
    }
  }
}

// ==============================================================================
// Stage 3a: URL-based dedup and drop 'low' importance
// ==============================================================================

const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'source',
];

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    const search = u.searchParams.toString();
    return `${u.origin}${path}${search ? `?${search}` : ''}`;
  } catch {
    return url;
  }
}

export function urlDedupAndDropLow(items: ClassifiedItem[]): ClassifiedItem[] {
  const nonLow = items.filter(it => it.importance !== 'low');
  console.log(`[Dedup] Dropped ${items.length - nonLow.length} 'low' items (kept ${nonLow.length})`);

  const groups = new Map<string, ClassifiedItem[]>();
  for (const item of nonLow) {
    const key = normalizeUrl(item.link);
    const arr = groups.get(key) ?? [];
    arr.push(item);
    groups.set(key, arr);
  }

  const result: ClassifiedItem[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    const primary = pickPrimary(group);
    const sources: { name: string; link: string; angle?: string }[] = primary.all_sources
      ? [...primary.all_sources]
      : [{ name: primary.source, link: primary.link }];
    for (const dup of group) {
      if (dup === primary) continue;
      if (!sources.some(s => s.name === dup.source)) {
        sources.push({ name: dup.source, link: dup.link });
      }
    }
    primary.all_sources = sources;
    // Promote to high if any duplicate was high
    if (group.some(it => it.importance === 'high')) primary.importance = 'high';
    result.push(primary);
  }

  console.log(`[Dedup] URL dedup: ${nonLow.length} → ${result.length} items`);
  return result;
}

// Prefer the "most authoritative" source when collapsing a URL group.
// Agency wires and well-known outlets beat aggregator reposts.
const PRIMARY_SOURCE_PRIORITY = [
  'Reuters', 'BBC', 'AP', 'Associated Press', 'AFP', 'Bloomberg', 'Financial Times',
  'The Guardian', 'The New York Times', 'Washington Post', 'Al Jazeera', 'France 24', 'DW',
];
function pickPrimary(group: ClassifiedItem[]): ClassifiedItem {
  for (const preferred of PRIMARY_SOURCE_PRIORITY) {
    const match = group.find(it => it.source.toLowerCase().includes(preferred.toLowerCase()));
    if (match) return match;
  }
  return group[0];
}

// ==============================================================================
// Stage 3b: semantic dedup — one Haiku call over all survivors
// ==============================================================================

interface DedupGroup {
  primary: number;
  duplicates: number[];
  rationale?: string;
}

export async function semanticDedup(
  env: Env,
  config: VariantConfig,
  items: ClassifiedItem[],
): Promise<ClassifiedItem[]> {
  if (items.length < 10) {
    console.log(`[Dedup] Skipping semantic dedup (only ${items.length} items)`);
    return items;
  }

  const provider = resolveProvider(config, 'cheap');
  let groupsRaw: string;
  try {
    const prompt = buildSemanticDedupPrompt(items);
    groupsRaw = await provider.call(env, 'cheap', prompt, 4000);
  } catch (err) {
    console.log(`[Dedup] Semantic dedup LLM call failed: ${err instanceof Error ? err.message : err}`);
    return items;
  }

  let groups: DedupGroup[] = [];
  try {
    let jsonStr = groupsRaw.trim();
    const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1].trim();
    const start = jsonStr.indexOf('[');
    const end = jsonStr.lastIndexOf(']');
    if (start === -1) throw new Error('no json array');
    const slice = end > start ? jsonStr.slice(start, end + 1) : jsonStr.slice(start);
    const parsed = JSON.parse(slice);
    if (Array.isArray(parsed)) groups = parsed as DedupGroup[];
  } catch (err) {
    console.log(`[Dedup] Semantic dedup parse failed: ${err}`);
    return items;
  }

  const toDrop = new Set<number>();
  for (const group of groups) {
    const primary = items[group.primary];
    if (!primary) continue;

    const sources: { name: string; link: string; angle?: string }[] = primary.all_sources
      ? [...primary.all_sources]
      : [{ name: primary.source, link: primary.link }];

    for (const dupIdx of group.duplicates) {
      if (dupIdx === group.primary) continue;
      const dup = items[dupIdx];
      if (!dup) continue;
      toDrop.add(dupIdx);
      if (!sources.some(s => s.name === dup.source)) {
        sources.push({ name: dup.source, link: dup.link });
      }
      if (dup.importance === 'high') primary.importance = 'high';
    }
    primary.all_sources = sources;

    if (group.rationale?.toLowerCase().trim().startsWith('conflicting')) {
      primary.conflicting = true;
      primary.conflict_note = group.rationale.replace(/^conflicting\s*[—:-]?\s*/i, '');
    }
  }

  const result = items.filter((_, i) => !toDrop.has(i));
  console.log(`[Dedup] Semantic dedup: ${items.length} → ${result.length} items (${groups.length} groups)`);
  return result;
}

// ==============================================================================
// Stage 4: balance-aware selection
// ==============================================================================

const CONFLICT_COUNTRIES = new Set(['UA', 'IL', 'IR', 'LB', 'PS', 'SY', 'YE', 'SD']);
const MIDDLE_EAST = new Set(['IL', 'IR', 'LB', 'PS', 'SY', 'YE']);
const BRICS_COUNTRIES = new Set(['CN', 'RU', 'IN', 'BR', 'ZA']);
const MAJOR_EUROPE = new Set([
  'FR', 'DE', 'UK', 'GB', 'IT', 'ES', 'NL', 'BE', 'SE', 'FI', 'NO', 'DK',
  'AT', 'CH', 'GR', 'PT', 'IE', 'HU', 'CZ', 'SK', 'RO', 'BG', 'HR', 'SI',
  'EE', 'LV', 'LT',
]);
const AFRICA = new Set([
  'SD', 'NG', 'EG', 'KE', 'ZA', 'ET', 'MA', 'DZ', 'TN', 'LY', 'GH',
  'UG', 'TZ', 'SN', 'ML', 'CM', 'CI', 'AO', 'MZ', 'ZW', 'RW', 'BF', 'NE',
  'SO', 'SL', 'LR', 'MR', 'TD', 'CG', 'CD', 'CF', 'GA', 'GN', 'BJ', 'TG',
]);
const LATAM = new Set([
  'BR', 'AR', 'MX', 'CO', 'CL', 'PE', 'VE', 'CU', 'DO', 'HT', 'GT',
  'EC', 'BO', 'PY', 'UY', 'CR', 'PA', 'HN', 'SV', 'NI', 'JM',
]);
const CENTRAL_ASIA = new Set(['KZ', 'UZ', 'KG', 'TJ', 'TM', 'AF', 'MN']);
const SE_ASIA = new Set(['ID', 'VN', 'PH', 'TH', 'MY', 'SG', 'MM', 'KH', 'LA', 'BD', 'PK', 'LK']);

const ISRAEL_CAP = 2;
const UKRAINE_CAP = 4;
const NBA_CAP = 2;
const US_DOMESTIC_CAP = 3;

// Country codes that indicate a story is primarily *about* a major power, not
// the priority country it co-tags. Used to keep PL/CY/NP buckets domestic —
// e.g., "Trump migrant terminations" with country_tags ['US','CY'] should land
// in politics or alsoNotable, not in the Cyprus section.
const MAJOR_CO_TAG_COUNTRIES = new Set([
  'US', 'CN', 'RU', 'UK', 'GB', 'FR', 'DE', 'IT', 'JP', 'IN', 'BR', 'IR', 'IL',
]);

function hasMajorCoTag(countries: Set<string>): boolean {
  for (const c of countries) {
    if (MAJOR_CO_TAG_COUNTRIES.has(c)) return true;
  }
  return false;
}

const SECTION_ORDER: SectionKey[] = [
  'politics', 'poland', 'cyprus', 'nepal', 'europe', 'brics', 'usa',
  'tech', 'climate', 'science', 'business', 'health',
  'globalSouth', 'alsoNotable', 'happenedInWorld', 'editorial',
  'sports', 'culture',
];

const SECTION_META: Record<SectionKey, { header: string; format: 'prose' | 'bullets' | 'editorial' }> = {
  politics:        { header: '🏛️ Global Politics',               format: 'prose' },
  poland:          { header: '🇵🇱 Poland',                         format: 'prose' },
  cyprus:          { header: '🇨🇾 Cyprus',                         format: 'prose' },
  nepal:           { header: '🇳🇵 Nepal',                          format: 'prose' },
  europe:          { header: '🇪🇺 Europe',                         format: 'prose' },
  brics:           { header: '🇨🇳🇷🇺🇮🇳 BRICS & Major Powers',   format: 'prose' },
  usa:             { header: '🇺🇸 United States',                  format: 'prose' },
  tech:            { header: '🤖 Technology and AI',               format: 'prose' },
  climate:         { header: '🌍 Climate and Environment',         format: 'prose' },
  science:         { header: '🔬 Science and Research',            format: 'prose' },
  business:        { header: '💼 Business and Economy',            format: 'prose' },
  health:          { header: '🏥 Health and Medicine',             format: 'prose' },
  globalSouth:     { header: '🌏 Global South & Regional Roundup', format: 'prose' },
  alsoNotable:     { header: '📌 Also Notable',                    format: 'bullets' },
  happenedInWorld: { header: '🌐 Happened in the World',           format: 'bullets' },
  editorial:       { header: '📰 Editorial Picks',                 format: 'editorial' },
  sports:          { header: '⚽ Sports',                           format: 'bullets' },
  culture:         { header: '🎭 Culture',                          format: 'bullets' },
};

const SECTION_LIMITS: Partial<Record<SectionKey, number>> = {
  politics: 7, poland: 4, cyprus: 3, nepal: 3, europe: 5, brics: 5, usa: 3,
  tech: 5, climate: 5, science: 4, business: 5, health: 4,
  globalSouth: 5, alsoNotable: 8, happenedInWorld: 10,
  editorial: 3, sports: 10, culture: 7,
};

function primarySection(item: ClassifiedItem): SectionKey {
  const countries = new Set(item.country_tags || []);
  const cats = new Set(item.category_tags || []);

  // Sports always wins
  if (cats.has('sports')) return 'sports';

  // Culture (sports already handled — so culture here has no sports tag)
  if (cats.has('culture')) return 'culture';

  // Editorial source → editorial pool
  if (item.editorial) return 'editorial';

  // Conflicts → Global Politics (even if PL/CY/NP)
  const hasConflict = [...countries].some(c => CONFLICT_COUNTRIES.has(c));
  if (hasConflict && cats.has('politics')) return 'politics';
  if (countries.has('UA')) return 'politics';

  // Priority countries (non-conflict). A story only lands in the country
  // bucket when the country is the actual subject — not when a major power
  // is also tagged (US/CN/RU/UK/FR/DE/IT/EU summits hosted in Limassol,
  // Trump-administration stories merely covered by Cyprus Mail, etc.). Such
  // stories fall through to politics / category sections / alsoNotable.
  if (countries.has('PL') && !hasMajorCoTag(countries)) return 'poland';
  if (countries.has('CY') && !hasMajorCoTag(countries)) return 'cyprus';
  if (countries.has('NP') && !hasMajorCoTag(countries)) return 'nepal';

  // USA
  if (countries.has('US')) {
    if (cats.has('politics')) return 'usa';
    return 'alsoNotable';
  }

  // BRICS (non-conflict)
  if ([...countries].some(c => BRICS_COUNTRIES.has(c))) return 'brics';

  // Category-first for stories without a clear country home
  if (cats.has('tech_ai')) return 'tech';
  if (cats.has('climate')) return 'climate';
  if (cats.has('science')) return 'science';
  if (cats.has('business') || cats.has('economics')) return 'business';
  if (cats.has('health')) return 'health';

  // Major Europe
  if ([...countries].some(c => MAJOR_EUROPE.has(c))) return 'europe';

  // Global South
  if ([...countries].some(c => AFRICA.has(c) || LATAM.has(c) || CENTRAL_ASIA.has(c) || SE_ASIA.has(c))) {
    return 'globalSouth';
  }

  return 'happenedInWorld';
}

function sortByImportance(a: ClassifiedItem, b: ClassifiedItem): number {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const ra = rank[a.importance] ?? 3;
  const rb = rank[b.importance] ?? 3;
  if (ra !== rb) return ra - rb;
  const ta = new Date(a.pubDate || '').getTime() || 0;
  const tb = new Date(b.pubDate || '').getTime() || 0;
  return tb - ta;
}

function isIsraelConflict(item: ClassifiedItem): boolean {
  return (item.country_tags || []).some(c => MIDDLE_EAST.has(c));
}

function isUkraineWar(item: ClassifiedItem): boolean {
  return (item.country_tags || []).includes('UA');
}

function isNbaOrUsSport(item: ClassifiedItem): boolean {
  const headline = item.headline.toLowerCase();
  if (/\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b/.test(headline)) return true;
  const cats = item.category_tags || [];
  const countries = item.country_tags || [];
  return cats.includes('sports') && countries.includes('US') && !countries.some(c => c !== 'US');
}

function isEuropeanFootball(item: ClassifiedItem): boolean {
  const headline = item.headline.toLowerCase();
  // Competitions
  if (/champions league|europa league|premier league|la liga|bundesliga|serie a|ekstraklasa|ligue 1|eredivisie/.test(headline)) return true;
  // Common european football club names (rough heuristic)
  if (/(arsenal|chelsea|liverpool|manchester|tottenham|real madrid|barcelona|atletico|juventus|milan|inter|bayern|dortmund|psg|ajax|legia|lech)/.test(headline)) return true;
  const cats = item.category_tags || [];
  const countries = item.country_tags || [];
  return cats.includes('sports') && [...countries].some(c => MAJOR_EUROPE.has(c));
}

export function selectForDigest(classified: ClassifiedItem[]): SelectedDigestInput {
  // 1. Bucket by primary section
  const buckets: Record<SectionKey, ClassifiedItem[]> = {
    politics: [], poland: [], cyprus: [], nepal: [], europe: [], brics: [], usa: [],
    tech: [], climate: [], science: [], business: [], health: [],
    globalSouth: [], alsoNotable: [], happenedInWorld: [], editorial: [],
    sports: [], culture: [],
  };
  const dropped: { reason: string; link: string; headline: string }[] = [];
  const gaps: { section: SectionKey; note: string }[] = [];

  for (const item of classified) {
    const section = primarySection(item);
    buckets[section].push(item);
  }

  for (const key of Object.keys(buckets) as SectionKey[]) {
    buckets[key].sort(sortByImportance);
  }

  // 2. Israel / Middle-East conflict cap within politics
  {
    const midEast = buckets.politics.filter(isIsraelConflict);
    if (midEast.length > ISRAEL_CAP) {
      const keep = new Set(midEast.slice(0, ISRAEL_CAP));
      buckets.politics = buckets.politics.filter(it => {
        if (isIsraelConflict(it) && !keep.has(it)) {
          dropped.push({ reason: 'israel-cap', link: it.link, headline: it.headline });
          return false;
        }
        return true;
      });
    }
  }

  // 2b. Ukraine cap within politics. Ukrainian feeds (Ukrinform, Kyiv Independent,
  //     etc.) typically produce 10+ distinct events per day — front-line strikes,
  //     prisoner exchanges, weather impact, propaganda, Belarus posture, ...
  //     all genuinely separate items that semantic dedup correctly leaves intact.
  //     Without a cap they flood the politics bucket and crowd out everything else.
  {
    const ukraine = buckets.politics.filter(isUkraineWar);
    if (ukraine.length > UKRAINE_CAP) {
      const keep = new Set(ukraine.slice(0, UKRAINE_CAP));
      buckets.politics = buckets.politics.filter(it => {
        if (isUkraineWar(it) && !keep.has(it)) {
          dropped.push({ reason: 'ukraine-cap', link: it.link, headline: it.headline });
          return false;
        }
        return true;
      });
    }
  }

  // 3. NBA / US sports cap within sports
  {
    const nba = buckets.sports.filter(isNbaOrUsSport);
    if (nba.length > NBA_CAP) {
      const keep = new Set(nba.slice(0, NBA_CAP));
      buckets.sports = buckets.sports.filter(it => {
        if (isNbaOrUsSport(it) && !keep.has(it)) {
          dropped.push({ reason: 'nba-cap', link: it.link, headline: it.headline });
          return false;
        }
        return true;
      });
    }
  }

  // 4. US domestic cap (US-only stories routed to alsoNotable)
  {
    const usOnly = buckets.alsoNotable.filter(it =>
      (it.country_tags || []).includes('US') && !(it.country_tags || []).some(c => c !== 'US')
    );
    if (usOnly.length > US_DOMESTIC_CAP) {
      const keep = new Set(usOnly.slice(0, US_DOMESTIC_CAP));
      buckets.alsoNotable = buckets.alsoNotable.filter(it => {
        const isUsOnly = (it.country_tags || []).includes('US') && !(it.country_tags || []).some(c => c !== 'US');
        if (isUsOnly && !keep.has(it)) {
          dropped.push({ reason: 'us-domestic-cap', link: it.link, headline: it.headline });
          return false;
        }
        return true;
      });
    }
  }

  // 5. Ukraine minimum: if no UA story in politics, flag a gap
  {
    const hasUkraine = buckets.politics.some(it => (it.country_tags || []).includes('UA'));
    if (!hasUkraine) {
      gaps.push({ section: 'politics', note: 'No major Ukraine developments in today\'s feeds.' });
    }
  }

  // 6. Sudan priority within globalSouth: pull Sudan stories to front
  buckets.globalSouth.sort((a, b) => {
    const aSudan = (a.country_tags || []).includes('SD') ? 0 : 1;
    const bSudan = (b.country_tags || []).includes('SD') ? 0 : 1;
    if (aSudan !== bSudan) return aSudan - bSudan;
    return sortByImportance(a, b);
  });

  // 7. Sports: European football ≥50% target. If NBA passed cap and
  //    European football is underrepresented, trim more NBA.
  {
    const euFootball = buckets.sports.filter(isEuropeanFootball).length;
    const total = buckets.sports.length;
    if (total > 0 && euFootball / total < 0.5) {
      // Remove non-football, non-European items beyond what we can keep
      // while maintaining ≥50% european football (among remaining pool)
      const targetEu = Math.ceil(total * 0.5);
      if (euFootball < targetEu) {
        // Can't add what we don't have; instead, cull non-EU-football down
        const nonEu = buckets.sports.filter(it => !isEuropeanFootball(it));
        const maxNonEu = Math.max(euFootball, 2); // keep at least 2 non-EU items (tennis, F1, etc.)
        if (nonEu.length > maxNonEu) {
          const keepNonEu = new Set(nonEu.slice(0, maxNonEu));
          buckets.sports = buckets.sports.filter(it => isEuropeanFootball(it) || keepNonEu.has(it));
        }
      }
    }
  }

  // 8. Europe section floor: if <3, merge into alsoNotable
  if (buckets.europe.length > 0 && buckets.europe.length < 3) {
    buckets.alsoNotable.push(...buckets.europe);
    buckets.europe = [];
  }

  // 9. BRICS section floor: if <2, merge into alsoNotable
  if (buckets.brics.length > 0 && buckets.brics.length < 2) {
    buckets.alsoNotable.push(...buckets.brics);
    buckets.brics = [];
  }

  // 10. Trim each bucket to its section limit (keeping highest-importance first)
  for (const [key, limit] of Object.entries(SECTION_LIMITS)) {
    const k = key as SectionKey;
    if (!limit) continue;
    if (buckets[k].length > limit) {
      const kept = buckets[k].slice(0, limit);
      const excess = buckets[k].slice(limit);
      for (const it of excess) {
        dropped.push({ reason: `section-limit:${k}`, link: it.link, headline: it.headline });
      }
      buckets[k] = kept;
    }
  }

  // 11. Build final ordered section list, skipping empty sections
  const sections: SelectedDigestSection[] = [];
  for (const key of SECTION_ORDER) {
    const stories = buckets[key];
    if (stories.length === 0) continue;
    sections.push({
      key,
      header: SECTION_META[key].header,
      format: SECTION_META[key].format,
      stories,
    });
  }

  return { sections, dropped, gaps };
}

// Convert the selected digest back to a flat TriagedStory[] for KV storage
// and downstream use (landing page, image map, etc.). The compilation prompt
// reads the SelectedDigestInput directly, not this output.
export function selectedToFlat(selected: SelectedDigestInput): import('./types').TriagedStory[] {
  const result: import('./types').TriagedStory[] = [];
  for (const section of selected.sections) {
    for (const story of section.stories) {
      result.push({
        headline: story.headline,
        summary: story.summary,
        source: story.source,
        link: story.link,
        country_tags: story.country_tags || [],
        category_tags: story.category_tags || [],
        importance: story.importance === 'low' ? 'medium' : story.importance,
        duplicate_of: null,
        ...(story.conflicting !== undefined && { conflicting: story.conflicting }),
        ...(story.conflict_note && { conflict_note: story.conflict_note }),
        ...(story.editorial !== undefined && { editorial: story.editorial }),
        ...(story.imageUrl && { imageUrl: story.imageUrl }),
        ...(story.all_sources && { all_sources: story.all_sources }),
      });
    }
  }
  return result;
}
