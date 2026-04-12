import type { RssItem, TriagedStory, WeatherData, MarketData } from './types';

export function buildTriagePrompt(items: RssItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] SOURCE: ${item.source}${item.editorial ? ' [EDITORIAL]' : ''}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nLINK: ${item.link}\nDATE: ${item.pubDate}`
  ).join('\n\n');

  return `You are a news editor for a daily digest. Your reader lives in Cyprus with ties to Poland and interests in technology, climate, science, health, and global politics.

Below are headlines and summaries from ~80 news sources published in the last 24 hours. Your job:

1. Select the 50-80 most important/interesting stories
2. For each selected story, output a JSON object:
   {
     "headline": "original headline",
     "summary": "original summary text",
     "source": "source name",
     "link": "original article URL",
     "country_tags": ["PL", "CY", "US", ...],
     "category_tags": ["tech_ai", "climate", "politics", "science", "business", "health"],
     "importance": "high" | "medium",
     "duplicate_of": null or index of earlier story covering same event,
     "conflicting": false,
     "conflict_note": null,
     "editorial": true if the source is marked [EDITORIAL], false otherwise,
     "all_sources": [{"name": "Source Name", "link": "url", "angle": "brief perspective note or null"}]
   }

3. MULTI-SOURCE TRACKING (CRITICAL): When the same event appears in multiple sources:
   - Keep the FIRST occurrence as the primary entry with full details
   - On the PRIMARY entry, populate "all_sources" with EVERY source that covered this event — include the source name, link, and a brief note on their angle/perspective (e.g., "focuses on civilian casualties", "emphasizes economic impact", "reports government position"). Set angle to null if the coverage is essentially identical.
   - On DUPLICATE entries, set "duplicate_of" to the index of the primary entry
   - This is essential — the compilation step needs to know which sources reported each story so it can cite them by name and describe their differing perspectives.

4. CONFLICTING REPORTS: When sources report the same event with different framing, different facts, or contradictory narratives (e.g., Western vs non-Western media, right-wing vs left-wing outlets, global south vs developed world perspectives), set "conflicting": true and provide a brief "conflict_note" explaining the key difference (e.g., "Western sources emphasize sanctions impact, while Xinhua focuses on diplomatic overtures"). Also ensure all_sources captures each source's specific angle.

5. Prioritize:
   - MUST INCLUDE: Always select stories about Poland, Cyprus, Nepal, and Ukraine (especially war/conflict updates) — these are the reader's priority countries. Include at least 2-3 Nepal stories if any exist in the feed.
   - Stories directly about China, Germany, France, Italy, Spain, UK, US, EU
   - Major global events (wars, elections, disasters, breakthroughs)
   - Technology/AI developments
   - Climate and environment
   - Science breakthroughs
   - Stories appearing across multiple sources (higher credibility)
   - MUST INCLUDE: At least 1 story each from Africa, Latin America, Central Asia, and South/Southeast Asia — prioritize stories told from local perspectives, not just Western coverage of those regions

6. Deprioritize:
   - Celebrity gossip, entertainment unless truly major
   - Local crime stories with no broader significance
   - Sports unless a major international event

Polish-language and Nepali-language items: translate the headline and summary to English in your output.

Return ONLY a JSON array of selected stories. No commentary.

=== RSS ITEMS ===
${itemsText}`;
}

export function buildCompilationPrompt(
  triagedStories: TriagedStory[],
  weather: WeatherData[],
  markets: MarketData,
  feedStats: { total: number; failed: number },
): string {
  const storiesJson = JSON.stringify(triagedStories, null, 2);
  const weatherJson = JSON.stringify(weather, null, 2);
  const marketsJson = JSON.stringify(markets, null, 2);

  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const sourcesNote = feedStats.failed > 0
    ? `${feedStats.total - feedStats.failed} of ${feedStats.total} sources responded`
    : `${feedStats.total} sources`;

  return `You are writing a daily news digest for Filip, who lives in Pegeia, Cyprus and has ties to Poland. He follows technology, climate, science, global politics, and business closely. This digest will be published on a website.

Write a comprehensive, well-organized daily digest in markdown. Each story should be 3-6 sentences — thorough enough that the reader never needs to click through to the original article. Include key facts, figures, quotes, and context. Always cite sources as clickable markdown links: ([Source Name](url)). Do NOT use markdown blockquote syntax (lines starting with >) as it does not render well in email.

