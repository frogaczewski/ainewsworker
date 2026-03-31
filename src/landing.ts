// Landing page HTML template for AI News Digest

const SAMPLE_ARTICLES = [
  {
    category: 'Global Politics',
    emoji: '🏛',
    stories: [
      {
        headline: 'EU Leaders Reach Historic Agreement on Digital Infrastructure Investment',
        summary: 'European Union member states have agreed on a landmark €45 billion package aimed at modernising digital infrastructure across the bloc, with a focus on AI research hubs and cross-border connectivity.',
        source: 'Politico EU',
        time: '3h ago',
      },
      {
        headline: 'Southeast Asian Nations Form Joint Climate Resilience Task Force',
        summary: 'ASEAN countries announced a new cooperative framework to address rising sea levels and extreme weather events affecting the region\'s coastal communities.',
        source: 'Straits Times',
        time: '5h ago',
      },
      {
        headline: 'G7 Finance Ministers Agree on New Framework for Digital Currency Regulation',
        summary: 'The group of seven industrialised nations has outlined principles for governing central bank digital currencies, seeking common ground on cross-border payments and consumer protection standards.',
        source: 'BBC Business',
        time: '6h ago',
      },
    ],
  },
  {
    category: 'Poland',
    emoji: '🇵🇱',
    stories: [
      {
        headline: 'Gdańsk Port Expansion Project Enters Final Phase',
        summary: 'The ambitious expansion of the Port of Gdańsk, set to make it one of the largest container terminals in the Baltic, has entered its final construction phase with completion expected by autumn.',
        source: 'Gazeta Wyborcza',
        time: '4h ago',
      },
      {
        headline: 'Warsaw Metro Line 3 Receives EU Cohesion Fund Approval',
        summary: 'The European Commission has approved €1.2 billion in cohesion funding for the third metro line, which will connect the Praga district to the western suburbs by 2031.',
        source: 'Rzeczpospolita',
        time: '7h ago',
      },
    ],
  },
  {
    category: 'Cyprus',
    emoji: '🇨🇾',
    stories: [
      {
        headline: 'Cyprus Approves New Renewable Energy Targets for 2030',
        summary: 'The Cypriot parliament has approved an updated national energy plan targeting 35% renewable energy in the electricity mix by 2030, up from the previous goal of 26%.',
        source: 'Cyprus Mail',
        time: '6h ago',
      },
    ],
  },
  {
    category: 'Tech & AI',
    emoji: '🤖',
    stories: [
      {
        headline: 'Open-Source Language Model Achieves Breakthrough in Multilingual Understanding',
        summary: 'A consortium of European research labs has released a new open-source language model that sets new benchmarks in understanding and generating text across 47 languages.',
        source: 'TechCrunch',
        time: '2h ago',
      },
      {
        headline: 'Wearable Health Sensors Now Capable of Real-Time Blood Sugar Monitoring',
        summary: 'A new generation of non-invasive wearable sensors promises continuous glucose monitoring without finger pricks, potentially transforming diabetes management worldwide.',
        source: 'Wired',
        time: '7h ago',
      },
    ],
  },
  {
    category: 'Science',
    emoji: '🔬',
    stories: [
      {
        headline: 'Deep-Sea Expedition Discovers New Species in Pacific Trench',
        summary: 'Marine biologists have catalogued over 30 previously unknown species during a month-long expedition to the Kermadec Trench, including bioluminescent organisms at depths exceeding 8,000 metres.',
        source: 'Nature News',
        time: '8h ago',
      },
      {
        headline: 'CERN Reports Anomalous Results in Latest Particle Collision Data',
        summary: 'Physicists at the Large Hadron Collider have identified unexpected deviations from the Standard Model in muon decay measurements, prompting calls for independent verification.',
        source: 'Science Daily',
        time: '5h ago',
      },
    ],
  },
  {
    category: 'Business & Markets',
    emoji: '💼',
    stories: [
      {
        headline: 'Global Semiconductor Supply Chains Shift Toward Regional Hubs',
        summary: 'Major chipmakers are accelerating plans to build fabrication plants in Europe and Southeast Asia, reducing dependency on concentrated production centres amid growing geopolitical tensions.',
        source: 'Nikkei Asia',
        time: '4h ago',
      },
    ],
  },
];

function renderNewsColumns(): string {
  const mid = Math.ceil(SAMPLE_ARTICLES.length / 2);
  const left = SAMPLE_ARTICLES.slice(0, mid);
  const right = SAMPLE_ARTICLES.slice(mid);

  const renderCol = (sections: typeof SAMPLE_ARTICLES) =>
    sections.map(section => `
      <div class="section">
        <h3 class="section-title"><span class="section-emoji">${section.emoji}</span> ${section.category}</h3>
        ${section.stories.map(story => `
        <article class="story">
          <h4>${story.headline}</h4>
          <p>${story.summary}</p>
          <span class="meta">${story.source} · ${story.time}</span>
        </article>
        `).join('')}
      </div>
    `).join('');

  return `
    <div class="col">${renderCol(left)}</div>
    <div class="col">${renderCol(right)}</div>
  `;
}

