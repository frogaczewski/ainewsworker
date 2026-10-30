// Markdown assembly for the editorial editions (src/editorial.ts). The model
// writes prose only; everything structural — headings, the per-story list of
// outlets that covered it, timelines, weather/market tables — is rendered here
// from the clusters, so every story shows exactly which outlets reported it.
// Output feeds the same consumers as digest-builder.ts (email, landing page).

import {
  COMPILED_FROM,
  FOOTER,
  MARKETS_HEADER,
  READ_FULL_BOTTOM,
  SECTION_HEADERS,
  TITLES,
  WEATHER_HEADER,
  formatDate,
  pickLang,
  renderMarketsTable,
  renderWeatherTable,
  sourcesNote,
  type AssembledDigest,
  type Lang,
} from './digest-builder';
import type {
  BilingualText,
  ClusterItem,
  DailyEdition,
  DailySectionKind,
  EditionStory,
  MarketData,
  StoryCluster,
  WeatherData,
  WeeklyEdition,
} from './types';

export interface EditionRenderOptions {
  websiteUrl: string;
  dateString: string;   // YYYY-MM-DD digest date
  feedStats: { total: number; failed: number };
  weather: WeatherData[];
  markets: MarketData;
}

const DAILY_HEADERS: Record<DailySectionKind, Record<Lang, string>> = {
  top:          { en: '🗞️ Top Stories',          pl: '🗞️ Najważniejsze' },
  poland:       SECTION_HEADERS.poland,
  world:        { en: '🌐 Around the World',     pl: '🌐 Ze świata' },
  business:     SECTION_HEADERS.business,
  science_tech: { en: '🔬 Science & Technology', pl: '🔬 Nauka i technologia' },
  sports:       SECTION_HEADERS.sports,
  culture:      SECTION_HEADERS.culture,
};

// Sections written as full paragraphs with a coverage note and sources line;
// the rest render as one-line bullets.
const PROSE_SECTIONS = new Set<DailySectionKind>(['top', 'poland']);

const WEEKLY_TITLE: Record<Lang, string> = { en: 'Weekly Review', pl: 'Przegląd Tygodnia' };
const ALSO_THIS_WEEK: Record<Lang, string> = { en: '📌 Also This Week', pl: '📌 Także w tym tygodniu' };
const HOW_IT_UNFOLDED: Record<Lang, string> = { en: 'How it unfolded', pl: 'Jak to się rozwijało' };
const HOW_COVERED: Record<Lang, string> = { en: 'How it was covered:', pl: 'Jak relacjonowano:' };
const WEATHER_ALERT: Record<Lang, string> = { en: '🌦️ Weather watch:', pl: '🌦️ Pogoda:' };
const WEEKLY_COMPILED: Record<Lang, (s: string) => string> = {
  en: (s) => `*The week's news from ${s}, followed day by day and compared across outlets.*`,
  pl: (s) => `*Wiadomości tygodnia na podstawie: ${s}, śledzone dzień po dniu i porównane między redakcjami.*`,
};

// ──────────────────────────────────────────────────────────────────────────────
// Sources
// ──────────────────────────────────────────────────────────────────────────────

function plural(n: number, lang: Lang, en: [string, string], pl: [string, string, string]): string {
  if (lang === 'en') return `${n} ${n === 1 ? en[0] : en[1]}`;
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (n === 1) return `${n} ${pl[0]}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${pl[1]}`;
  return `${n} ${pl[2]}`;
}

// Distinct outlets across one or more clusters, first link per outlet.
function outletsOf(clusters: StoryCluster[]): ClusterItem[] {
  const byOutlet = new Map<string, ClusterItem>();
  for (const c of clusters) for (const it of c.items) if (!byOutlet.has(it.source)) byOutlet.set(it.source, it);
  return [...byOutlet.values()];
}

function link(it: ClusterItem): string {
  // Entities are decoded at parse time (rss-parser.ts); this also covers
  // clusters cached before that fix. Parens would end the markdown link early.
  const url = it.link
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
  return `[${it.source.replace(/[[\]]/g, '')}](${url})`;
}

function sourceLinks(outlets: ClusterItem[], max: number, lang: Lang): string {
  const shown = outlets.slice(0, max).map(link).join(' · ');
  const rest = outlets.length - max;
  if (rest <= 0) return shown;
  return `${shown} ${lang === 'pl' ? `+ ${rest} innych` : `+ ${rest} more`}`;
}

