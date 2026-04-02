// Landing page HTML template for AI News Digest
// CNN/Economist-inspired: red + white, 3-column newspaper layout

import { markdownToHtml } from './email';
import type { DigestData, WeatherData, MarketData } from './types';

// ── Helpers ──

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateSlug(text: string): string {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
}

// ── Section splitting ──

interface DigestSection {
  slug: string;
  emoji: string;
  title: string;
  html: string;
  rawTitle: string; // original title with emoji for classification
}

// Keywords to classify sections into columns
const LEFT_KEYWORDS = ['poland', 'cyprus', 'nepal', 'ukraine', 'global south', 'roundup', 'regional', 'science', 'research', 'climate', 'environment', 'health'];
const RIGHT_KEYWORDS = ['editorial', 'deep dive', 'analysis', 'opinion', 'also notable', 'notable', 'markets', 'currencies', 'weather', 'forecast'];
// Everything else goes center (politics, tech, business, etc.)

type Column = 'left' | 'center' | 'right';

function classifySection(title: string): Column {
  const t = title.toLowerCase();
  for (const kw of LEFT_KEYWORDS) {
    if (t.includes(kw)) return 'left';
  }
  for (const kw of RIGHT_KEYWORDS) {
    if (t.includes(kw)) return 'right';
  }
  return 'center';
}

