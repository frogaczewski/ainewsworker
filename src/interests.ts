import { INTERESTS, SUBSCRIBER_INTERESTS } from './config';
import type { InterestDefinition } from './config';
import { fetchSingleFeed } from './feeds';
import { resolveProvider } from './providers';
import type { VariantConfig } from './providers/base';
import { normalizeEmail } from './subscribers';
import type { CuratedInterestItem, Env, RssItem } from './types';

// Cap raw items handed to the Haiku picker. More than this wastes tokens with
// no quality gain — the last 24h of a handful of cycling feeds comfortably
// fits in 40 items, and anything older isn't "today's news" anyway.
const MAX_RAW_ITEMS_PER_INTEREST = 40;

// ──────────────────────────────────────────────────────────────────────────────
// Per-person interest lookup
// ──────────────────────────────────────────────────────────────────────────────

export function getInterestsForEmail(email: string): string[] {
  const ids = SUBSCRIBER_INTERESTS[normalizeEmail(email)] ?? [];
  return ids.filter(id => id in INTERESTS);
}

// Union of interests across every subscriber in SUBSCRIBER_INTERESTS. Used by
// Phase 1 to decide which feed groups to actually fetch + curate.
export function collectActiveInterests(): string[] {
  const seen = new Set<string>();
  for (const ids of Object.values(SUBSCRIBER_INTERESTS)) {
    for (const id of ids) {
      if (id in INTERESTS) seen.add(id);
    }
  }
  return [...seen];
}

// ──────────────────────────────────────────────────────────────────────────────
// Phase 1 hook: fetch + curate every active interest.
//
// Dedupes feeds by URL across interests (two interests pointing at the same
// source only incur one HTTP fetch). Curation is one Haiku call per interest,
// not per subscriber — cost is flat in the number of recipients.
//
// Non-fatal on any failure. A broken cycling feed or a Haiku hiccup returns
// an empty slice for that interest; the main digest is unaffected.
// ──────────────────────────────────────────────────────────────────────────────

