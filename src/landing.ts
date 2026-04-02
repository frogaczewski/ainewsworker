// Landing page HTML template for AI News Digest
// CNN/Economist-inspired redesign: red + white, sans-serif, full-width card grid

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
}

/** Split digest markdown into individual sections by --- separators and ## headers */
function splitDigestSections(markdown: string): DigestSection[] {
  const sections: DigestSection[] = [];
  const chunks = markdown.split(/\n---\n/);

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    // Find the first ## or ### header
    const headerMatch = trimmed.match(/^(#{2,3})\s+(.+)$/m);
    if (!headerMatch) {
      // No header found — skip (e.g. the title line "# Daily News Digest...")
      // But if it has substantial content, wrap it
      if (trimmed.length > 100 && !trimmed.startsWith('# ')) {
        sections.push({ slug: 'intro', emoji: '', title: 'Overview', html: markdownToHtml(trimmed) });
      }
      continue;
    }

    const fullTitle = headerMatch[2].trim();
    // Extract emoji (first char or two if it's an emoji)
    const emojiMatch = fullTitle.match(/^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?(?:\u200D\p{Emoji}\uFE0F?)*)\s*/u);
    const emoji = emojiMatch ? emojiMatch[1] : '';
    const title = emoji ? fullTitle.slice(emojiMatch![0].length).trim() : fullTitle;
    const slug = generateSlug(fullTitle);

    if (!slug) continue;

    // Convert the chunk body (without the leading # title if present) to HTML
    // Remove the first "# Title" line if it exists before the section
    const body = trimmed.replace(/^#\s+.+\n*/m, '').trim();
    const html = markdownToHtml(body);

    sections.push({ slug, emoji, title, html });
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
    --red-hover: #A30000;
    --white: #FFFFFF;
    --off-white: #F5F5F5;
    --grey-50: #FAFAFA;
    --grey-100: #EEEEEE;
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
    background: var(--off-white);
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
    overflow: hidden;
  }
  .ticker-inner {
    max-width: 1400px;
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
    padding: 14px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .header h1 {
    font-size: 32px;
    font-weight: 900;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--grey-900);
    line-height: 1;
  }
  .header h1 a { color: var(--grey-900); text-decoration: none; }
  .header h1 a:hover { color: var(--red); text-decoration: none; }
  .header-right {
    text-align: right;
  }
  .header-date {
    font-size: 14px;
    color: var(--grey-600);
    font-weight: 500;
  }
  .header-sources {
    font-size: 12px;
    color: var(--grey-400);
    margin-top: 2px;
  }

  /* ── Info bar ── */
  .info-bar {
    background: var(--white);
    border-bottom: 1px solid var(--grey-100);
    padding: 8px 0;
  }
  .info-bar-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    font-size: 13px;
    color: var(--grey-600);
    font-style: italic;
  }

  /* ── Hero section ── */
  .hero {
    max-width: 1400px;
    margin: 0 auto;
    padding: 32px 24px 24px;
  }
  .hero-card {
    background: var(--white);
    border-top: 4px solid var(--red);
    box-shadow: 0 1px 6px rgba(0,0,0,0.06);
    padding: 0;
  }
  .hero-card .card-header {
    padding: 14px 24px;
    border-bottom: 1px solid var(--grey-100);
  }
  .hero-card .card-header h2 {
    font-size: 14px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1.2px;
    color: var(--red);
    margin: 0;
  }
  .hero-card .card-header h2 a { color: var(--red); }
  .hero-card .card-body {
    padding: 20px 24px 28px;
    columns: 2;
    column-gap: 32px;
  }
  .hero-card .card-body p {
    font-size: 15px;
    line-height: 1.7;
    color: var(--grey-800);
    margin: 0 0 14px;
    break-inside: avoid;
  }
  .hero-card .card-body p strong:first-child {
    display: block;
    font-size: 17px;
    line-height: 1.4;
    color: var(--grey-900);
    margin-bottom: 4px;
  }
  .hero-card .card-body a { color: var(--grey-400); font-size: 13px; }
  .hero-card .card-body a:hover { color: var(--red); }

  /* ── Section cards grid ── */
  .grid-wrap {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px 32px;
  }
  .sections-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
  }
  .section-card {
    background: var(--white);
    border-top: 3px solid var(--red);
    box-shadow: 0 1px 4px rgba(0,0,0,0.05);
    display: flex;
    flex-direction: column;
  }
  .card-header {
    padding: 12px 18px;
    border-bottom: 1px solid var(--grey-100);
  }
  .card-header h2 {
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--red);
    margin: 0;
  }
  .card-header h2 a { color: var(--red); }
  .card-header h2 a:hover { text-decoration: underline; }
  .card-header .emoji { margin-right: 6px; }
  .card-body {
    padding: 16px 18px 20px;
    flex: 1;
  }
  .card-body p {
    font-size: 14px;
    line-height: 1.65;
    color: var(--grey-800);
    margin: 0 0 12px;
  }
  .card-body p:last-child { margin-bottom: 0; }
  .card-body p strong:first-child {
    display: block;
    font-size: 15px;
    font-weight: 700;
    line-height: 1.35;
    color: var(--grey-900);
    margin-bottom: 3px;
  }
  .card-body p + p strong:first-child {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--grey-100);
  }
  .card-body a { color: var(--grey-400); font-size: 12px; }
  .card-body a:hover { color: var(--red); }
  .card-body h2, .card-body h3 { display: none; }
  .card-body hr { display: none; }
  .card-body table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
  .card-body th { background: var(--red); color: var(--white); padding: 8px 12px; text-align: left; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }
  .card-body td { padding: 7px 12px; border-bottom: 1px solid var(--grey-100); font-size: 13px; }
  .card-body tr:nth-child(even) { background: var(--grey-50); }
  .card-body ul { padding-left: 18px; margin: 8px 0; }
  .card-body li { font-size: 14px; line-height: 1.55; margin: 4px 0; color: var(--grey-800); }
  .card-body blockquote { border-left: 3px solid var(--red); margin: 10px 0; padding: 8px 14px; background: var(--grey-50); color: var(--grey-800); font-style: italic; font-size: 14px; }

  /* Card that spans 2 columns */
  .card-wide { grid-column: span 2; }
  .card-wide .card-body { columns: 2; column-gap: 24px; }
  .card-wide .card-body p { break-inside: avoid; }

  /* ── Subscribe banner ── */
  .subscribe-banner {
    background: var(--red);
    color: var(--white);
    padding: 28px 0;
    margin-top: 8px;
  }
  .sections-grid .subscribe-banner {
    grid-column: 1 / -1;
    margin: 0 -24px;
    padding: 28px 24px;
  }
  .subscribe-inner {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
  }
  .subscribe-text h2 {
    font-size: 22px;
    font-weight: 800;
    margin-bottom: 4px;
  }
  .subscribe-text p {
    font-size: 14px;
    opacity: 0.9;
  }
  .subscribe-form {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .subscribe-form input[type="email"] {
    padding: 10px 16px;
    border: 2px solid rgba(255,255,255,0.3);
    background: rgba(255,255,255,0.15);
    color: var(--white);
    font-size: 15px;
    font-family: var(--font);
    width: 280px;
    border-radius: 0;
    outline: none;
    transition: border-color 0.2s;
  }
  .subscribe-form input[type="email"]::placeholder { color: rgba(255,255,255,0.6); }
  .subscribe-form input[type="email"]:focus { border-color: var(--white); background: rgba(255,255,255,0.2); }
  .subscribe-form button {
    padding: 10px 28px;
    background: var(--white);
    color: var(--red);
    border: none;
    font-size: 15px;
    font-weight: 800;
    font-family: var(--font);
    cursor: pointer;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    transition: background 0.2s, color 0.2s;
  }
  .subscribe-form button:hover { background: var(--grey-900); color: var(--white); }

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

  /* ── Story page (single column reading view) ── */
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
  .reading-view .digest-content h2 {
    font-size: 28px;
    font-weight: 800;
    color: var(--grey-900);
    margin: 0 0 20px;
    padding-bottom: 12px;
    border-bottom: 3px solid var(--red);
  }
  .reading-view .digest-content h3 {
    font-size: 20px;
    font-weight: 700;
    color: var(--grey-900);
    margin: 28px 0 12px;
  }
  .reading-view .digest-content p {
    font-family: var(--font-serif);
    font-size: 17px;
    line-height: 1.8;
    color: var(--grey-800);
    margin: 0 0 18px;
  }
  .reading-view .digest-content p strong:first-child {
    display: block;
    font-family: var(--font);
    font-size: 19px;
    line-height: 1.4;
    color: var(--grey-900);
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--grey-200);
    margin-bottom: 6px;
  }
  .reading-view .digest-content p:first-of-type strong:first-child {
    border-top: none; margin-top: 0; padding-top: 0;
  }
  .reading-view .digest-content a { color: var(--grey-400); font-size: 14px; }
  .reading-view .digest-content a:hover { color: var(--red); }
  .reading-view .digest-content hr { border: none; border-top: 1px solid var(--grey-200); margin: 32px 0; }
  .reading-view .digest-content table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 15px; }
  .reading-view .digest-content th { background: var(--red); color: var(--white); padding: 10px 14px; text-align: left; font-weight: 600; }
  .reading-view .digest-content td { padding: 8px 14px; border-bottom: 1px solid var(--grey-100); }
  .reading-view .digest-content tr:nth-child(even) { background: var(--grey-50); }
  .reading-view .digest-content blockquote { border-left: 3px solid var(--red); margin: 16px 0; padding: 10px 20px; background: var(--grey-50); font-style: italic; }
  .reading-view .digest-content ul { padding-left: 24px; margin: 12px 0; }
  .reading-view .digest-content li { font-family: var(--font-serif); font-size: 17px; line-height: 1.7; margin: 6px 0; }

  /* ── Sample note ── */
  .sample-note {
    background: var(--white);
    border-left: 4px solid var(--red);
    padding: 12px 18px;
    font-size: 14px;
    color: var(--grey-600);
    margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.04);
  }

  /* ── Responsive ── */
  @media (max-width: 1024px) {
    .sections-grid { grid-template-columns: repeat(2, 1fr); }
    .card-wide { grid-column: span 2; }
    .card-wide .card-body { columns: 1; }
    .hero-card .card-body { columns: 1; }
  }
  @media (max-width: 640px) {
    .sections-grid { grid-template-columns: 1fr; }
    .card-wide { grid-column: span 1; }
    .header h1 { font-size: 22px; letter-spacing: 1px; }
    .hero-card .card-body { padding: 16px; }
    .subscribe-inner { flex-direction: column; text-align: center; }
    .subscribe-form { justify-content: center; width: 100%; }
    .subscribe-form input[type="email"] { width: 100%; }
    .ticker-inner { font-size: 11px; gap: 10px; }
    .reading-view .digest-content p { font-size: 16px; }
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
  <div class="ticker"><div class="ticker-inner"><span class="ticker-label">Live Data</span><div class="ticker-items">${tickerContent}</div></div></div>
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
    <div class="subscribe-inner">
      <div class="subscribe-text">
        <h2>Get the digest in your inbox</h2>
        <p>38+ international sources, distilled into one concise briefing every morning.</p>
      </div>
      <form class="subscribe-form" onsubmit="return false;">
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

// ── Render section card ──

function renderCard(section: DigestSection, date: string, wide: boolean = false): string {
  const cls = wide ? 'section-card card-wide' : 'section-card';
  const emojiSpan = section.emoji ? `<span class="emoji">${section.emoji}</span>` : '';
  return `
    <div class="${cls}">
      <div class="card-header">
        <h2><a href="/story/${date}/${section.slug}">${emojiSpan}${escapeHtml(section.title)}</a></h2>
      </div>
      <div class="card-body">${section.html}</div>
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
    : '<div class="sample-note">Preview with sample articles — subscribe to receive the real daily digest every morning.</div>';

  const date = isLive ? data.date : displayDate;

  // Hero: first section gets large treatment
  const hero = sections[0];
  const rest = sections.slice(1);

  // Build hero card
  const heroHtml = hero ? `
    <div class="hero">
      ${sampleNote}
      <div class="hero-card">
        <div class="card-header">
          <h2><a href="/story/${date}/${hero.slug}">${hero.emoji ? `<span class="emoji">${hero.emoji}</span>` : ''}${escapeHtml(hero.title)}</a></h2>
        </div>
        <div class="card-body">${hero.html}</div>
      </div>
    </div>` : `<div class="hero">${sampleNote}</div>`;

  // Build grid cards — insert subscribe banner after every 3 cards
  const gridCards: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    // Make first card in grid wide if there are enough cards
    const wide = i === 0 && rest.length >= 4;
    gridCards.push(renderCard(rest[i], date, wide));
    if (i === 2) {
      gridCards.push(subscribeBanner());
    }
  }
  // If less than 3 cards, add subscribe at end
  if (rest.length <= 2) {
    gridCards.push(subscribeBanner());
  }

  return `${pageHead('AI News Digest — Daily World News from 38+ Sources')}
<body>
  ${pageHeader(dateStr, tickerContent, sourceInfo)}
  ${heroHtml}
  <div class="grid-wrap">
    <div class="sections-grid">
      ${gridCards.join('\n')}
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
    <div class="digest-content">${sectionHtml}</div>
  </div>
  ${subscribeBanner()}
  ${pageFooter()}`;
}
