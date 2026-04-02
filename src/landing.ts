// Landing page HTML template for AI News Digest

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

/** Extract a section from digest markdown by matching slug against h2/h3 headers */
function extractSectionBySlug(markdown: string, slug: string): string | null {
  const lines = markdown.split('\n');
  let capturing = false;
  let captured: string[] = [];
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

  items.push(`<span class="ticker-item"><span class="label">Sources today</span> <span class="val">${feedStats.succeeded} / ${feedStats.total}</span></span>`);

  return items.join(sep);
}

// ── Sample digest markdown (fallback when KV is empty) ──

const SAMPLE_DIGEST = `## 🏛️ Global Politics

**EU Leaders Reach Historic Agreement on Digital Infrastructure Investment** — European Union member states have agreed on a landmark €45 billion package aimed at modernising digital infrastructure across the bloc, with a focus on AI research hubs and cross-border connectivity. ([Politico EU](https://example.com))

**Southeast Asian Nations Form Joint Climate Resilience Task Force** — ASEAN countries announced a new cooperative framework to address rising sea levels and extreme weather events affecting the region's coastal communities. ([Straits Times](https://example.com))

---

## 🤖 Technology and AI

**Open-Source Language Model Achieves Breakthrough in Multilingual Understanding** — A consortium of European research labs has released a new open-source language model that sets new benchmarks in understanding and generating text across 47 languages. ([TechCrunch](https://example.com))

---

## 🇵🇱 Poland

**Gdańsk Port Expansion Project Enters Final Phase** — The ambitious expansion of the Port of Gdańsk, set to make it one of the largest container terminals in the Baltic, has entered its final construction phase with completion expected by autumn. ([Gazeta Wyborcza](https://example.com))

---

## 🇨🇾 Cyprus

**Cyprus Approves New Renewable Energy Targets for 2030** — The Cypriot parliament has approved an updated national energy plan targeting 35% renewable energy in the electricity mix by 2030, up from the previous goal of 26%. ([Cyprus Mail](https://example.com))

---

## 🔬 Science and Research

**Deep-Sea Expedition Discovers New Species in Pacific Trench** — Marine biologists have catalogued over 30 previously unknown species during a month-long expedition to the Kermadec Trench, including bioluminescent organisms at depths exceeding 8,000 metres. ([Nature News](https://example.com))
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

// ── Shared page styles ──

const PAGE_STYLES = `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #1a1a1a; --paper: #faf9f6; --cream: #f5f3ee; --rule: #d4c9b8;
    --muted: #8a7e6b; --accent: #8b2500; --heading: #3d2b1f;
    --table-header: #D4835E; --table-header-text: #FAF6F0; --table-even: #F0EBE3;
  }
  body { font-family: 'EB Garamond', 'Georgia', 'Times New Roman', serif; line-height: 1.7; color: var(--ink); background: var(--paper); }

  /* ── Ticker ── */
  .ticker { background: var(--ink); color: #d4c9b8; font-size: 12px; letter-spacing: 0.3px; padding: 5px 0; overflow: hidden; }
  .ticker-inner { max-width: 1100px; margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .ticker-label { font-weight: 700; color: #f5f3ee; text-transform: uppercase; font-size: 9px; letter-spacing: 1.5px; white-space: nowrap; }
  .ticker-items { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .ticker-item { white-space: nowrap; }
  .ticker-item .label { color: #8a7e6b; }
  .ticker-item .val { color: #f5f3ee; font-weight: 600; }
  .ticker-item .up { color: #5a9a5a; }
  .ticker-item .down { color: #c05050; }
  .ticker-sep { color: #444; margin: 0 1px; }

  /* ── Header ── */
  .header { max-width: 800px; margin: 0 auto; padding: 24px 24px 0; }
  .header-rule { border: none; border-top: 3px double var(--ink); }
  .header-rule-thin { border: none; border-top: 1px solid var(--ink); margin-top: 6px; }
  .header-main { display: flex; align-items: baseline; justify-content: space-between; padding: 12px 0 6px; flex-wrap: wrap; gap: 8px; }
  .header h1 { font-size: 36px; font-weight: 800; color: var(--ink); line-height: 1; letter-spacing: -0.5px; }
  .header h1 a { color: var(--ink); text-decoration: none; }
  .header-date { font-size: 15px; color: var(--muted); font-style: italic; }
  .header-tagline { font-size: 13px; color: var(--muted); padding: 6px 0 0; letter-spacing: 0.3px; }

  /* ── Layout ── */
  .layout { max-width: 800px; margin: 0 auto; padding: 32px 24px 48px; }

  .sample-note { background: var(--cream); border-left: 3px solid var(--accent); padding: 10px 16px; font-size: 14px; color: var(--muted); font-style: italic; margin-bottom: 24px; }
  .back-link { display: inline-block; font-size: 14px; color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--rule); margin-bottom: 24px; }
  .back-link:hover { border-bottom-color: var(--accent); }

  /* ── Digest content ── */
  .digest-content h1 { display: none; }

  .digest-content h2 {
    font-size: 22px; font-weight: 700; color: var(--accent);
    margin: 48px 0 20px; padding: 10px 0 10px 16px;
    border-left: 4px solid var(--accent); background: var(--cream);
    letter-spacing: -0.2px;
  }
  .digest-content h2:first-child { margin-top: 0; }
  .digest-content h2 a { color: var(--accent); text-decoration: none; border-bottom: none; }
  .digest-content h2 a:hover { text-decoration: underline; }

  .digest-content h3 { font-size: 18px; font-weight: 700; color: var(--heading); margin: 28px 0 12px; }

  .digest-content p {
    font-size: 17px; color: var(--ink); line-height: 1.8; margin: 0 0 18px;
  }

  .digest-content strong { color: var(--ink); }
  .digest-content em { color: var(--muted); }

  /* Story headlines — the bold lead of each story */
  .digest-content p strong:first-child {
    display: block; font-size: 18px; line-height: 1.4;
    margin-top: 28px; padding-top: 20px;
    border-top: 1px solid var(--rule);
  }
  .digest-content h2 + p strong:first-child,
  .digest-content hr + p strong:first-child {
    border-top: none; margin-top: 0; padding-top: 0;
  }

  .digest-content hr { border: none; border-top: 1px solid var(--rule); margin: 40px 0; }

  .digest-content a { color: var(--accent); text-decoration: none; border-bottom: 1px solid transparent; }
  .digest-content a:hover { border-bottom-color: var(--accent); }

  .digest-content ul { padding-left: 24px; margin: 12px 0 18px; }
  .digest-content li { margin: 8px 0; font-size: 17px; line-height: 1.7; }

  .digest-content table { border-collapse: collapse; width: 100%; margin: 20px 0; font-size: 15px; }
  .digest-content th, .digest-content thead tr th { background: var(--table-header); color: var(--table-header-text); padding: 10px 14px; text-align: left; font-weight: 600; }
  .digest-content td { padding: 8px 14px; border-bottom: 1px solid var(--rule); }
  .digest-content tr:nth-child(even) { background: var(--table-even); }
  .digest-content blockquote { border-left: 4px solid var(--accent); margin: 16px 0; padding: 10px 20px; background: var(--cream); color: var(--heading); font-style: italic; }

  /* ── Subscribe banner ── */
  .subscribe-banner {
    background: var(--cream); border-top: 2px solid var(--rule); border-bottom: 2px solid var(--rule);
    padding: 36px 24px;
  }
  .subscribe-inner {
    max-width: 800px; margin: 0 auto;
    display: flex; align-items: center; gap: 32px; flex-wrap: wrap;
  }
  .subscribe-text { flex: 1; min-width: 240px; }
  .subscribe-text h2 { font-size: 24px; font-weight: 800; color: var(--heading); margin-bottom: 6px; }
  .subscribe-text p { font-size: 15px; color: var(--muted); line-height: 1.5; }
  .subscribe-form {
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }
  .subscribe-form input[type="email"] {
    padding: 10px 14px; border: 1px solid var(--rule); font-size: 15px;
    font-family: inherit; color: var(--ink); background: white; width: 240px;
  }
  .subscribe-form input[type="email"]:focus { outline: none; border-color: var(--accent); }
  .subscribe-form button {
    padding: 10px 24px; background: var(--accent); color: white; border: none;
    font-size: 15px; font-weight: 700; font-family: inherit; cursor: pointer;
    letter-spacing: 0.3px; transition: background 0.2s;
  }
  .subscribe-form button:hover { background: #6d1d00; }

  /* ── Footer ── */
  .footer {
    max-width: 800px; margin: 0 auto; padding: 20px 24px;
    display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;
  }
  .footer p { font-size: 13px; color: var(--muted); }

  /* ── Responsive ── */
  @media (max-width: 600px) {
    .header h1 { font-size: 28px; }
    .header-main { flex-direction: column; gap: 4px; }
    .subscribe-inner { flex-direction: column; text-align: center; }
    .subscribe-form { justify-content: center; width: 100%; }
    .subscribe-form input[type="email"] { width: 100%; }
    .digest-content p { font-size: 16px; }
    .digest-content p strong:first-child { font-size: 17px; }
  }
</style>`;

// ── Shared page shell ──

function pageHead(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="AI News Digest — daily world news from 38+ international sources, compiled by AI.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
  ${PAGE_STYLES}
</head>`;
}

function pageHeader(dateStr: string, tickerContent: string): string {
  return `
  <div class="ticker"><div class="ticker-inner"><span class="ticker-label">Live</span><div class="ticker-items">${tickerContent}</div></div></div>
  <header class="header">
    <hr class="header-rule">
    <div class="header-main">
      <h1><a href="/">AI News Digest</a></h1>
      <span class="header-date">${dateStr}</span>
    </div>
    <hr class="header-rule-thin">
    <p class="header-tagline">Daily world news from 38+ sources, compiled by AI</p>
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
        <button type="submit">Subscribe</button>
      </form>
    </div>
  </div>`;
}

function pageFooter(): string {
  return `
  <footer class="footer">
    <p>Compiled daily by Claude on Cloudflare Workers</p>
    <p>&copy; AI News Digest</p>
  </footer>
</body>
</html>`;
}

// ── Header linkification ──

/** Turn <h2> tags into clickable links to /story/{date}/{slug} */
function linkifyHeaders(html: string, date: string): string {
  return html.replace(/<h2>(.*?)<\/h2>/g, (_match, content) => {
    const textOnly = content.replace(/<[^>]*>/g, '').trim();
    const slug = generateSlug(textOnly);
    if (!slug) return `<h2>${content}</h2>`;
    return `<h2><a href="/story/${date}/${slug}">${content}</a></h2>`;
  });
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

  const digestMd = hasDigest ? data.digestMarkdown! : SAMPLE_DIGEST;
  let digestHtml = markdownToHtml(digestMd);
  if (hasDigest) {
    digestHtml = linkifyHeaders(digestHtml, data.date);
  }

  const sampleNote = hasDigest
    ? ''
    : '<div class="sample-note">Preview with sample articles — subscribe to receive the real daily digest every morning.</div>';

  return `${pageHead('AI News Digest — Daily World News from 38+ Sources')}
<body>
  ${pageHeader(dateStr, tickerContent)}
  <div class="layout">
    ${sampleNote}
    <div class="digest-content">${digestHtml}</div>
  </div>
  ${subscribeBanner()}
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

  return `${pageHead('AI News Digest — ' + escapeHtml(slug.replace(/-/g, ' ')))}
<body>
  ${pageHeader(dateStr, tickerContent)}
  <div class="layout">
    <a href="/" class="back-link">&larr; Back to full digest</a>
    <div class="digest-content">${sectionHtml}</div>
  </div>
  ${subscribeBanner()}
  ${pageFooter()}`;
}
