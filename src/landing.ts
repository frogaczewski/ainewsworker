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

// ── Source list ──

const SOURCES = [
  'BBC', 'The Guardian', 'Al Jazeera', 'France 24', 'DW', 'NPR',
  'Politico EU', 'Der Spiegel', 'El País', 'Nikkei Asia', 'SCMP',
  'Straits Times', 'Times of India', 'TechCrunch', 'The Verge', 'Wired',
  'Nature', 'Science Daily', 'Xinhua', 'TASS', 'Meduza', 'Moscow Times',
  'Cyprus Mail', 'Gazeta Wyborcza', 'Rzeczpospolita', 'Notes From Poland',
  'ProPublica', 'Democracy Now', 'Rest of World', 'ABC Australia',
  'Globe and Mail', 'The Hindu', 'Al Arabiya',
];

// ── Shared page styles ──

const PAGE_STYLES = `<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink: #1a1a1a; --paper: #faf9f6; --cream: #f5f3ee; --rule: #d4c9b8;
    --muted: #8a7e6b; --accent: #8b2500; --heading: #3d2b1f;
    --table-header: #D4835E; --table-header-text: #FAF6F0; --table-even: #F0EBE3;
  }
  body { font-family: 'EB Garamond', 'Georgia', 'Times New Roman', serif; line-height: 1.65; color: var(--ink); background: var(--paper); }

  .ticker { background: var(--ink); color: #d4c9b8; font-size: 13px; letter-spacing: 0.3px; padding: 6px 0; overflow: hidden; }
  .ticker-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .ticker-label { font-weight: 700; color: #f5f3ee; text-transform: uppercase; font-size: 10px; letter-spacing: 1.5px; white-space: nowrap; }
  .ticker-items { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; }
  .ticker-item { white-space: nowrap; } .ticker-item .label { color: #8a7e6b; } .ticker-item .val { color: #f5f3ee; font-weight: 600; }
  .ticker-item .up { color: #5a9a5a; } .ticker-item .down { color: #c05050; } .ticker-sep { color: #555; }

  .header { max-width: 1200px; margin: 0 auto; padding: 20px 24px 0; }
  .header-rule { border: none; border-top: 3px solid var(--ink); }
  .header-rule-thin { border: none; border-top: 1px solid var(--ink); margin-top: 6px; }
  .header-main { display: flex; align-items: baseline; justify-content: space-between; padding: 10px 0 4px; flex-wrap: wrap; gap: 8px; }
  .header h1 { font-size: 40px; font-weight: 800; color: var(--accent); line-height: 1; letter-spacing: -0.5px; }
  .header h1 a { color: var(--accent); text-decoration: none; }
  .header-date { font-size: 15px; color: var(--muted); font-style: italic; }

  .sources-strip { max-width: 1200px; margin: 0 auto; padding: 10px 24px; border-bottom: 1px solid var(--rule); }
  .sources-strip-label { font-size: 10px; text-transform: uppercase; letter-spacing: 1.5px; color: var(--muted); margin-bottom: 6px; font-weight: 600; }
  .sources-wrap { display: flex; flex-wrap: wrap; gap: 3px 8px; }
  .src-tag { font-size: 11px; color: var(--muted); white-space: nowrap; }
  .src-tag::after { content: ' ·'; color: var(--rule); } .src-tag:last-child::after { content: ''; }

  .layout { max-width: 1200px; margin: 0 auto; padding: 24px 24px 60px; display: grid; grid-template-columns: 1fr 300px; gap: 32px; align-items: start; }
  .digest-area { min-width: 0; }
  .digest-label { font-size: 11px; text-transform: uppercase; letter-spacing: 2px; color: var(--accent); font-weight: 700; border-bottom: 2px solid var(--accent); padding-bottom: 6px; margin-bottom: 20px; }
  .digest-label a { color: var(--accent); text-decoration: none; }
  .sample-note { background: var(--cream); border-left: 3px solid var(--accent); padding: 10px 16px; font-size: 14px; color: var(--muted); font-style: italic; margin-bottom: 20px; }

  .digest-content h1 { font-size: 26px; font-weight: 700; color: var(--ink); border-bottom: 3px solid var(--accent); padding-bottom: 12px; margin: 0 0 16px; }
  .digest-content h2 { font-size: 21px; font-weight: 700; color: var(--accent); margin: 28px 0 14px; padding-bottom: 6px; border-bottom: 1px solid var(--rule); }
  .digest-content h3 { font-size: 18px; font-weight: 700; color: var(--heading); margin: 20px 0 10px; }
  .digest-content p { font-size: 16px; color: var(--ink); margin: 8px 0; }
  .digest-content strong { color: var(--ink); } .digest-content em { color: var(--muted); }
  .digest-content hr { border: none; border-top: 1px solid var(--rule); margin: 24px 0; }
  .digest-content a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--rule); }
  .digest-content a:hover { border-bottom-color: var(--accent); }
  .digest-content ul { padding-left: 20px; margin: 8px 0; } .digest-content li { margin: 6px 0; font-size: 16px; }
  .digest-content table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 15px; }
  .digest-content th, .digest-content thead tr th { background: var(--table-header); color: var(--table-header-text); padding: 10px 14px; text-align: left; font-weight: 600; }
  .digest-content td { padding: 8px 14px; border-bottom: 1px solid var(--rule); }
  .digest-content tr:nth-child(even) { background: var(--table-even); }
  .digest-content blockquote { border-left: 4px solid var(--accent); margin: 12px 0; padding: 8px 16px; background: var(--cream); color: var(--heading); }

  .sidebar { position: sticky; top: 24px; }
  .subscribe-box { background: var(--cream); border: 1px solid var(--rule); padding: 28px 24px; }
  .subscribe-box h2 { font-size: 22px; font-weight: 800; color: var(--heading); line-height: 1.25; margin-bottom: 12px; }
  .subscribe-box p { font-size: 15px; color: #4a4a4a; margin-bottom: 16px; }
  .subscribe-box ul { list-style: none; padding: 0; margin: 0 0 20px; }
  .subscribe-box ul li { font-size: 14px; color: var(--ink); padding: 5px 0; border-bottom: 1px solid var(--rule); }
  .subscribe-box ul li:last-child { border-bottom: none; } .subscribe-box ul li strong { color: var(--accent); }
  .signup-form { display: flex; flex-direction: column; gap: 8px; }
  .signup-form input[type="email"] { width: 100%; padding: 10px 12px; border: 1px solid var(--rule); font-size: 15px; font-family: inherit; color: var(--ink); background: white; }
  .signup-form input[type="email"]:focus { outline: none; border-color: var(--accent); }
  .signup-form button { padding: 10px 20px; background: var(--accent); color: white; border: none; font-size: 15px; font-weight: 700; font-family: inherit; cursor: pointer; letter-spacing: 0.5px; transition: background 0.2s; }
  .signup-form button:hover { background: #6d1d00; }
  .signup-note { font-size: 12px; color: var(--muted); font-style: italic; margin-top: 6px; }
  .sidebar-extra { margin-top: 24px; padding: 20px 24px; border: 1px solid var(--rule); background: white; }
  .sidebar-extra h3 { font-size: 14px; font-weight: 700; color: var(--heading); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; }
  .sidebar-extra p { font-size: 14px; color: #4a4a4a; line-height: 1.5; }

  .footer { max-width: 1200px; margin: 0 auto; padding: 20px 24px; border-top: 2px solid var(--ink); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
  .footer p { font-size: 13px; color: var(--muted); }

  @media (max-width: 860px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; order: -1; }
    .header h1 { font-size: 30px; }
    .ticker-inner { font-size: 12px; }
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
  <meta name="description" content="AI News Digest — daily world news from 38+ international sources.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
  ${PAGE_STYLES}
</head>`;
}