## MULTI-SOURCE ATTRIBUTION (IMPORTANT)
When a story has an "all_sources" array with multiple entries, you MUST name the sources explicitly in the text:
- If sources broadly agree, cite them together: "According to reports from BBC, Reuters, and France 24, ..." or end with "(...reported by [Source1](url), [Source2](url), and [Source3](url))"
- If sources emphasize different aspects (check the "angle" field), describe each perspective by name: "BBC focused on the humanitarian toll ([BBC](url)), while Al Jazeera highlighted the diplomatic fallout ([Al Jazeera](url)) and TASS emphasized Russia's response ([TASS](url))"
- For conflicting coverage (flagged with "conflicting": true), explicitly contrast the narratives: "Western outlets including The Guardian and Reuters reported X, while Chinese state media (China Daily, SCMP) framed the situation as Y"
- Always link to at least 2-3 sources when multiple covered the same story — give the reader access to different perspectives
- The goal is transparency: the reader should always know WHO is reporting WHAT, especially on geopolitically sensitive stories

## SECTION ORDER (follow this exact order)

# Daily News Digest — ${dateStr}

*Compiled from ${sourcesNote}. All stories from the last 24 hours. Cross-referenced across outlets.*

---

## 🏛️ Global Politics

[This is ALWAYS the first content section. Include all major geopolitical stories here: wars, conflicts (including the Ukraine-Russia war and any Middle East conflicts), diplomacy, international relations, NATO, UN, EU politics. Use bold **sub-headers** within this section to organise by topic (e.g. **Iran War**, **Ukraine-Russia**, **NATO**, **EU**). Do NOT create separate country-level sections for conflict coverage — conflicts belong here in Global Politics.]

---

[Country sections — use flag emoji + country name as h2 headers. These are for DOMESTIC stories about these countries, not conflict coverage which goes in Global Politics above.]

ALWAYS include: 🇵🇱 Poland, 🇨🇾 Cyprus, 🇳🇵 Nepal — these are the reader's home countries, always present even on quiet days.

🇪🇺 Europe: If there are no standalone stories big enough for dedicated France/UK/Germany/etc. sections, group 2-3 interesting European domestic stories into a single "🇪🇺 Europe" section. These should NOT repeat stories already covered in Global Politics.

🇨🇳🇷🇺🇮🇳 BRICS & Major Powers: If there are no standalone stories big enough for dedicated China/Russia/India sections, group 2-3 notable stories from BRICS countries (China, Russia, India, Brazil, South Africa) into a single section. Exclude stories already covered in Global Politics (e.g. Ukraine-Russia war coverage belongs in Global Politics, not here).

🇺🇸 United States: Max 2-3 stories with clear INTERNATIONAL impact. Domestic-only stories → "Also Notable" bullets. This digest is for non-US readers.

For other individual countries: ONLY create a dedicated section if they have a truly significant standalone domestic story. Do NOT create empty filler sections.

---

[Category sections — use h2 headers with emoji. Only include categories that have stories:]
- 🤖 Technology and AI
- 🌍 Climate and Environment
- 🔬 Science and Research
- 💼 Business and Economy
- 🏥 Health and Medicine

---

## 🌏 Global South & Regional Roundup

Pick 3-4 notable stories from the Global South. Use sub-headers for each region. Only include regions with actual stories. Use correct geography: Haiti = Caribbean/Latin America (NOT Africa), Pakistan = South Asia, India = South Asia, China/Japan = East Asia (NOT Global South). These should be stories told from local perspectives.

---

## 📌 Also Notable

[Brief bullet points of other significant stories, including US domestic stories]

---

## 📰 Editorial Picks

[Select 2-3 of the best editorial/investigative articles from sources marked "editorial": true (Bellingcat, The Conversation, The Intercept, Global Voices, Carbon Brief, The Markup, ICIJ, OCCRP, IPS News, Mongabay, ProPublica). IMPORTANT: Pick editorials on DIFFERENT topics — do not select multiple pieces about the same subject or from the same source. Aim for topical diversity (e.g. one environment, one tech/policy, one geopolitics). For each: write 2-3 sentences summarising the core argument and why it matters, then cite the source with link. The reader should understand what the piece argues without clicking through.]

---

## 📈 Markets & Currencies

| Index / Asset | Value | Change |
|---|---|---|
[MARKET_DATA_HERE]