function sourcesLine(outlets: ClusterItem[], max: number, lang: Lang): string {
  if (outlets.length === 0) return '';
  const regions = new Set(outlets.map(o => o.region)).size;
  let label: string;
  if (outlets.length === 1) {
    label = lang === 'pl' ? 'Źródło:' : 'Source:';
  } else {
    const count = plural(outlets.length, lang, ['outlet', 'outlets'], ['redakcja', 'redakcje', 'redakcji']);
    const regionText = regions > 1
      ? ` · ${plural(regions, lang, ['region', 'regions'], ['region', 'regiony', 'regionów'])}`
      : '';
    label = `${lang === 'pl' ? 'Źródła' : 'Sources'} (${count}${regionText}):`;
  }
  return `*${label}* ${sourceLinks(outlets, max, lang)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Text hygiene — model prose is plain text; keep it from breaking the layout.
// ──────────────────────────────────────────────────────────────────────────────

function oneLine(t: BilingualText, lang: Lang): string {
  return pickLang(t, lang).replace(/\s*\n+\s*/g, ' ').replace(/^[#>\-\s]+/, '').trim();
}

function paragraphs(t: BilingualText, lang: Lang): string {
  return pickLang(t, lang)
    .split(/\n\s*\n/)
    .map(p => p.replace(/\s*\n\s*/g, ' ').replace(/^[#>\-\s]+/, '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ──────────────────────────────────────────────────────────────────────────────
// Daily
// ──────────────────────────────────────────────────────────────────────────────

function renderProseStory(story: EditionStory, cluster: StoryCluster, lang: Lang): string {
  const parts = [`**${oneLine(story.headline, lang)}**`, '', oneLine(story.body, lang)];
  const coverage = oneLine(story.coverage, lang);
  if (coverage && cluster.outletCount > 1) parts.push('', `*${HOW_COVERED[lang]}* ${coverage}`);
  parts.push('', sourcesLine(outletsOf([cluster]), 6, lang));
  return parts.join('\n');
}

function renderBulletStory(story: EditionStory, cluster: StoryCluster, lang: Lang): string {
  const coverage = oneLine(story.coverage, lang);
  const coverageText = coverage && cluster.outletCount > 1 ? ` *${HOW_COVERED[lang]}* ${coverage}` : '';
  return `- **${oneLine(story.headline, lang)}**: ${oneLine(story.body, lang)}${coverageText} (${sourceLinks(outletsOf([cluster]), 3, lang)})`;
}

function assembleDailyLang(
  edition: DailyEdition,
  byId: Map<string, StoryCluster>,
  lang: Lang,
  opts: EditionRenderOptions,
  mode: 'full' | 'briefing',
): string {
  const parts: string[] = [
    `# ${TITLES[lang]} — ${formatDate(new Date(opts.dateString + 'T12:00:00Z'), lang)}`,
    '',
    COMPILED_FROM[lang](sourcesNote(opts.feedStats, lang)),
    '',
    '---',
  ];

  for (const section of edition.sections) {
    const lines: string[] = [`## ${DAILY_HEADERS[section.kind][lang]}`, ''];
    for (const story of section.stories) {
      const cluster = byId.get(story.id);
      if (!cluster) continue;
      if (PROSE_SECTIONS.has(section.kind)) {
        lines.push(renderProseStory(story, cluster, lang), '');
      } else {
        lines.push(renderBulletStory(story, cluster, lang));
      }
    }
    // A big weather change in Poland is news: it rides directly under the lead.
    const alert = oneLine(edition.weatherAlert, lang);
    if (section.kind === 'top' && alert) lines.push('', `**${WEATHER_ALERT[lang]}** ${alert}`);
    parts.push('', lines.join('\n').trimEnd(), '', '---');
  }

  parts.push('', `## ${MARKETS_HEADER[lang]}`, '', renderMarketsTable(opts.markets, lang));
  const marketNote = oneLine(edition.marketNote, lang);
  if (marketNote) parts.push('', marketNote);
  parts.push('', '---', '', `## ${WEATHER_HEADER[lang]}`, '', renderWeatherTable(opts.weather, lang), '', '---');
  parts.push(mode === 'full' ? FOOTER[lang](opts.websiteUrl) : READ_FULL_BOTTOM[lang](opts.websiteUrl));
  return parts.join('\n');
}