export async function fetchPerPersonInterests(
  env: Env,
  config: VariantConfig,
): Promise<Record<string, CuratedInterestItem[]>> {
  const activeIds = collectActiveInterests();
  if (activeIds.length === 0) {
    return {};
  }

  console.log(`[Interests] Active interests: ${activeIds.join(', ')}`);

  const rawPerInterest = await fetchRawItemsForInterests(activeIds);

  const curatedEntries = await Promise.all(
    activeIds.map(async id => {
      const raw = rawPerInterest[id] ?? [];
      if (raw.length === 0) {
        console.log(`[Interests] ${id}: no raw items — skipping curation`);
        return [id, [] as CuratedInterestItem[]] as const;
      }
      try {
        const curated = await curateInterest(env, config, INTERESTS[id], raw);
        console.log(`[Interests] ${id}: curated ${curated.length}/${raw.length} items`);
        return [id, curated] as const;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[Interests] ${id}: curation failed (${msg}) — falling back to top ${INTERESTS[id].topN} by date`);
        return [id, fallbackPicks(raw, INTERESTS[id].topN)] as const;
      }
    }),
  );

  const out: Record<string, CuratedInterestItem[]> = {};
  for (const [id, items] of curatedEntries) {
    out[id] = items;
  }
  return out;
}

async function fetchRawItemsForInterests(
  interestIds: string[],
): Promise<Record<string, RssItem[]>> {
  // Build one fetch per unique feed URL, remember which interests subscribe to it.
  const feedUrlToInterests = new Map<string, { feed: { name: string; url: string }; interests: Set<string> }>();
  for (const id of interestIds) {
    const def = INTERESTS[id];
    if (!def) continue;
    for (const feed of def.feeds) {
      const existing = feedUrlToInterests.get(feed.url);
      if (existing) {
        existing.interests.add(id);
      } else {
        feedUrlToInterests.set(feed.url, {
          feed: { name: feed.name, url: feed.url },
          interests: new Set([id]),
        });
      }
    }
  }

  const entries = [...feedUrlToInterests.values()];
  const fetched = await Promise.allSettled(entries.map(e => fetchSingleFeed(e.feed)));

  const perInterest: Record<string, RssItem[]> = {};
  for (const id of interestIds) perInterest[id] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const result = fetched[i];
    if (result.status !== 'fulfilled') {
      console.log(`[Interests] Feed ${entry.feed.name} threw: ${String(result.reason)}`);
      continue;
    }
    if (result.value.error) {
      console.log(`[Interests] Feed ${entry.feed.name} error: ${result.value.error}`);
      continue;
    }
    for (const interestId of entry.interests) {
      perInterest[interestId].push(...result.value.items);
    }
  }

  // Sort by date desc and cap per interest.
  for (const id of interestIds) {
    perInterest[id] = perInterest[id]
      .sort((a, b) => {
        const da = a.pubDate ? new Date(a.pubDate).getTime() : 0;
        const db = b.pubDate ? new Date(b.pubDate).getTime() : 0;
        return db - da;
      })
      .slice(0, MAX_RAW_ITEMS_PER_INTEREST);
    console.log(`[Interests] ${id}: fetched ${perInterest[id].length} raw items`);
  }

  return perInterest;
}

// ──────────────────────────────────────────────────────────────────────────────
// Haiku curation
// ──────────────────────────────────────────────────────────────────────────────

async function curateInterest(
  env: Env,
  config: VariantConfig,
  def: InterestDefinition,
  items: RssItem[],
): Promise<CuratedInterestItem[]> {
  const provider = resolveProvider(config, 'cheap');
  const prompt = buildCurationPrompt(def, items);
  const response = await provider.call(env, 'cheap', prompt, 2000);
  const parsed = parseCuratedJson(response);

  // Only keep entries whose link was actually in the input — guards against
  // the model hallucinating URLs.
  const validLinks = new Set(items.map(i => i.link));
  const filtered = parsed.filter(e => e.link && validLinks.has(e.link));
  return filtered.slice(0, def.topN);
}

function buildCurationPrompt(def: InterestDefinition, items: RssItem[]): string {
  const itemsText = items
    .map((item, i) => `[${i}] SOURCE: ${item.source}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nLINK: ${item.link}\nDATE: ${item.pubDate}`)
    .join('\n\n');

  return `You are curating a short "${def.title}" section for a daily news digest. The reader is ${def.audience}.

From the items below, pick the ${def.topN} most important stories today. Translate any non-English headline/summary to English.

PRIORITIZE:
${def.prioritize}

SKIP:
${def.skip}

Return a JSON array of up to ${def.topN} objects. If fewer than ${def.topN} items clear the bar, return fewer — do not pad. Each object:
{
  "headline": "carried through (translate to English if needed)",
  "blurb": "one tight sentence explaining why this matters to the reader",
  "source": "carried through exactly",
  "link": "carried through exactly"
}

Return ONLY the JSON array. No markdown fences. No commentary.

=== ITEMS ===
${itemsText}`;
}

function parseCuratedJson(response: string): CuratedInterestItem[] {
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const arrayStart = jsonStr.indexOf('[');
  if (arrayStart === -1) return [];
  const arrayEnd = jsonStr.lastIndexOf(']');
  if (arrayEnd !== -1 && arrayEnd > arrayStart) {
    jsonStr = jsonStr.slice(arrayStart, arrayEnd + 1);
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? (parsed as CuratedInterestItem[]) : [];
  } catch {
    return [];
  }
}

// Date-ordered fallback when the Haiku call fails. Keeps the section from
// disappearing just because the model was having a bad morning.
function fallbackPicks(items: RssItem[], topN: number): CuratedInterestItem[] {
  return items.slice(0, topN).map(i => ({
    headline: i.title,
    blurb: i.summary.length > 180 ? `${i.summary.slice(0, 177)}…` : i.summary,
    source: i.source,
    link: i.link,
  }));
}

// ──────────────────────────────────────────────────────────────────────────────
// Rendering — called per-recipient in sendAllEmails.
// ──────────────────────────────────────────────────────────────────────────────

// Returns a markdown block to append to the recipient's email, or '' if this
// recipient has no interests (or they all came back empty).
export function renderInterestsFor(
  email: string,
  curated: Record<string, CuratedInterestItem[]> | undefined,
): string {
  if (!curated) return '';
  const interestIds = getInterestsForEmail(email);
  if (interestIds.length === 0) return '';

  const blocks: string[] = [];
  for (const id of interestIds) {
    const def = INTERESTS[id];
    const items = curated[id] ?? [];
    if (!def || items.length === 0) continue;
    blocks.push(renderBlock(def, items));
  }
  if (blocks.length === 0) return '';

  return `\n\n---\n\n${blocks.join('\n\n')}`;
}

function renderBlock(def: InterestDefinition, items: CuratedInterestItem[]): string {
  const lines = [`## ${def.emoji} ${def.title}`, ''];
  for (const item of items) {
    lines.push(`- **[${item.headline}](${item.link})** — ${item.blurb} *(${item.source})*`);
  }
  return lines.join('\n');
}