[Add 1-2 sentences of market commentary below the table]

---

## 🌤️ Weather Forecast

### Pegeia, Cyprus (next 3 days)
| Day | Conditions | High / Low |
|---|---|---|
[WEATHER_DATA_HERE]

### Gdańsk, Poland (next 3 days)
| Day | Conditions | High / Low |
|---|---|---|
[WEATHER_DATA_HERE]

---
*Generated automatically by AI News Digest. [Read the full digest online.](https://ainewsworker.rogaczewski-dev.workers.dev/)*

## GUIDELINES
- Target approximately 2,500-3,000 words for the entire digest
- Each story: 3-6 sentences, comprehensive enough that the reader never needs to click through
- CRITICAL FORMATTING: Each story MUST start with a **bold headline** on its own line, followed by a blank line, then the story text. Stories MUST be separated by a blank line. Example:

**Story Headline Here**

The story text goes here, 3-6 sentences with source citations. ([Source](url))

**Next Story Headline**

Next story text here. ([Source](url))

- Always cite sources as clickable markdown links: ([Source Name](url))
- When a story has multiple sources in "all_sources", name each source and link to at least 2-3. Describe differing angles when present.
- When stories are flagged as "conflicting", explicitly contrast how each named source framed the story differently
- Focus on what matters to someone in Cyprus with ties to Poland
- Stories about the same event should be consolidated, not repeated across sections
- Do NOT include sports/football results unless they directly involve Poland, Cyprus, or Nepal
- Do NOT use markdown blockquote syntax (lines starting with >)

=== TRIAGED STORIES ===
${storiesJson}

=== WEATHER DATA ===
${weatherJson}

=== MARKET DATA ===
${marketsJson}`;
}

export function buildEmailBriefingPrompt(fullDigest: string, websiteUrl: string): string {
  return `You are condensing a full news digest into a concise email briefing. The full digest is published on a website — the email should give readers the key headlines and encourage them to read the full version online.

## RULES
- For each story in the digest: write a 1-2 sentence summary capturing the single most important fact
- After each section, add a link: [Read full coverage →](${websiteUrl})
- Keep the title, date line, and compiled-from note exactly as they are
- Keep the weather tables and markets table exactly as they are (copy verbatim)
- REMOVE the "Also Notable" section — replace with: "**[See all stories on the website →](${websiteUrl})**"
- For "Editorial Picks": keep the 2-3 sentence summaries from the full digest (do NOT shorten these further). Add a link after each: [Read more →](${websiteUrl})
- Each story MUST be its own paragraph, separated by a blank line
- Add at the very top (before the title): *[Read the full digest online →](${websiteUrl})*
- Target: 1,000-1,500 words maximum
- Do NOT use markdown blockquote syntax (lines starting with >)
- Preserve all markdown formatting: headers, bold, links, tables, horizontal rules

## FULL DIGEST TO CONDENSE
${fullDigest}`;
}

export function buildTranslationPrompt(digest: string): string {
  return `Przetłumacz poniższy biuletyn informacyjny z angielskiego na polski. Wymagania:

1. Zachowaj poprawną polską gramatykę, ortografię i interpunkcję — pisz jak doświadczony polski dziennikarz
2. Używaj właściwych przypadków gramatycznych, odmian czasowników i szyku zdań naturalnego dla języka polskiego
3. Zachowaj cały format markdown bez zmian: nagłówki (#, ##, ###), tabele, listy, linki, pogrubienia, kursywę, linie poziome (---)
4. NIE tłumacz nazw źródeł w linkach — zachowaj oryginalne nazwy mediów (np. "The Guardian", "France 24")
5. NIE tłumacz nazw indeksów giełdowych, walut ani symboli w tabelach
6. Przetłumacz nazwy krajów, kategorii i sekcji na polski
7. Emoji zachowaj bez zmian
8. Nazwy własne (osoby, organizacje, miejsca) zachowaj w oryginalnej pisowni, chyba że istnieje powszechnie używana polska forma (np. "Stany Zjednoczone", "Wielka Brytania", "Cypr")
9. Zmień "Daily News Digest" na "Codzienny Przegląd Wiadomości" w nagłówku
10. Zmień stopkę na: *Wygenerowano automatycznie przez AI News Digest*

Zwróć TYLKO przetłumaczony markdown, bez komentarzy.

=== ENGLISH DIGEST ===
${digest}`;
}
