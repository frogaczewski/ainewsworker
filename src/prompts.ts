import type { RssItem, TriagedStory, WeatherData, MarketData } from './types';

export function buildTriagePrompt(items: RssItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] SOURCE: ${item.source}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nDATE: ${item.pubDate}`
  ).join('\n\n');

  return `You are a news editor for a daily digest. Your reader lives in Cyprus with ties to Poland and interests in technology, climate, science, health, and global politics.

Below are headlines and summaries from ~35 news sources published in the last 24 hours. Your job:

1. Select the 40-60 most important/interesting stories (NO MORE than 60)
2. For each selected story, output a JSON object:
   {
     "headline": "original headline",
     "summary": "original summary text",
     "source": "source name",
     "country_tags": ["PL", "CY", "US", ...],
     "category_tags": ["tech_ai", "climate", "politics", "science", "business", "health"],
     "importance": "high" | "medium",
     "duplicate_of": null or index of earlier story covering same event
   }

3. IMPORTANT: When the same event appears in multiple sources, mark duplicates and note which sources covered it. This is crucial for cross-referencing.

4. Prioritize:
   - Stories directly about Poland, Cyprus, Nepal, China, Germany, France, Italy, Spain, UK, US, EU
   - Major global events (wars, elections, disasters, breakthroughs)
   - Technology/AI developments
   - Climate and environment
   - Science breakthroughs
   - Stories appearing across multiple sources (higher credibility)

5. Deprioritize:
   - Celebrity gossip, entertainment unless truly major
   - Local crime stories with no broader significance
   - Sports unless a major international event

Polish-language items: translate the headline and summary to English in your output.

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

Write a comprehensive, well-organized daily digest in markdown. Be thorough but concise — each story should be 2-4 sentences. Always cite sources in parentheses. When the same story appeared in multiple outlets, mention that for credibility.

## FORMAT

# Daily News Digest — ${dateStr}

*Compiled from ${sourcesNote}. All stories from the last 24 hours. Cross-referenced across outlets.*

---

## 🌍 Countries of Interest

[For each country that has news (PL, CY, NP, CN, DE, FR, IT, ES, GB, US, EU), create a section with flag emoji + country name. Include as many or as few stories per country as the news warrants. Skip countries with no significant news today.]

---

## 📚 Categories

[For each category with news: 🤖 Technology and AI, 🌍 Climate and Environment, 🏛️ Global Politics, 🔬 Science and Research, 💼 Business and Economy, 🏥 Health and Medicine]

---

## 📌 Also Notable

[Brief bullet points of other significant stories that don't fit above]

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

## 💡 Suggested Additional Sources
[2-3 sources that had good coverage today but aren't in the regular feed list]

---
*Generated automatically by AI News Digest*

## GUIDELINES
- Be thorough but concise (2-4 sentences per story)
- Always cite sources in parentheses
- When the same story appears in multiple outlets, note that
- Focus on what matters to someone in Cyprus with ties to Poland
- Use flag emojis for country headers
- Stories about the same event should be consolidated, not repeated across sections
- Include soccer/football, space, photography news only when truly significant
- The digest should be informative enough to replace reading the news

=== TRIAGED STORIES ===
${storiesJson}

=== WEATHER DATA ===
${weatherJson}

=== MARKET DATA ===
${marketsJson}`;
}
