// Code-side assembly of the structured digest emitted by the Sonnet
// compilation call. The LLM produces per-story prose in English and Polish
// (see buildStructuredCompilationPrompt); this module turns that JSON into
// the four markdown artefacts the pipeline needs:
//
//   - English full digest (consumed by landing page + retained as
//     digestMarkdown for the website)
//   - English email briefing (one Sonnet call per pipeline run instead of two)
//   - Polish full digest
//   - Polish email briefing
//
// The output shapes match the existing prompt output verbatim so landing.ts
// and email.ts don't need to change.

import type {
  BilingualText,
  MarketData,
  SectionKey,
  SelectedDigestInput,
  StructuredDigest,
  StructuredSection,
  StructuredStory,
  WeatherData,
} from './types';
import { generateSlug } from './landing';

export type Lang = 'en' | 'pl';

// ──────────────────────────────────────────────────────────────────────────────
// Localised labels
// ──────────────────────────────────────────────────────────────────────────────

const SECTION_HEADERS: Record<SectionKey, Record<Lang, string>> = {
  politics:        { en: '🏛️ Global Politics',               pl: '🏛️ Polityka Światowa' },
  poland:          { en: '🇵🇱 Poland',                         pl: '🇵🇱 Polska' },
  cyprus:          { en: '🇨🇾 Cyprus',                         pl: '🇨🇾 Cypr' },
  nepal:           { en: '🇳🇵 Nepal',                          pl: '🇳🇵 Nepal' },
  europe:          { en: '🇪🇺 Europe',                         pl: '🇪🇺 Europa' },
  brics:           { en: '🇨🇳🇷🇺🇮🇳 BRICS & Major Powers',   pl: '🇨🇳🇷🇺🇮🇳 BRICS i Mocarstwa' },
  usa:             { en: '🇺🇸 United States',                  pl: '🇺🇸 Stany Zjednoczone' },
  tech:            { en: '🤖 Technology and AI',               pl: '🤖 Technologia i AI' },
  climate:         { en: '🌍 Climate and Environment',         pl: '🌍 Klimat i Środowisko' },
  science:         { en: '🔬 Science and Research',            pl: '🔬 Nauka i Badania' },
  business:        { en: '💼 Business and Economy',            pl: '💼 Biznes i Gospodarka' },
  health:          { en: '🏥 Health and Medicine',             pl: '🏥 Zdrowie i Medycyna' },
  globalSouth:     { en: '🌏 Global South & Regional Roundup', pl: '🌏 Globalne Południe i Przegląd Regionalny' },
  alsoNotable:     { en: '📌 Also Notable',                    pl: '📌 Warto Odnotować' },
  happenedInWorld: { en: '🌐 Happened in the World',           pl: '🌐 Wydarzenia na Świecie' },
  editorial:       { en: '📰 Editorial Picks',                 pl: '📰 Wybór Redakcji' },
  sports:          { en: '⚽ Sports',                           pl: '⚽ Sport' },
  culture:         { en: '🎭 Culture',                          pl: '🎭 Kultura' },
};

const TITLES: Record<Lang, string> = {
  en: 'Daily News Digest',
  pl: 'Codzienny Przegląd Wiadomości',
};

const MARKETS_HEADER: Record<Lang, string> = {
  en: '📈 Markets & Macro',
  pl: '📈 Rynki i Makro',
};

const MARKET_TABLE_HEADER: Record<Lang, string> = {
  en: '| Index / Asset | Value | Change |\n|---|---|---|',
  pl: '| Indeks / Aktywo | Wartość | Zmiana |\n|---|---|---|',
};

const MARKET_COMMENTARY_HEADER: Record<Lang, string> = {
  en: '**Market Commentary**',
  pl: '**Komentarz Rynkowy**',
};

const MACRO_WATCH_HEADER: Record<Lang, string> = {
  en: '**Macro & Inflation Watch**',
  pl: '**Wiadomości Makro i Inflacja**',
};

const WEATHER_HEADER: Record<Lang, string> = {
  en: '🌤️ Weather Forecast',
  pl: '🌤️ Prognoza Pogody',
};

const WEATHER_TABLE_HEADER: Record<Lang, string> = {
  en: '| Day | Conditions | High / Low |\n|---|---|---|',
  pl: '| Dzień | Warunki | Maks. / Min. |\n|---|---|---|',
};

