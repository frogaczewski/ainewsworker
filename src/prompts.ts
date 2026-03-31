import type { RssItem, TriagedStory, WeatherData, MarketData } from './types';

export function buildTriagePrompt(items: RssItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] SOURCE: ${item.source}${item.editorial ? ' [EDITORIAL]' : ''}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nLINK: ${item.link}\nDATE: ${item.pubDate}`
  ).join('\n\n');

  return `You are a news editor for a daily digest. Your reader lives in Cyprus with ties to Poland and interests in technology, climate, science, health, and global politics.

Below are headlines and summaries from ~35 news sources published in the last 24 hours. Your job:

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
     "editorial": true if the source is marked [EDITORIAL], false otherwise
   }

3. IMPORTANT: When the same event appears in multiple sources, mark duplicates and note which sources covered it. This is crucial for cross-referencing.

4. CONFLICTING REPORTS: When sources report the same event with different framing, different facts, or contradictory narratives (e.g., Western vs non-Western media, right-wing vs left-wing outlets, global south vs developed world perspectives), set "conflicting": true and provide a brief "conflict_note" explaining the key difference (e.g., "Western sources emphasize sanctions impact, while Xinhua focuses on diplomatic overtures").

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

  return `You are writing a daily news digest for Filip, who lives in Pegeia, Cyprus and has ties to Poland. He follows technology, climate, science, global politics, and business closely.

Write a comprehensive, well-organized daily digest in markdown. Each story should be 3-6 sentences — thorough enough that the reader never needs to click through to the original article. Include key facts, figures, quotes, and context. Always cite sources as clickable markdown links: ([Source Name](url)). When the same story appeared in multiple outlets, mention that for credibility. When stories have conflicting coverage between sources (flagged with "conflicting": true), explicitly describe how different outlets reported it differently — e.g., how right-wing vs left-wing media framed it, or how global south vs developed world perspectives diverge. Do NOT use markdown blockquote syntax (lines starting with >) as it does not render well in email.

## FORMAT

# Daily News Digest — ${dateStr}

*Compiled from ${sourcesNote}. All stories from the last 24 hours. Cross-referenced across outlets.*

---

[ALWAYS include a section for every country in this list: PL, CY, NP, UA, CN, DE, FR, IT, ES, GB, US, EU — using flag emoji + country name as an h3 header. If a country has news, write the stories. If a country has no significant standalone stories today, still include the section with a brief note (e.g. "No major standalone stories today, though French outlets contributed coverage cited in other sections." or "A quiet news day from Nepal."). For Ukraine (UA), always include the latest on the war/conflict — frontline updates, diplomatic developments, humanitarian impact, and international response. Cross-reference Ukrainian sources (Kyiv Independent, Ukrinform, Ukrainska Pravda) with Russian sources (TASS, Meduza, Moscow Times) to highlight differing narratives. Cap the US section to 5-6 of the most important stories — do not include every US story.]

---

[For each category with news: 🤖 Technology and AI, 🌍 Climate and Environment, 🏛️ Global Politics, 🔬 Science and Research, 💼 Business and Economy, 🏥 Health and Medicine — use h3 headers for each category]

---

## 🌏 Global South & Regional Roundup

[ALWAYS include this section. Pick 1 notable story from each of these regions: Africa, Latin America, Central Asia, and South/Southeast Asia. These should be stories told from local perspectives — not just Western coverage of those regions. If a region has no stories, note that briefly. Use sub-headers for each region.]

---

## 📌 Also Notable

[Brief bullet points of other significant stories that don't fit above]

---

## 📰 Editorial Deep Dives

[Select 2-3 of the best editorial/investigative articles from sources marked "editorial": true. These are from non-paywalled, independent, and open-source journalism outlets (Bellingcat, The Conversation, The Intercept, Global Voices, Carbon Brief, The Markup, OCCRP, IPS News, Mongabay, ProPublica). For each, write a thorough 10-12 sentence summary that captures the full argument, key evidence, and conclusions — the reader should feel they've read the article. Include the source link.]

---

## 📈 Markets & Currencies

| Index / Asset | Value | Change |
|---|---|---|
[MARKET_DATA_HERE]

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
*Generated automatically by AI News Digest*

## GUIDELINES
- Each story should be 3-6 sentences — comprehensive enough that the reader never needs to leave the newsletter
- Include key facts, figures, direct quotes, and relevant context for each story
- Always cite sources as clickable markdown links: ([Source Name](url)). Use the article URLs provided in the story data
- When the same story appears in multiple outlets, note that and link multiple sources
- When stories are flagged as "conflicting", describe how different sources reported it differently (e.g., Western vs non-Western framing, political bias differences, global south vs developed world perspectives)
- Focus on what matters to someone in Cyprus with ties to Poland
- Use flag emojis for country headers
- Cap the United States section to 5-6 stories maximum — pick only the most significant
- Stories about the same event should be consolidated, not repeated across sections
- Include soccer/football, space, photography news only when truly significant
- The digest should be informative enough to replace reading the news entirely
- For the "Editorial Deep Dives" section: pick the 2-3 most compelling editorial/investigative pieces (marked editorial: true). Summarize each in 10-12 sentences — capture the full thesis, key evidence, notable quotes, and conclusions. The reader should feel they've read the original.
- Do NOT use markdown blockquote syntax (lines starting with >) — it does not render in email

=== TRIAGED STORIES ===
${storiesJson}

=== WEATHER DATA ===
${weatherJson}

=== MARKET DATA ===
${marketsJson}`;
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