function pageHeader(dateStr: string, sourceTags: string, tickerContent: string): string {
  return `
  <div class="ticker"><div class="ticker-inner"><span class="ticker-label">Live Data</span><div class="ticker-items">${tickerContent}</div></div></div>
  <header class="header">
    <hr class="header-rule">
    <div class="header-main">
      <h1><a href="/">AI News Digest</a></h1>
      <span class="header-date">${dateStr}</span>
    </div>
    <hr class="header-rule-thin">
  </header>
  <div class="sources-strip">
    <div class="sources-strip-label">Compiled from 38+ sources</div>
    <div class="sources-wrap">${sourceTags}</div>
  </div>`;
}

function pageSidebar(): string {
  return `
    <aside class="sidebar">
      <div class="subscribe-box">
        <h2>Get the digest in&nbsp;your inbox</h2>
        <p>The world's news from 38+ sources, distilled by AI into one concise briefing.</p>
        <ul>
          <li><strong>38+</strong> international sources daily</li>
          <li><strong>AI-compiled</strong> — no noise, just signal</li>
          <li><strong>Your regions</strong> — Poland, Cyprus &amp; more</li>
          <li><strong>6 AM</strong> — every morning, on time</li>
        </ul>
        <form class="signup-form" onsubmit="return false;">
          <input type="email" placeholder="your@email.com" aria-label="Email address" required>
          <button type="submit">Subscribe — it's free</button>
        </form>
        <p class="signup-note">One email per day. Unsubscribe anytime.</p>
      </div>
      <div class="sidebar-extra">
        <h3>How it works</h3>
        <p>Every day at 3 AM UTC, we fetch hundreds of articles from RSS feeds worldwide. AI triages them for relevance, removes duplicates, and compiles a single digest covering politics, tech, science, markets, and weather — delivered by 6 AM.</p>
      </div>
    </aside>`;
}

function pageFooter(): string {
  return `
  <footer class="footer">
    <p>AI News Digest — compiled daily from 38+ international sources by Claude</p>
    <p>Built on Cloudflare Workers</p>
  </footer>
</body>
</html>`;
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
  const digestHtml = markdownToHtml(digestMd);

  const sampleNote = hasDigest
    ? ''
    : '<div class="sample-note">Preview with sample articles — subscribe to receive the real daily digest every morning.</div>';

  const sourceTags = SOURCES.map(s => `<span class="src-tag">${s}</span>`).join('');

  return `${pageHead('AI News Digest — Daily World News from 38+ Sources')}
<body>
  ${pageHeader(dateStr, sourceTags, tickerContent)}
  <div class="layout">
    <div class="digest-area">
      <div class="digest-label">Today's Digest</div>
      ${sampleNote}
      <div class="digest-content">${digestHtml}</div>
    </div>
    ${pageSidebar()}
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
  const sourceTags = SOURCES.map(s => `<span class="src-tag">${s}</span>`).join('');

  return `${pageHead('AI News Digest — ' + escapeHtml(slug.replace(/-/g, ' ')))}
<body>
  ${pageHeader(dateStr, sourceTags, tickerContent)}
  <div class="layout">
    <div class="digest-area">
      <div class="digest-label"><a href="/">← Back to full digest</a></div>
      <div class="digest-content">${sectionHtml}</div>
    </div>
    ${pageSidebar()}
  </div>
  ${pageFooter()}`;
}