const WEATHER_LOCATION_LABEL: Record<string, Record<Lang, string>> = {
  'Pegeia, Cyprus': {
    en: 'Pegeia, Cyprus (next 3 days)',
    pl: 'Pegeia, Cypr (najbliższe 3 dni)',
  },
  'Gdańsk, Poland': {
    en: 'Gdańsk, Poland (next 3 days)',
    pl: 'Gdańsk, Polska (najbliższe 3 dni)',
  },
};

const WEEKDAY_PL: Record<string, string> = {
  Monday: 'Poniedziałek',
  Tuesday: 'Wtorek',
  Wednesday: 'Środa',
  Thursday: 'Czwartek',
  Friday: 'Piątek',
  Saturday: 'Sobota',
  Sunday: 'Niedziela',
};

const FOOTER: Record<Lang, (websiteUrl: string) => string> = {
  en: (url) => `*Generated automatically by AI News Digest. [Read the full digest online.](${url})*`,
  pl: (url) => `*Wygenerowano automatycznie przez AI News Digest. [Czytaj pełny przegląd online.](${url})*`,
};

const COMPILED_FROM: Record<Lang, (sourcesNote: string) => string> = {
  en: (s) => `*Compiled from ${s}. All stories from the last 24 hours. Cross-referenced across outlets.*`,
  pl: (s) => `*Opracowano na podstawie: ${s}. Wszystkie wiadomości z ostatnich 24 godzin. Porównane między źródłami.*`,
};

const READ_FULL_BOTTOM: Record<Lang, (url: string) => string> = {
  en: (url) => `**[See all stories on the website →](${url})**`,
  pl: (url) => `**[Zobacz wszystkie wiadomości na stronie →](${url})**`,
};

const READ_FULL_COVERAGE: Record<Lang, (url: string) => string> = {
  en: (url) => `[Read full coverage →](${url})`,
  pl: (url) => `[Czytaj pełne pokrycie →](${url})`,
};

// ──────────────────────────────────────────────────────────────────────────────
// JSON schema for native tool-use (Anthropic) — the model emits a tool_use
// block whose `input` is validated against this shape on the API server. No
// more text-mode JSON parsing for callers that use callJson.
// ──────────────────────────────────────────────────────────────────────────────

const BILINGUAL_TEXT_SCHEMA = {
  type: 'object',
  required: ['en', 'pl'],
  properties: {
    en: { type: 'string' },
    pl: { type: 'string' },
  },
} as const;

export const DIGEST_JSON_SCHEMA = {
  type: 'object',
  required: ['sections', 'gaps', 'marketCommentary', 'macroWatch'],
  properties: {
    sections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'format', 'stories'],
        properties: {
          key: { type: 'string' },
          format: { type: 'string', enum: ['prose', 'bullets', 'editorial'] },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              required: ['link', 'headline', 'body', 'tldr'],
              properties: {
                link: { type: 'string' },
                headline: BILINGUAL_TEXT_SCHEMA,
                body: BILINGUAL_TEXT_SCHEMA,
                tldr: BILINGUAL_TEXT_SCHEMA,
              },
            },
          },
        },
      },
    },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['section', 'note'],
        properties: {
          section: { type: 'string' },
          note: BILINGUAL_TEXT_SCHEMA,
        },
      },
    },
    marketCommentary: BILINGUAL_TEXT_SCHEMA,
    macroWatch: BILINGUAL_TEXT_SCHEMA,
  },
} as const;

// ──────────────────────────────────────────────────────────────────────────────
// Parser
// ──────────────────────────────────────────────────────────────────────────────