export function assembleDailyEdition(
  edition: DailyEdition,
  clusters: StoryCluster[],
  opts: EditionRenderOptions,
): AssembledDigest {
  const byId = new Map(clusters.map(c => [c.id, c]));
  return {
    fullDigestEn: assembleDailyLang(edition, byId, 'en', opts, 'full'),
    fullDigestPl: assembleDailyLang(edition, byId, 'pl', opts, 'full'),
    briefingEn: assembleDailyLang(edition, byId, 'en', opts, 'briefing'),
    briefingPl: assembleDailyLang(edition, byId, 'pl', opts, 'briefing'),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Weekly
// ──────────────────────────────────────────────────────────────────────────────

function shiftDate(date: string, days: number): Date {
  const d = new Date(date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// "24–30 October 2026" / "24–30 października 2026" — the news days Saturday…
// Friday covered by the weekly dated on the following Saturday.
export function weekRangeLabel(digestDate: string, lang: Lang): string {
  const locale = lang === 'pl' ? 'pl-PL' : 'en-GB';
  const start = shiftDate(digestDate, -7);
  const end = shiftDate(digestDate, -1);
  const endText = end.toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const sameMonth = start.getUTCMonth() === end.getUTCMonth();
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const startText = sameMonth
    ? String(start.getUTCDate())
    : start.toLocaleDateString(locale, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
  return `${startText}–${endText}`;
}

function timelineDay(day: string, lang: Lang): string {
  const d = new Date(day + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(lang === 'pl' ? 'pl-PL' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function assembleWeeklyLang(
  edition: WeeklyEdition,
  byId: Map<string, StoryCluster>,
  lang: Lang,
  opts: EditionRenderOptions,
  mode: 'full' | 'briefing',
): string {
  const parts: string[] = [
    `# ${WEEKLY_TITLE[lang]} — ${weekRangeLabel(opts.dateString, lang)}`,
    '',
    WEEKLY_COMPILED[lang](sourcesNote(opts.feedStats, lang)),
  ];
  const intro = paragraphs(edition.intro, lang);
  if (intro) parts.push('', intro);
  parts.push('', '---');

  edition.stories.forEach((story, n) => {
    const clusters = story.ids.map(id => byId.get(id)).filter((c): c is StoryCluster => !!c);
    const lines = [`## ${n + 1}. ${oneLine(story.headline, lang)}`, '', paragraphs(story.narrative, lang)];
    if (story.timeline.length > 0) {
      lines.push('', `**${HOW_IT_UNFOLDED[lang]}**`, '');
      for (const t of story.timeline) lines.push(`- **${timelineDay(t.day, lang)}** — ${oneLine(t.text, lang)}`);
    }
    const coverage = oneLine(story.coverage, lang);
    if (coverage) lines.push('', `*${HOW_COVERED[lang]}* ${coverage}`);
    const outlets = outletsOf(clusters);
    if (outlets.length > 0) lines.push('', sourcesLine(outlets, 8, lang));
    parts.push('', lines.join('\n'), '', '---');
  });

  if (edition.alsoThisWeek.length > 0) {
    const lines = [`## ${ALSO_THIS_WEEK[lang]}`, ''];
    for (const item of edition.alsoThisWeek) {
      const outlets = outletsOf(item.ids.map(id => byId.get(id)).filter((c): c is StoryCluster => !!c));
      const links = outlets.length > 0 ? ` (${sourceLinks(outlets, 3, lang)})` : '';
      lines.push(`- **${oneLine(item.headline, lang)}**: ${oneLine(item.text, lang)}${links}`);
    }
    parts.push('', lines.join('\n'), '', '---');
  }

  parts.push('', `## ${WEATHER_HEADER[lang]}`, '', renderWeatherTable(opts.weather, lang), '', '---');
  parts.push(mode === 'full' ? FOOTER[lang](opts.websiteUrl) : READ_FULL_BOTTOM[lang](opts.websiteUrl));
  return parts.join('\n');
}

export function assembleWeeklyEdition(
  edition: WeeklyEdition,
  clusters: StoryCluster[],
  opts: EditionRenderOptions,
): AssembledDigest {
  const byId = new Map(clusters.map(c => [c.id, c]));
  return {
    fullDigestEn: assembleWeeklyLang(edition, byId, 'en', opts, 'full'),
    fullDigestPl: assembleWeeklyLang(edition, byId, 'pl', opts, 'full'),
    briefingEn: assembleWeeklyLang(edition, byId, 'en', opts, 'briefing'),
    briefingPl: assembleWeeklyLang(edition, byId, 'pl', opts, 'briefing'),
  };
}