const SOURCES = [
  'BBC', 'The Guardian', 'Al Jazeera', 'France 24', 'DW', 'NPR',
  'Politico EU', 'Der Spiegel', 'El País', 'Nikkei Asia', 'SCMP',
  'Straits Times', 'Times of India', 'TechCrunch', 'The Verge', 'Wired',
  'Nature', 'Science Daily', 'Xinhua', 'TASS', 'Meduza', 'Moscow Times',
  'Cyprus Mail', 'Gazeta Wyborcza', 'Rzeczpospolita', 'Notes From Poland',
  'ProPublica', 'Democracy Now', 'Rest of World', 'ABC Australia',
  'Globe and Mail', 'The Hindu', 'Al Arabiya',
];

export function buildLandingPage(): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const sourceTags = SOURCES.map(s => `<span class="src-tag">${s}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI News Digest — Daily World News from 38+ Sources</title>
  <meta name="description" content="Get the best daily news from 38+ international sources, compiled by AI and delivered straight to your inbox.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --ink: #1a1a1a;
      --paper: #faf9f6;
      --cream: #f5f3ee;
      --rule: #d4c9b8;
      --muted: #8a7e6b;
      --accent: #8b2500;
      --heading: #3d2b1f;
      --link: #6b3a2a;
    }

    body {
      font-family: 'EB Garamond', 'Georgia', 'Times New Roman', serif;
      line-height: 1.65;
      color: var(--ink);
      background: var(--paper);
    }

    /* ── Ticker belt ── */
    .ticker {
      background: var(--ink);
      color: #d4c9b8;
      font-size: 13px;
      letter-spacing: 0.3px;
      padding: 6px 0;
      overflow: hidden;
    }

    .ticker-inner {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
    }

    .ticker-label {
      font-weight: 700;
      color: #f5f3ee;
      text-transform: uppercase;
      font-size: 10px;
      letter-spacing: 1.5px;
      white-space: nowrap;
    }

    .ticker-items {
      display: flex;
      gap: 18px;
      flex-wrap: wrap;
      align-items: center;
    }

    .ticker-item {
      white-space: nowrap;
    }

    .ticker-item .label {
      color: #8a7e6b;
    }

    .ticker-item .val {
      color: #f5f3ee;
      font-weight: 600;
    }

    .ticker-item .up { color: #5a9a5a; }
    .ticker-item .down { color: #c05050; }

    .ticker-sep {
      color: #555;
    }

    /* ── Header ── */
    .header {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px 24px 0;
    }

    .header-rule { border: none; border-top: 3px solid var(--ink); }
    .header-rule-thin { border: none; border-top: 1px solid var(--ink); margin-top: 6px; }

    .header-main {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 10px 0 4px;
      flex-wrap: wrap;
      gap: 8px;
    }

    .header h1 {
      font-size: 40px;
      font-weight: 800;
      color: var(--accent);
      line-height: 1;
      letter-spacing: -0.5px;
    }

    .header-date {
      font-size: 15px;
      color: var(--muted);
      font-style: italic;
    }

    /* ── Sources strip ── */
    .sources-strip {
      max-width: 1200px;
      margin: 0 auto;
      padding: 10px 24px;
      border-bottom: 1px solid var(--rule);
    }

    .sources-strip-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1.5px;
      color: var(--muted);
      margin-bottom: 6px;
      font-weight: 600;
    }

    .sources-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 8px;
    }

    .src-tag {
      font-size: 11px;
      color: var(--muted);
      white-space: nowrap;
    }

    .src-tag::after {
      content: ' ·';
      color: var(--rule);
    }

    .src-tag:last-child::after {
      content: '';
    }

    /* ── Main layout ── */
    .layout {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px 24px 60px;
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: 32px;
      align-items: start;
    }

    /* ── News area (left) ── */
    .news-area {
      min-width: 0;
    }

    .news-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 2px;
      color: var(--accent);
      font-weight: 700;
      border-bottom: 2px solid var(--accent);
      padding-bottom: 6px;
      margin-bottom: 20px;
    }

    .sample-note {
      background: var(--cream);
      border-left: 3px solid var(--accent);
      padding: 10px 16px;
      font-size: 14px;
      color: var(--muted);
      font-style: italic;
      margin-bottom: 20px;
    }

    .news-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
    }

    .col {}

    .section {
      margin-bottom: 24px;
    }

    .section-title {
      font-size: 17px;
      font-weight: 700;
      color: var(--heading);
      border-bottom: 1px solid var(--rule);
      padding-bottom: 4px;
      margin-bottom: 12px;
    }

    .section-emoji {
      font-style: normal;
    }

    .story {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--cream);
    }

    .story:last-child {
      border-bottom: none;
      margin-bottom: 0;
      padding-bottom: 0;
    }

    .story h4 {
      font-size: 16px;
      font-weight: 700;
      color: var(--ink);
      line-height: 1.3;
      margin-bottom: 4px;
    }

    .story p {
      font-size: 15px;
      color: #4a4a4a;
      margin-bottom: 4px;
    }

    .story .meta {
      font-size: 12px;
      color: var(--muted);
      font-style: italic;
    }

    /* ── Sidebar (right) ── */
    .sidebar {
      position: sticky;
      top: 24px;
    }

    .subscribe-box {
      background: var(--cream);
      border: 1px solid var(--rule);
      padding: 28px 24px;
    }

    .subscribe-box h2 {
      font-size: 22px;
      font-weight: 800;
      color: var(--heading);
      line-height: 1.25;
      margin-bottom: 12px;
    }

    .subscribe-box p {
      font-size: 15px;
      color: #4a4a4a;
      margin-bottom: 16px;
    }

    .subscribe-box ul {
      list-style: none;
      padding: 0;
      margin: 0 0 20px;
    }

    .subscribe-box ul li {
      font-size: 14px;
      color: var(--ink);
      padding: 5px 0;
      border-bottom: 1px solid var(--rule);
    }

    .subscribe-box ul li:last-child {
      border-bottom: none;
    }

    .subscribe-box ul li strong {
      color: var(--accent);
    }

    .signup-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .signup-form input[type="email"] {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--rule);
      font-size: 15px;
      font-family: inherit;
      color: var(--ink);
      background: white;
    }

    .signup-form input[type="email"]:focus {
      outline: none;
      border-color: var(--accent);
    }

    .signup-form button {
      padding: 10px 20px;
      background: var(--accent);
      color: white;
      border: none;
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      letter-spacing: 0.5px;
      transition: background 0.2s;
    }

    .signup-form button:hover {
      background: #6d1d00;
    }

    .signup-note {
      font-size: 12px;
      color: var(--muted);
      font-style: italic;
      margin-top: 6px;
    }

    .sidebar-extra {
      margin-top: 24px;
      padding: 20px 24px;
      border: 1px solid var(--rule);
      background: white;
    }

    .sidebar-extra h3 {
      font-size: 14px;
      font-weight: 700;
      color: var(--heading);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }

    .sidebar-extra p {
      font-size: 14px;
      color: #4a4a4a;
      line-height: 1.5;
    }

    /* ── Footer ── */
    .footer {
      max-width: 1200px;
      margin: 0 auto;
      padding: 20px 24px;
      border-top: 2px solid var(--ink);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .footer p {
      font-size: 13px;
      color: var(--muted);
    }

    /* ── Responsive ── */
    @media (max-width: 860px) {
      .layout {
        grid-template-columns: 1fr;
      }

      .sidebar {
        position: static;
        order: -1;
      }

      .news-columns {
        grid-template-columns: 1fr;
      }

      .header h1 {
        font-size: 30px;
      }

      .ticker-inner {
        font-size: 12px;
      }
    }
  </style>
</head>
<body>

  <!-- Ticker belt: weather + markets + sources count -->
  <div class="ticker">
    <div class="ticker-inner">
      <span class="ticker-label">Live Data</span>
      <div class="ticker-items">
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
        <span class="ticker-sep">|</span>
        <span class="ticker-item"><span class="label">Sources today</span> <span class="val">57 / 65</span></span>
      </div>
    </div>
  </div>

  <!-- Header -->
  <header class="header">
    <hr class="header-rule">
    <div class="header-main">
      <h1>AI News Digest</h1>
      <span class="header-date">${dateStr}</span>
    </div>
    <hr class="header-rule-thin">
  </header>

  <!-- Sources strip -->
  <div class="sources-strip">
    <div class="sources-strip-label">Compiled from 38+ sources</div>
    <div class="sources-wrap">${sourceTags}</div>
  </div>

  <!-- Main layout: news + sidebar -->
  <div class="layout">

    <!-- News (left, wide) -->
    <div class="news-area">
      <div class="news-label">Today's Digest</div>
      <div class="sample-note">
        Preview with sample articles — subscribe to receive the real daily digest every morning.
      </div>
      <div class="news-columns">
        ${renderNewsColumns()}
      </div>
    </div>

    <!-- Sidebar (right) -->
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
        <p>Every day at 4 AM UTC, we fetch hundreds of articles from RSS feeds worldwide. AI triages them for relevance, removes duplicates, and compiles a single digest covering politics, tech, science, markets, and weather — delivered by 6 AM.</p>
      </div>
    </aside>

  </div>

  <footer class="footer">
    <p>AI News Digest — compiled daily from 38+ international sources by Claude</p>
    <p>Built on Cloudflare Workers</p>
  </footer>

</body>
</html>`;
}