// Mirrors the salvage logic in classify.ts:parseClassifiedJson — strip code
// fences, slice to the outermost JSON object, fall back to throwing on failure.
// Returns the parsed StructuredDigest or throws on unrecoverable parse error.
// Specific, observed-in-the-wild JSON drift patterns Sonnet 4.6 produces in
// long structured outputs. Each rule is narrow on purpose — broader rewrites
// risk corrupting valid JSON in edge cases.
export function repairJsonDrift(json: string): string {
  let out = json;

  // 1. Trailing commas before } or ]. Common at the end of nested objects.
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // 2. Polish opening curly quote „ (U+201E) closed with straight ASCII " instead
  //    of the matching curly " (U+201D). The straight " prematurely terminates
  //    the JSON string, which then breaks because the next characters are
  //    sentence continuation, not the next JSON property.
  //
  //    Repair pattern: „ + content + " + (whitespace + comma + whitespace) +
  //    Polish/English lowercase letter (sentence continuation, not a JSON key).
  //    Only fires when the trailing " can't be a legitimate JSON close because
  //    a JSON key would start with " or be uppercase after the comma.
  out = out.replace(
    /„([^"]{1,500})"(\s*,\s*)([a-ząćęłńóśźż])/g,
    '„$1”$2$3',
  );

  // 3. Same pattern but no comma — just whitespace + lowercase continuation.
  //    e.g. `„wstrzymana" i odwołał` (no comma between).
  out = out.replace(
    /„([^"]{1,500})"(\s+)([a-ząćęłńóśźż])/g,
    '„$1”$2$3',
  );

  // 4. Polish curly-quote pair closed with straight " right before the JSON
  //    string terminator. e.g. `"pl": "...„izraelską agresję""` — the model
  //    means the first " as the Polish close and the second as the JSON
  //    terminator, but JSON.parse sees "...agresję" as the value and the
  //    trailing " as a stray character. Two adjacent " inside a string
  //    position are unambiguously this bug — empty-string `""` only appears
  //    after `:` with no preceding „ … " pair.
  //    Observed on 2026-04-27 batch msgbatch_01WT3YRtcGqpWVG8QS8DyMfo at
  //    position 4376 ("„izraelską agresję""").
  out = out.replace(
    /„([^"]{1,500})""/g,
    '„$1”"',
  );

  return out;
}

export function parseStructuredDigest(response: string): StructuredDigest {
  let jsonStr = response.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const objStart = jsonStr.indexOf('{');
  if (objStart === -1) throw new Error('No JSON object in structured digest response');
  const objEnd = jsonStr.lastIndexOf('}');
  if (objEnd === -1 || objEnd < objStart) {
    throw new Error('Unterminated JSON object in structured digest response');
  }
  jsonStr = jsonStr.slice(objStart, objEnd + 1);

  // Repair common LLM JSON drift before parsing.
  jsonStr = repairJsonDrift(jsonStr);

  let parsed: Partial<StructuredDigest>;
  try {
    parsed = JSON.parse(jsonStr) as Partial<StructuredDigest>;
  } catch (err) {
    // V8 reports `position N` in the parse error. Pull a window around that
    // byte range so we can iterate the prompt against the actual failure mode.
    const msg = err instanceof Error ? err.message : String(err);
    const posMatch = msg.match(/position (\d+)/);
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const start = Math.max(0, pos - 80);
      const end = Math.min(jsonStr.length, pos + 80);
      const before = jsonStr.slice(start, pos);
      const after = jsonStr.slice(pos, end);
      console.error(`[Parse] Structured digest JSON parse failed at byte ${pos}: ${msg}`);
      console.error(`[Parse] Context: ...${before}⟪HERE⟫${after}...`);
    }
    throw err;
  }
  if (!Array.isArray(parsed.sections)) {
    throw new Error('Structured digest missing sections array');
  }
  return {
    sections: parsed.sections as StructuredSection[],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    marketCommentary: parsed.marketCommentary ?? { en: '', pl: '' },
    macroWatch: parsed.macroWatch ?? { en: '', pl: '' },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Date / weather / market helpers
// ──────────────────────────────────────────────────────────────────────────────

function formatDate(date: Date, lang: Lang): string {
  const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function dayLabel(isoDate: string, lang: Lang): string {
  const d = new Date(isoDate);
  const englishDay = d.toLocaleDateString('en-GB', { weekday: 'long' });
  if (lang === 'pl') return WEEKDAY_PL[englishDay] ?? englishDay;
  return englishDay;
}

function renderWeatherTable(weather: WeatherData[], lang: Lang): string {
  const blocks: string[] = [];
  for (const loc of weather) {
    const label = WEATHER_LOCATION_LABEL[loc.location]?.[lang] ?? loc.location;
    const rows = loc.days.slice(0, 3).map(d =>
      `| ${dayLabel(d.date, lang)} | ${d.conditions} | ${d.tempMax}°C / ${d.tempMin}°C |`
    ).join('\n');
    blocks.push(`### ${label}\n${WEATHER_TABLE_HEADER[lang]}\n${rows}`);
  }
  return blocks.join('\n\n');
}

function renderMarketsTable(markets: MarketData, lang: Lang): string {
  const rows: string[] = [];
  for (const q of markets.quotes) {
    if (q.error || q.price === null) continue;
    const change = q.change === null ? '—' : `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)}%`;
    rows.push(`| ${q.name} | ${q.price.toLocaleString(lang === 'pl' ? 'pl-PL' : 'en-GB')} | ${change} |`);
  }
  for (const c of markets.currencies) {
    if (c.error || c.rate === null) continue;
    rows.push(`| ${c.pair} | ${c.rate.toFixed(4)} | — |`);
  }
  return `${MARKET_TABLE_HEADER[lang]}\n${rows.join('\n')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Story rendering
// ──────────────────────────────────────────────────────────────────────────────

function pickLang<T extends BilingualText>(text: T, lang: Lang): string {
  return lang === 'pl' ? text.pl : text.en;
}

function renderStoryProse(story: StructuredStory, lang: Lang, useTldr: boolean): string {
  const headline = pickLang(story.headline, lang);
  const text = pickLang(useTldr ? story.tldr : story.body, lang);
  return `**${headline}**\n\n${text}`;
}

function renderStoryBullet(story: StructuredStory, lang: Lang): string {
  const prefix = pickLang(story.headline, lang);
  const text = pickLang(story.body, lang);
  return `- **${prefix}**: ${text}`;
}

function renderStoryEditorial(story: StructuredStory, lang: Lang, useTldr: boolean): string {
  const headline = pickLang(story.headline, lang);
  const text = pickLang(useTldr ? story.tldr : story.body, lang);
  return `**${headline}**\n\n${text}`;
}

// Build the per-section story-page URL the read-more links point to. Always
// derive the slug from the *English* header — the landing page is English-only
// and routes are case-sensitive on the slug.
function sectionStoryUrl(section: StructuredSection, websiteUrl: string, dateString: string): string {
  const baseUrl = websiteUrl.replace(/\/$/, '');
  const slug = generateSlug(SECTION_HEADERS[section.key].en);
  return `${baseUrl}/story/${dateString}/${slug}`;
}

function renderSection(
  section: StructuredSection,
  lang: Lang,
  mode: 'full' | 'briefing',
  websiteUrl: string,
  dateString: string,
): string {
  if (section.stories.length === 0) return '';
  const useTldr = mode === 'briefing';
  const lines: string[] = [`## ${SECTION_HEADERS[section.key][lang]}`, ''];
  const storyUrl = sectionStoryUrl(section, websiteUrl, dateString);

  if (section.format === 'bullets') {
    // Bullets stay verbatim in both modes — they're already concise.
    for (const story of section.stories) {
      lines.push(renderStoryBullet(story, lang));
    }
  } else if (section.format === 'editorial') {
    for (const story of section.stories) {
      lines.push(renderStoryEditorial(story, lang, useTldr));
      lines.push('');
      if (mode === 'briefing') {
        lines.push(`[Read more →](${storyUrl})`);
        lines.push('');
      }
    }
  } else {
    // prose
    for (const story of section.stories) {
      lines.push(renderStoryProse(story, lang, useTldr));
      lines.push('');
    }
    if (mode === 'briefing') {
      lines.push(READ_FULL_COVERAGE[lang](storyUrl));
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

// ──────────────────────────────────────────────────────────────────────────────
// Assemblers
// ──────────────────────────────────────────────────────────────────────────────

export interface AssembleOptions {
  websiteUrl: string;
  // Display-formatted date object (used for the title line).
  date: Date;
  // YYYY-MM-DD form (used to build /story/{date}/{slug} URLs).
  dateString: string;
  feedStats: { total: number; failed: number };
  weather: WeatherData[];
  markets: MarketData;
  // Provided for completeness — currently unused, but kept on the signature so
  // future assembly logic can reference dropped/section metadata without a
  // breaking change.
  input?: SelectedDigestInput;
}

function sourcesNote(feedStats: { total: number; failed: number }): string {
  if (feedStats.failed > 0) {
    return `${feedStats.total - feedStats.failed} of ${feedStats.total} sources responded`;
  }
  return `${feedStats.total} sources`;
}

function gapNoteFor(
  digest: StructuredDigest,
  key: SectionKey,
  lang: Lang,
): string | null {
  const gap = digest.gaps.find(g => g.section === key);
  if (!gap) return null;
  return `*${pickLang(gap.note, lang)}*`;
}

export function assembleFullDigest(
  digest: StructuredDigest,
  lang: Lang,
  opts: AssembleOptions,
): string {
  const { websiteUrl, date, dateString, feedStats, weather, markets } = opts;
  const parts: string[] = [];

  parts.push(`# ${TITLES[lang]} — ${formatDate(date, lang)}`);
  parts.push('');
  parts.push(COMPILED_FROM[lang](sourcesNote(feedStats)));
  parts.push('');
  parts.push('---');

  for (const section of digest.sections) {
    const rendered = renderSection(section, lang, 'full', websiteUrl, dateString);
    if (!rendered) continue;
    parts.push('');
    parts.push(rendered);
    const gap = gapNoteFor(digest, section.key, lang);
    if (gap) {
      parts.push('');
      parts.push(gap);
    }
    parts.push('');
    parts.push('---');
  }

  // Markets & Macro
  parts.push('');
  parts.push(`## ${MARKETS_HEADER[lang]}`);
  parts.push('');
  parts.push(renderMarketsTable(markets, lang));
  parts.push('');
  parts.push(MARKET_COMMENTARY_HEADER[lang]);
  parts.push('');
  parts.push(pickLang(digest.marketCommentary, lang));
  parts.push('');
  parts.push(MACRO_WATCH_HEADER[lang]);
  parts.push('');
  parts.push(pickLang(digest.macroWatch, lang));
  parts.push('');
  parts.push('---');

  // Weather
  parts.push('');
  parts.push(`## ${WEATHER_HEADER[lang]}`);
  parts.push('');
  parts.push(renderWeatherTable(weather, lang));
  parts.push('');
  parts.push('---');
  parts.push(FOOTER[lang](websiteUrl));

  return parts.join('\n');
}

export function assembleEmailBriefing(
  digest: StructuredDigest,
  lang: Lang,
  opts: AssembleOptions,
): string {
  const { websiteUrl, date, dateString, feedStats, weather, markets } = opts;
  const parts: string[] = [];

  parts.push(`# ${TITLES[lang]} — ${formatDate(date, lang)}`);
  parts.push('');
  parts.push(COMPILED_FROM[lang](sourcesNote(feedStats)));
  parts.push('');
  parts.push('---');

  for (const section of digest.sections) {
    // "Also Notable" is dropped from the briefing per existing rules.
    if (section.key === 'alsoNotable') continue;
    const rendered = renderSection(section, lang, 'briefing', websiteUrl, dateString);
    if (!rendered) continue;
    parts.push('');
    parts.push(rendered);
    const gap = gapNoteFor(digest, section.key, lang);
    if (gap) {
      parts.push('');
      parts.push(gap);
    }
    parts.push('');
    parts.push('---');
  }

  // Markets & Macro — kept verbatim in the briefing per existing rules.
  parts.push('');
  parts.push(`## ${MARKETS_HEADER[lang]}`);
  parts.push('');
  parts.push(renderMarketsTable(markets, lang));
  parts.push('');
  parts.push(MARKET_COMMENTARY_HEADER[lang]);
  parts.push('');
  parts.push(pickLang(digest.marketCommentary, lang));
  parts.push('');
  parts.push(MACRO_WATCH_HEADER[lang]);
  parts.push('');
  parts.push(pickLang(digest.macroWatch, lang));
  parts.push('');
  parts.push('---');

  // Weather — kept verbatim in the briefing.
  parts.push('');
  parts.push(`## ${WEATHER_HEADER[lang]}`);
  parts.push('');
  parts.push(renderWeatherTable(weather, lang));
  parts.push('');
  parts.push('---');
  parts.push(READ_FULL_BOTTOM[lang](websiteUrl));

  return parts.join('\n');
}

// Convenience: assemble all four markdown forms in one call. Used by the
// pipeline so a successful structured Sonnet response yields everything
// downstream stages need (landing markdown, EN/PL briefings, Polish full
// digest for the optional /pl landing).
export interface AssembledDigest {
  fullDigestEn: string;
  fullDigestPl: string;
  briefingEn: string;
  briefingPl: string;
}

export function assembleAll(digest: StructuredDigest, opts: AssembleOptions): AssembledDigest {
  return {
    fullDigestEn: assembleFullDigest(digest, 'en', opts),
    fullDigestPl: assembleFullDigest(digest, 'pl', opts),
    briefingEn:   assembleEmailBriefing(digest, 'en', opts),
    briefingPl:   assembleEmailBriefing(digest, 'pl', opts),
  };
}