/** Split digest markdown into individual sections by --- separators and ## headers */
function splitDigestSections(markdown: string): DigestSection[] {
  const sections: DigestSection[] = [];
  const chunks = markdown.split(/\n---\n/);

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const headerMatch = trimmed.match(/^(#{2,3})\s+(.+)$/m);
    if (!headerMatch) {
      if (trimmed.length > 100 && !trimmed.startsWith('# ')) {
        sections.push({ slug: 'intro', emoji: '', title: 'Overview', rawTitle: 'Overview', html: markdownToHtml(trimmed) });
      }
      continue;
    }

    const fullTitle = headerMatch[2].trim();
    // Match common emoji patterns: flag pairs (🇵🇱), presentation emojis (🏛️), ZWJ sequences
    const emojiMatch = fullTitle.match(/^([\u{1F1E0}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]+)\s*/u);
    const emoji = emojiMatch ? emojiMatch[1] : '';
    const title = emoji ? fullTitle.slice(emojiMatch![0].length).trim() : fullTitle;
    const slug = generateSlug(fullTitle);

    if (!slug) continue;

    const body = trimmed.replace(/^#\s+.+\n*/m, '').trim();
    const html = markdownToHtml(body);

    sections.push({ slug, emoji, title, rawTitle: fullTitle, html });
  }

  return sections;
}

/** Extract a section from digest markdown by matching slug against h2/h3 headers */
function extractSectionBySlug(markdown: string, slug: string): string | null {
  const lines = markdown.split('\n');
  let capturing = false;
  const captured: string[] = [];
  const headerLevel = /^(#{2,3})\s+/;

  for (const line of lines) {
    const match = line.match(headerLevel);
    if (match) {
      const headerText = line.replace(headerLevel, '').trim();
      const headerSlug = generateSlug(headerText);
      if (headerSlug === slug) {
        capturing = true;
        captured.push(line);
        continue;
      } else if (capturing) {
        break;
      }
    }
    if (capturing) {
      captured.push(line);
    }
  }

  return captured.length > 0 ? captured.join('\n').trim() : null;
}

// ── Ticker belt rendering ──

function weatherEmoji(conditions: string): string {
  const c = conditions.toLowerCase();
  if (c.includes('clear') || c.includes('sunny')) return '☀️';
  if (c.includes('cloud') || c.includes('overcast')) return '⛅';
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return '🌧';
  if (c.includes('snow')) return '❄️';
  if (c.includes('thunder')) return '⛈';
  if (c.includes('fog')) return '🌫';
  return '🌤';
}

function renderTickerItems(weather: WeatherData[], markets: MarketData, feedStats: { total: number; succeeded: number }): string {
  const items: string[] = [];
  const sep = '<span class="ticker-sep">|</span>';

  for (const loc of weather) {
    const today = loc.days[0];
    if (today) {
      const name = loc.location.split(',')[0];
      const country = loc.location.includes('Cyprus') ? 'CY' : 'PL';
      items.push(`<span class="ticker-item"><span class="label">${escapeHtml(name)}, ${country}</span> <span class="val">${today.tempMax}°C ${weatherEmoji(today.conditions)}</span></span>`);
    }
  }

  for (const q of markets.quotes) {
    if (q.price !== null && q.change !== null) {
      const cls = q.change >= 0 ? 'up' : 'down';
      const sign = q.change >= 0 ? '+' : '';
      items.push(`<span class="ticker-item"><span class="label">${escapeHtml(q.name)}</span> <span class="val ${cls}">${sign}${q.change.toFixed(1)}%</span></span>`);
    }
  }

  for (const c of markets.currencies) {
    if (c.rate !== null) {
      items.push(`<span class="ticker-item"><span class="label">${escapeHtml(c.pair)}</span> <span class="val">${c.rate.toFixed(4)}</span></span>`);
    }
  }

  items.push(`<span class="ticker-item"><span class="label">Sources</span> <span class="val">${feedStats.succeeded}/${feedStats.total}</span></span>`);

  return items.join(sep);
}

// ── Sample digest markdown (fallback when KV is empty) ──

const SAMPLE_DIGEST = `## 🏛️ Global Politics

**EU Leaders Reach Historic Agreement on Digital Infrastructure Investment** — European Union member states have agreed on a landmark €45 billion package aimed at modernising digital infrastructure across the bloc, with a focus on AI research hubs and cross-border connectivity. ([Politico EU](https://example.com))

**Southeast Asian Nations Form Joint Climate Resilience Task Force** — ASEAN countries announced a new cooperative framework to address rising sea levels and extreme weather events affecting the region's coastal communities. ([Straits Times](https://example.com))

---

## 🤖 Technology and AI

**Open-Source Language Model Achieves Breakthrough in Multilingual Understanding** — A consortium of European research labs has released a new open-source language model that sets new benchmarks in understanding and generating text across 47 languages. ([TechCrunch](https://example.com))

**Wearable Health Sensors Now Capable of Real-Time Blood Sugar Monitoring** — A new generation of non-invasive wearable sensors promises continuous glucose monitoring without finger pricks. ([Wired](https://example.com))

---

## 🇵🇱 Poland

**Gdańsk Port Expansion Project Enters Final Phase** — The ambitious expansion of the Port of Gdańsk, set to make it one of the largest container terminals in the Baltic, has entered its final construction phase with completion expected by autumn. ([Gazeta Wyborcza](https://example.com))

---

## 🇨🇾 Cyprus

**Cyprus Approves New Renewable Energy Targets for 2030** — The Cypriot parliament has approved an updated national energy plan targeting 35% renewable energy in the electricity mix by 2030, up from the previous goal of 26%. ([Cyprus Mail](https://example.com))

---

## 🔬 Science and Research

**Deep-Sea Expedition Discovers New Species in Pacific Trench** — Marine biologists have catalogued over 30 previously unknown species during a month-long expedition to the Kermadec Trench, including bioluminescent organisms at depths exceeding 8,000 metres. ([Nature News](https://example.com))

---

## 🌍 Global South Roundup

**Kenya Launches East Africa's Largest Solar Farm** — A 300MW solar installation in Turkana County has begun feeding power into the East African grid, marking a milestone in the region's renewable energy ambitions. ([The Guardian](https://example.com))

---

## 📝 Editorial Deep Dives

**The Strait of Hormuz and Europe's Energy Vulnerability** — With tensions escalating in the Persian Gulf, Europe faces a reckoning over its continued dependency on Middle Eastern energy supplies. Analysts warn that even a brief closure could trigger fuel rationing. ([The Economist](https://example.com))
`;

const FALLBACK_TICKER = `
  <span class="ticker-item"><span class="label">Pegeia, CY</span> <span class="val">26°C ☀️</span></span>
  <span class="ticker-sep">|</span>
  <span class="ticker-item"><span class="label">Gdańsk, PL</span> <span class="val">11°C 🌧</span></span>
  <span class="ticker-sep">|</span>
  <span class="ticker-item"><span class="label">MSCI World</span> <span class="val up">+0.4%</span></span>
  <span class="ticker-sep">|</span>
  <span class="ticker-item"><span class="label">Gold</span> <span class="val up">+0.2%</span></span>
  <span class="ticker-sep">|</span>
  <span class="ticker-item"><span class="label">EUR/USD</span> <span class="val">1.0812</span></span>
  <span class="ticker-sep">|</span>
  <span class="ticker-item"><span class="label">USD/PLN</span> <span class="val down">3.97</span></span>
`;

// ── Styles ──

const PAGE_STYLES = `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --red: #CC0000;
    --red-dark: #990000;
    --white: #FFFFFF;
    --off-white: #F9F9F9;
    --grey-100: #E8E8E8;
    --grey-200: #D5D5D5;
    --grey-400: #999999;
    --grey-600: #666666;
    --grey-800: #333333;
    --grey-900: #1A1A1A;
    --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    --font-serif: Georgia, 'Times New Roman', serif;
  }

  body {
    font-family: var(--font);
    line-height: 1.6;
    color: var(--grey-900);
    background: var(--white);
    -webkit-font-smoothing: antialiased;
  }

  a { color: var(--red); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Ticker ── */
  .ticker {
    background: var(--red);
    color: var(--white);
    font-size: 13px;
    font-weight: 500;
    padding: 7px 0;
  }
  .ticker-inner {
    max-width: 100%;
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .ticker-label {
    font-weight: 800;
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 1.5px;
    white-space: nowrap;
    opacity: 0.85;
  }
  .ticker-items {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    align-items: center;
  }
  .ticker-item { white-space: nowrap; }
  .ticker-item .label { opacity: 0.8; }
  .ticker-item .val { font-weight: 700; }
  .ticker-item .up { color: #90EE90; }
  .ticker-item .down { color: #FFD700; }
  .ticker-sep { opacity: 0.3; }

  /* ── Header ── */
  .header {
    background: var(--white);
    border-bottom: 4px solid var(--red);
  }
  .header-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .header h1 {
    font-size: 34px;
    font-weight: 900;
    letter-spacing: 2px;
    text-transform: uppercase;
    color: var(--grey-900);
    line-height: 1;
  }
  .header h1 a { color: var(--grey-900); text-decoration: none; }
  .header h1 a:hover { color: var(--red); text-decoration: none; }
  .header-right { text-align: right; }
  .header-date { font-size: 14px; color: var(--grey-600); font-weight: 500; }
  .header-sources { font-size: 12px; color: var(--grey-400); margin-top: 2px; }

  /* ── 3-Column Newspaper Layout ── */
  .newspaper {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    display: grid;
    grid-template-columns: 260px 1fr 300px;
    gap: 0;
    border-top: 1px solid var(--grey-100);
  }

  /* Columns separated by vertical rules */
  .col-left {
    border-right: 1px solid var(--grey-200);
    padding: 20px 20px 32px 0;
  }
  .col-center {
    padding: 20px 24px 32px;
  }
  .col-right {
    border-left: 1px solid var(--grey-200);
    padding: 20px 0 32px 20px;
  }

  /* ── Section block (within a column) ── */
  .section-block {
    margin-bottom: 28px;
  }
  .section-block:last-child { margin-bottom: 0; }

  .section-title {
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--red);
    padding-bottom: 8px;
    border-bottom: 2px solid var(--red);
    margin-bottom: 14px;
  }
  .section-title a { color: var(--red); text-decoration: none; }
  .section-title a:hover { text-decoration: underline; }
  .section-title .emoji { margin-right: 4px; }

  /* Section divider between sections in same column */
  .section-block + .section-block {
    padding-top: 24px;
    border-top: 1px solid var(--grey-100);
  }

  /* ── Story content inside sections ── */
  .section-content h2, .section-content h3 { display: none; }
  .section-content hr { display: none; }

  .section-content p {
    font-family: var(--font-serif);
    font-size: 15px;
    line-height: 1.65;
    color: var(--grey-800);
    margin: 0 0 12px;
  }
  .section-content p:last-child { margin-bottom: 0; }

  .section-content p strong:first-child {
    display: block;
    font-family: var(--font);
    font-size: 16px;
    font-weight: 700;
    line-height: 1.35;
    color: var(--grey-900);
    margin-bottom: 4px;
  }
  .section-content p + p strong:first-child {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--grey-100);
  }

  .section-content a { color: var(--grey-400); font-size: 13px; }
  .section-content a:hover { color: var(--red); }

  .section-content table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
  .section-content th { background: var(--red); color: var(--white); padding: 7px 10px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .section-content td { padding: 6px 10px; border-bottom: 1px solid var(--grey-100); font-size: 13px; }
  .section-content tr:nth-child(even) { background: var(--off-white); }
  .section-content ul { padding-left: 18px; margin: 8px 0; }
  .section-content li { font-family: var(--font-serif); font-size: 14px; line-height: 1.55; margin: 4px 0; color: var(--grey-800); }
  .section-content blockquote { border-left: 3px solid var(--red); margin: 10px 0; padding: 8px 14px; background: var(--off-white); color: var(--grey-800); font-style: italic; font-size: 14px; }

  /* ── Center column: larger typography for lead stories ── */
  .col-center .section-content p {
    font-size: 16px;
    line-height: 1.7;
  }
  .col-center .section-content p strong:first-child {
    font-size: 18px;
  }
  .col-center .section-title {
    font-size: 13px;
    letter-spacing: 1.5px;
  }

  /* ── Right column: smaller, denser ── */
  .col-right .section-content p {
    font-size: 14px;
    line-height: 1.55;
  }
  .col-right .section-content p strong:first-child {
    font-size: 15px;
  }
  .col-right .section-title {
    font-size: 11px;
  }

  /* ── Subscribe box (in right column) ── */
  .subscribe-box {
    background: var(--red);
    color: var(--white);
    padding: 20px;
    margin-top: 24px;
  }
  .subscribe-box h3 {
    font-size: 18px;
    font-weight: 800;
    margin-bottom: 8px;
  }
  .subscribe-box p {
    font-size: 13px;
    opacity: 0.9;
    margin-bottom: 14px;
    line-height: 1.5;
  }
  .subscribe-box form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .subscribe-box input[type="email"] {
    padding: 9px 12px;
    border: 2px solid rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.12);
    color: var(--white);
    font-size: 14px;
    font-family: var(--font);
    outline: none;
    width: 100%;
  }
  .subscribe-box input[type="email"]::placeholder { color: rgba(255,255,255,0.5); }
  .subscribe-box input[type="email"]:focus { border-color: var(--white); background: rgba(255,255,255,0.2); }
  .subscribe-box button {
    padding: 9px 20px;
    background: var(--white);
    color: var(--red);
    border: none;
    font-size: 14px;
    font-weight: 800;
    font-family: var(--font);
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    transition: background 0.2s;
  }
  .subscribe-box button:hover { background: var(--grey-900); color: var(--white); }
  .subscribe-note {
    font-size: 11px;
    opacity: 0.7;
    margin-top: 6px;
  }

  /* ── Full-width subscribe banner (for story pages) ── */
  .subscribe-banner {
    background: var(--red);
    color: var(--white);
    padding: 28px 0;
  }
  .subscribe-banner-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
  }
  .subscribe-banner-inner h2 { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  .subscribe-banner-inner p { font-size: 14px; opacity: 0.9; }
  .subscribe-banner-inner form {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  }
  .subscribe-banner-inner input[type="email"] {
    padding: 10px 16px; border: 2px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.15);
    color: var(--white); font-size: 15px; font-family: var(--font); width: 280px; outline: none;
  }
  .subscribe-banner-inner input[type="email"]::placeholder { color: rgba(255,255,255,0.6); }
  .subscribe-banner-inner input[type="email"]:focus { border-color: var(--white); }
  .subscribe-banner-inner button {
    padding: 10px 28px; background: var(--white); color: var(--red); border: none;
    font-size: 15px; font-weight: 800; font-family: var(--font); cursor: pointer; text-transform: uppercase;
  }
  .subscribe-banner-inner button:hover { background: var(--grey-900); color: var(--white); }

  /* ── Footer ── */
  .footer {
    background: var(--grey-900);
    color: var(--grey-400);
    padding: 20px 0;
  }
  .footer-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 13px;
  }

  /* ── Story reading view ── */
  .reading-view {
    max-width: 740px;
    margin: 0 auto;
    padding: 32px 24px 48px;
  }
  .back-link {
    display: inline-block;
    font-size: 13px;
    font-weight: 600;
    color: var(--red);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 24px;
    text-decoration: none;
  }
  .back-link:hover { text-decoration: underline; }

  .reading-view .section-content h2 {
    display: block;
    font-size: 28px;
    font-weight: 800;
    color: var(--grey-900);
    margin: 0 0 20px;
    padding-bottom: 12px;
    border-bottom: 3px solid var(--red);
  }
  .reading-view .section-content h3 {
    display: block;
    font-size: 20px;
    font-weight: 700;
    color: var(--grey-900);
    margin: 28px 0 12px;
  }
  .reading-view .section-content p {
    font-family: var(--font-serif);
    font-size: 17px;
    line-height: 1.8;
    color: var(--grey-800);
    margin: 0 0 18px;
  }
  .reading-view .section-content p strong:first-child {
    display: block;
    font-family: var(--font);
    font-size: 20px;
    line-height: 1.4;
    color: var(--grey-900);
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--grey-200);
    margin-bottom: 6px;
  }
  .reading-view .section-content p:first-of-type strong:first-child {
    border-top: none; margin-top: 0; padding-top: 0;
  }
  .reading-view .section-content hr { display: block; border: none; border-top: 1px solid var(--grey-200); margin: 32px 0; }
  .reading-view .section-content a { color: var(--grey-400); font-size: 14px; }
  .reading-view .section-content a:hover { color: var(--red); }
  .reading-view .section-content table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 15px; }
  .reading-view .section-content th { background: var(--red); color: var(--white); padding: 10px 14px; text-align: left; font-weight: 600; }
  .reading-view .section-content td { padding: 8px 14px; border-bottom: 1px solid var(--grey-100); }
  .reading-view .section-content tr:nth-child(even) { background: var(--off-white); }
  .reading-view .section-content blockquote { border-left: 3px solid var(--red); margin: 16px 0; padding: 10px 20px; background: var(--off-white); font-style: italic; }
  .reading-view .section-content ul { padding-left: 24px; margin: 12px 0; }
  .reading-view .section-content li { font-family: var(--font-serif); font-size: 17px; line-height: 1.7; margin: 6px 0; }

  /* ── Sample note ── */
  .sample-note {
    background: var(--off-white);
    border-left: 4px solid var(--red);
    padding: 10px 16px;
    font-size: 13px;
    color: var(--grey-600);
    margin-bottom: 16px;
  }

  /* ── Responsive ── */
  @media (max-width: 1024px) {
    .newspaper {
      grid-template-columns: 1fr 280px;
    }
    .col-left { display: none; }
    .col-center { border-right: none; padding-left: 0; }
    /* Move left-column sections into center on tablet */
  }
  @media (max-width: 720px) {
    .newspaper {
      grid-template-columns: 1fr;
    }
    .col-left, .col-right { display: block; border: none; padding: 16px 0; }
    .col-center { padding: 16px 0; border: none; }
    .col-left { order: 2; border-top: 1px solid var(--grey-200); }
    .col-right { order: 3; border-top: 1px solid var(--grey-200); }
    .header h1 { font-size: 22px; letter-spacing: 1px; }
    .ticker-inner { font-size: 11px; gap: 10px; }
    .subscribe-banner-inner { flex-direction: column; text-align: center; }
    .subscribe-banner-inner input[type="email"] { width: 100%; }
    .reading-view .section-content p { font-size: 16px; }
  }
</style>`;

// ── Page shell ──

function pageHead(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="AI News Digest — daily world news from 38+ international sources, compiled by AI.">
  ${PAGE_STYLES}
</head>`;
}

function pageHeader(dateStr: string, tickerContent: string, sourceInfo?: string): string {
  return `
  <div class="ticker"><div class="ticker-inner"><span class="ticker-label">Live</span><div class="ticker-items">${tickerContent}</div></div></div>
  <header class="header">
    <div class="header-inner">
      <h1><a href="/">AI News Digest</a></h1>
      <div class="header-right">
        <div class="header-date">${dateStr}</div>
        ${sourceInfo ? `<div class="header-sources">${sourceInfo}</div>` : ''}
      </div>
    </div>
  </header>`;
}

function subscribeBanner(): string {
  return `
  <div class="subscribe-banner">
    <div class="subscribe-banner-inner">
      <div>
        <h2>Get the digest in your inbox</h2>
        <p>38+ international sources, one concise briefing every morning.</p>
      </div>
      <form onsubmit="return false;">
        <input type="email" placeholder="your@email.com" aria-label="Email address" required>
        <button type="submit">Subscribe Free</button>
      </form>
    </div>
  </div>`;
}

function pageFooter(): string {
  return `
  <footer class="footer">
    <div class="footer-inner">
      <span>Compiled daily by Claude on Cloudflare Workers</span>
      <span>&copy; ${new Date().getFullYear()} AI News Digest</span>
    </div>
  </footer>
</body>
</html>`;
}

// ── Render a section block ──

function renderSectionBlock(section: DigestSection, date: string): string {
  const emojiSpan = section.emoji ? `<span class="emoji">${section.emoji}</span>` : '';
  return `
    <div class="section-block">
      <div class="section-title"><a href="/story/${date}/${section.slug}">${emojiSpan}${escapeHtml(section.title)}</a></div>
      <div class="section-content">${section.html}</div>
    </div>`;
}

// ── Main export: landing page ──

export function buildLandingPage(data?: DigestData | null): string {
  const hasDigest = data?.digestMarkdown != null;
  const isLive = data != null;

  const displayDate = isLive ? data.date : new Date().toISOString().slice(0, 10);
  const dateObj = new Date(displayDate + 'T12:00:00Z');
  const dateStr = dateObj.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const tickerContent = isLive
    ? renderTickerItems(data.weather, data.markets, data.feedStats)
    : FALLBACK_TICKER;

  const sourceInfo = isLive
    ? `Compiled from ${data.feedStats.succeeded} of ${data.feedStats.total} sources`
    : 'Compiled from 38+ sources';

  const digestMd = hasDigest ? data.digestMarkdown! : SAMPLE_DIGEST;
  const sections = splitDigestSections(digestMd);

  const sampleNote = hasDigest
    ? ''
    : '<div class="sample-note">Preview with sample articles — subscribe to receive the real daily digest.</div>';

  const date = isLive ? data.date : displayDate;

  // Classify sections into 3 columns
  const leftSections: DigestSection[] = [];
  const centerSections: DigestSection[] = [];
  const rightSections: DigestSection[] = [];

  for (const section of sections) {
    const col = classifySection(section.title);
    if (col === 'left') leftSections.push(section);
    else if (col === 'right') rightSections.push(section);
    else centerSections.push(section);
  }

  // If center is empty, move first left section there
  if (centerSections.length === 0 && leftSections.length > 0) {
    centerSections.push(leftSections.shift()!);
  }

  const leftHtml = leftSections.map(s => renderSectionBlock(s, date)).join('');
  const centerHtml = centerSections.map(s => renderSectionBlock(s, date)).join('');
  const rightHtml = rightSections.map(s => renderSectionBlock(s, date)).join('');

  return `${pageHead('AI News Digest — Daily World News from 38+ Sources')}
<body>
  ${pageHeader(dateStr, tickerContent, sourceInfo)}

  <div class="newspaper">
    <div class="col-left">
      ${sampleNote}
      ${leftHtml || '<div class="section-block"><div class="section-title">Regional</div><div class="section-content"><p>No regional stories today.</p></div></div>'}
    </div>

    <div class="col-center">
      ${centerHtml}
    </div>

    <div class="col-right">
      ${rightHtml}
      <div class="subscribe-box">
        <h3>Get the digest in your inbox</h3>
        <p>38+ sources, distilled by AI into one briefing every morning.</p>
        <form onsubmit="return false;">
          <input type="email" placeholder="your@email.com" aria-label="Email address" required>
          <button type="submit">Subscribe Free</button>
        </form>
        <div class="subscribe-note">One email per day. Unsubscribe anytime.</div>
      </div>
    </div>
  </div>

  ${pageFooter()}`;
}

// ── Story page export ──

export function buildStoryPage(data: DigestData, slug: string): string {
  const sectionMd = data.digestMarkdown ? extractSectionBySlug(data.digestMarkdown, slug) : null;

  if (!sectionMd) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title></head><body><h1>Story not found</h1><p><a href="/">Back to digest</a></p></body></html>`;
  }

  const sectionHtml = markdownToHtml(sectionMd);
  const dateObj = new Date(data.date + 'T12:00:00Z');
  const dateStr = dateObj.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const tickerContent = renderTickerItems(data.weather, data.markets, data.feedStats);
  const sourceInfo = `Compiled from ${data.feedStats.succeeded} of ${data.feedStats.total} sources`;

  return `${pageHead('AI News Digest — ' + escapeHtml(slug.replace(/-/g, ' ')))}
<body>
  ${pageHeader(dateStr, tickerContent, sourceInfo)}
  <div class="reading-view">
    <a href="/" class="back-link">&larr; Back to full digest</a>
    <div class="section-content">${sectionHtml}</div>
  </div>
  ${subscribeBanner()}
  ${pageFooter()}`;
}
