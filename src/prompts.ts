import type { RssItem, TriagedStory, WeatherData, MarketData } from './types';

export function buildTriagePrompt(items: RssItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] SOURCE: ${item.source}${item.editorial ? ' [EDITORIAL]' : ''}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nLINK: ${item.link}\nDATE: ${item.pubDate}`
  ).join('\n\n');

  return `You are a news editor for a daily digest. Your reader lives in Cyprus with ties to Poland and interests in technology, climate, science, health, and global politics.

Below are headlines and summaries from ~80 news sources published in the last 24 hours. Your job:

1. Select the 60-90 most important/interesting stories
2. For each selected story, output a JSON object:
   {
     "headline": "original headline",
     "summary": "original summary text",
     "source": "source name",
     "link": "original article URL",
     "country_tags": ["PL", "CY", "US", ...],
     "category_tags": ["tech_ai", "climate", "politics", "science", "business", "health", "sports", "culture", "economics"],
     "importance": "high" | "medium",
     "duplicate_of": null or index of earlier story covering same event,
     "conflicting": false,
     "conflict_note": null,
     "editorial": true if the source is marked [EDITORIAL], false otherwise,
     "all_sources": [{"name": "Source Name", "link": "url", "angle": "brief perspective note or null"}]
   }

3. MULTI-SOURCE TRACKING (CRITICAL): "all_sources" is REQUIRED on every story you keep — never empty, never null.
   - For SINGLE-source stories: put one entry in all_sources — the source you're reading, with its link and angle set to null. This is the fallback so the compilation step always has something to cite by name.
   - For MULTI-source stories (same event in multiple feeds): keep the FIRST occurrence as the primary entry with full details, and on that primary entry populate "all_sources" with EVERY source that covered the event — name, link, and a brief angle note (e.g., "focuses on civilian casualties", "emphasizes economic impact", "reports government position"). Set angle to null if coverage is essentially identical.
   - On DUPLICATE entries, set "duplicate_of" to the index of the primary entry.
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
   - MUST INCLUDE: At least 1 story each from Africa, Latin America, Central Asia, and South/Southeast Asia — prioritize stories told from local perspectives, not just Western coverage of those regions. Within Africa, give priority to the Sudan conflict — it is one of the world's worst ongoing humanitarian crises and is severely underreported; always include a Sudan update if one exists in the feed.

6. Deprioritize / EXCLUDE:
   - Celebrity gossip, entertainment unless truly major
   - Local crime, fraud, or trafficking stories UNLESS they reveal a broader pattern, policy failure, cross-border dimension, or involve a public figure / significant sum with systemic implications. A single couple convicted of tax fraud, a local theft, a one-off arrest — these do NOT belong in a daily global digest.
   - Stories that are rehashes of events that broke more than 24-36 hours ago with no genuinely new development today. If the only "news" is that diplomats are still talking about something from last week, skip it unless there is a concrete new fact (agreement reached, deadline set, named participant, new casualty figure, etc.). When in doubt, prefer silence over stale.

7. Sports: INCLUDE top results/scores from major leagues and tournaments. PRIORITIZE (in this order): European football (Champions League, Europa League, Conference League, Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Ekstraklasa), Polish athletes in any sport, tennis Grand Slams, F1, Olympics, cricket Test matches. DEPRIORITIZE: NHL, NBA regular-season games, darts, snooker, rugby league unless there's a genuine milestone (title won, record broken, championship final). CONSOLIDATE: if several sources report the same tie or round (e.g., "Europa League quarter-finals"), merge into ONE item summarising the round, not one item per match. Tag as "sports". Aim for 5-8 sports items total — quality over quantity.

8. Culture & Arts: INCLUDE notable cultural events, exhibitions, film/music releases, literary awards, theater, and cultural news. Prioritize Polish culture stories from Culture.pl alongside worldwide cultural highlights. Tag as "culture". Aim for 5-8 culture items.

9. Economics & Macro: INCLUDE inflation readings (CPI, PPI), central bank rate decisions, GDP figures, employment data, trade balance reports, and institutional economic forecasts (IMF, World Bank, ECB). Tag as "economics". These will feed into the Markets & Macro section.

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

## SOURCE ATTRIBUTION (MANDATORY ON EVERY STORY)
Every story MUST end with at least one linked source. No exceptions, no anonymous claims. Use the "all_sources" array on each story — it is always populated.

- SINGLE-source stories (all_sources has one entry): name that source in the text. "Bloomberg reported ... ([Bloomberg](url))" or end with "([Bloomberg](url))". Never write a story with no citation.
- MULTI-source stories (all_sources has 2+ entries): name the sources explicitly. If they broadly agree: "According to reports from BBC, Reuters, and France 24, ..." or end with "(reported by [BBC](url), [Reuters](url), and [France 24](url))".
- Different angles (check the "angle" field): describe each perspective by name. "BBC focused on the humanitarian toll ([BBC](url)), while Al Jazeera highlighted the diplomatic fallout ([Al Jazeera](url)) and TASS emphasized Russia's response ([TASS](url))".
- Conflicting coverage (flagged "conflicting": true): contrast the narratives. "Western outlets including The Guardian and Reuters reported X, while Chinese state media (China Daily, SCMP) framed the situation as Y".
- For multi-source stories, link at least 2-3 sources so the reader can access different perspectives.
- The goal is transparency: the reader should always know WHO is reporting WHAT.

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

**Sudan conflict gets priority within the Africa sub-section.** The war in Sudan is one of the world's largest humanitarian crises and receives far less coverage than it deserves. If there are any Sudan conflict updates — fighting, displacement, aid blockages, famine, atrocities — lead with them in the Africa sub-section. This does not need the same depth as Ukraine or Iran coverage, but it should be present whenever there is something to report.

---

## 📌 Also Notable

[Brief bullet points of other significant stories, including US domestic stories]

---

## 🌐 Happened in the World

[One-liner bullet points for stories from countries/regions that didn't make it into ANY section above. CRITICAL: Do NOT repeat any story already covered elsewhere in the digest — check Global Politics, country sections, category sections, and Global South before including a story here. The purpose is geographic breadth — the reader should feel they've scanned the entire globe. Each bullet: one sentence + source link. Aim for 5-8 bullets covering as many different regions as possible. Examples:
- **Kazakhstan**: Government approved new rare earth mining regulations. ([The Astana Times](url))
- **Egypt**: Cairo metro expansion project receives $2B funding. ([Mada Masr](url))
- **Iran**: Tehran announced new satellite launch timeline. ([Tehran Times](url))
Prioritize stories from Central Asia, Middle East, Africa, and Latin America — regions that tend to be underrepresented in the main sections.

SIGNIFICANCE BAR: every bullet must have broader significance — policy change, diplomatic move, economic shift, disaster, cross-border development, or a pattern revealing something systemic. A single couple convicted of fraud, a local crime, a one-off arrest, a personal-interest story — these do NOT belong here even if they fit a region you want to cover. Skip the region rather than fill with trivia. Central-bank signals count only if there is a concrete decision or new data point.

FRESHNESS BAR: the bullet must reflect a new development in the last 24 hours — a new decision, new data, new named participant, new event. If the only "news" is that something reported last week is still being discussed, skip it.]

---

## 📰 Editorial Picks

[Select 2-3 of the best editorial/investigative articles from sources marked "editorial": true (Bellingcat, The Conversation, The Intercept, Global Voices, Carbon Brief, The Markup, ICIJ, OCCRP, Mongabay, African Arguments, ProPublica). IMPORTANT: Pick editorials on DIFFERENT topics — do not select multiple pieces about the same subject or from the same source. Aim for topical diversity (e.g. one environment, one tech/policy, one geopolitics). For each: write 2-3 sentences summarising the core argument and why it matters, then cite the source with link. The reader should understand what the piece argues without clicking through.]

---

## ⚽ Sports

[One-liner bullet points for major sports results from the last 24 hours, written for a European reader in Cyprus with ties to Poland. Each bullet: single sentence with the key result/score. Format:
- **Champions League**: Barcelona 2-1 PSG in semi-final first leg. ([BBC Sport](url))
- **Premier League**: Arsenal 3-0 Chelsea, moving to top of the table. ([Sky Sports](url))
- **F1**: Verstappen wins Australian Grand Prix. ([The Guardian](url))
- **Tennis**: Djokovic advances to Roland Garros quarter-finals. ([Marca](url))

PRIORITIZE (in this order): European football (Champions League, Europa League, Conference League, Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Ekstraklasa), Polish athletes in any sport, tennis Grand Slams, F1, Olympics, cricket Test matches.

DEPRIORITIZE (only include with a genuine milestone — title won, record broken, championship final): NHL, NBA regular-season games, darts, snooker, rugby league, minor-league results. Routine regular-season scores from North American leagues do NOT belong here.

CONSOLIDATE same-round coverage: when several matches from the same round are in the triaged stories (e.g., Europa League quarter-final second legs), write ONE bullet summarising the round's results — not one bullet per match. Example: "**Europa League**: Aston Villa and Nottingham Forest both advanced to the semi-finals, setting up an all-English tie; Tottenham and Rangers also through. ([BBC Sport](url), [Sky Sports](url))". Over-reporting football fixture-by-fixture is worse than under-reporting.

Aim for 5-8 bullets total. Quality over quantity. Bold the competition/league at the start of each bullet. If nothing notable happened, write "No major results today." — don't pad.]

---

## 🎭 Culture

[One-liner bullet points covering Polish and worldwide cultural news. Each bullet: one sentence + source link. Format:
- **Polish culture**: New exhibition at POLIN Museum explores interwar avant-garde. ([Culture.pl](url))
- **Film**: Cannes announces Official Selection lineup for 2026. ([The Guardian](url))
- **Music**: Radiohead announce reunion world tour. ([BBC Culture](url))
- **Art**: Banksy mural discovered in London warehouse. ([Artnet](url))
ALWAYS include at least 1-2 Polish culture items if available from Culture.pl or Polish sources. Aim for 4-7 bullets total. If no notable cultural news exists, write "No major cultural stories today."]

---

## 📈 Markets & Macro

| Index / Asset | Value | Change |
|---|---|---|
[MARKET_DATA_HERE]

**Market Commentary**

[1-2 sentences explaining what drove markets today]

**Macro & Inflation Watch**

[Write 3-5 sentences covering the most significant macroeconomic developments from the last 24 hours. Focus on:
- Inflation readings (CPI, PPI) from major economies — cite the actual numbers and compare to expectations or previous readings
- Central bank rate decisions or policy signals (Fed, ECB, BoE, BoJ, etc.)
- GDP, employment, trade balance, or PMI data releases
- IMF/World Bank forecasts or warnings
- Notable economic policy changes (tariffs, sanctions, fiscal packages)

CONTEXT RULE: every central-bank or macro item must include one clause explaining why it matters — for markets, for the euro area, for Poland, or for the reader's daily life. A bare "governor signalled caution ahead of meeting" is not enough. Either the item has a concrete new fact (number, decision, named action) AND a one-line "why it matters", or it doesn't belong in this section. If the only news is "official will speak at meeting next week", skip it entirely.

If no major macro data was released today, briefly note what's coming up this week (e.g., "US CPI due Thursday, ECB meeting next week"). Always cite sources with links.]

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
- Target approximately 2,800-3,800 words for the entire digest
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
- NO DUPLICATE STORIES: A story MUST appear in exactly ONE section. If a story fits multiple sections (e.g. a Nigerian airstrike could go in Global Politics, Global South, or Happened in the World), pick the SINGLE most relevant section and do NOT mention it again elsewhere. Before writing each section, check what you have already covered.
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
- REMOVE the "Also Notable" section entirely
- Keep the "Happened in the World" section verbatim (it's already one-liners, don't shorten further)
- Keep the "Sports" section verbatim (it's already one-liners, don't shorten further)
- Keep the "Culture" section verbatim (it's already one-liners, don't shorten further)
- Keep the "Markets & Macro" section verbatim — preserve the table, market commentary, and macro & inflation watch
- For "Editorial Picks": keep the 2-3 sentence summaries from the full digest (do NOT shorten these further). Each editorial pick MUST be formatted exactly like this (note the blank lines):

**Bold Title**

Summary text here, 2-3 sentences. ([Source](url))

[Read more →](${websiteUrl})

**Next Bold Title**

Next summary text. ([Source](url))

[Read more →](${websiteUrl})
- Each story MUST be its own paragraph, separated by a blank line
- Add at the very top (before the title): *[Read the full digest online →](${websiteUrl})*
- Add at the very bottom (after weather, as the last line): **[See all stories on the website →](${websiteUrl})**
- Target: 1,000-1,500 words maximum
- Do NOT use markdown blockquote syntax (lines starting with >)
- Preserve all markdown formatting: headers, bold, links, tables, horizontal rules

## FULL DIGEST TO CONDENSE
${fullDigest}`;
}

export function buildHeadlineEmailPrompt(fullDigest: string, websiteUrl: string): string {
  return `You are creating a scannable headline-driven email briefing from a full news digest. The full digest is published on a website — this email is a quick scan that lets the reader decide what to read in depth online.

## FORMAT

The email has TWO distinct tiers of content:

### Tier 1: Top Stories (prose treatment)
Select the 6-10 most important stories from the digest. For each:
- **Bold headline**
- 2-3 sentences capturing the key facts and why it matters
- Source citation as a clickable link: ([Source](url))
- If multiple sources covered it, name them

These should be the stories where the reader thinks "I need to know about this." Prioritize: breaking events, priority countries (Poland, Cyprus, Nepal, Ukraine), and stories with multi-source or conflicting coverage.

### Tier 2: Headlines (scan-only, no prose)
Group ALL remaining stories under bold category sub-headers. Each story is ONE bullet point:
- **Bold headline** — single-clause summary. ([Source](url))

Category sub-headers to use (only include categories that have stories):
**Global Politics** | **Poland** | **Cyprus** | **Nepal** | **Europe** | **Americas** | **Asia** | **Africa & Middle East** | **Technology** | **Climate** | **Science** | **Business** | **Health** | **Sports** | **Culture**

### Other sections
- "Happened in the World" — keep verbatim from the full digest (already one-liners)
- "Editorial Picks" — keep the 2-3 sentence summaries from the full digest (do NOT shorten)
- Markets table and Weather tables — copy verbatim
- REMOVE "Also Notable" entirely

## STRUCTURE

*[Read the full digest online →](${websiteUrl})*

[Title, date line, and compiled-from note — keep exactly as in the full digest]

---

## Top Stories

[6-10 stories with 2-3 sentence summaries]

---

## Headlines

[Categorized one-liner bullets for everything else]

---

## 🌐 Happened in the World
[Verbatim from full digest]

---

## 📰 Editorial Picks
[Full summaries from digest, not shortened. Each pick: **Bold Title** on its own line, blank line, summary text, blank line before next pick.]

---

## ⚽ Sports
[Verbatim from full digest — already one-liners]

---

## 🎭 Culture
[Verbatim from full digest — already one-liners]

---

## 📈 Markets & Macro
[Verbatim table and macro commentary]

---

## 🌤️ Weather Forecast
[Verbatim tables]

---

**[See all stories on the website →](${websiteUrl})**

## RULES
- Target: 800-1,200 words (a 3-5 minute read)
- The Top Stories section is the ONLY place with multi-sentence prose
- Headlines section must be pure one-liner bullets — no paragraphs
- NO DUPLICATE STORIES: Every story appears ONCE — either in Top Stories or Headlines, never both. If a story was placed in Top Stories, do NOT repeat it as a headline.
- Do NOT use markdown blockquote syntax (lines starting with >)
- Preserve all markdown formatting: headers, bold, links, tables, horizontal rules
- Every story from the full digest should appear somewhere (either Top Stories or Headlines) — don't drop stories, just compress them to headlines

## FULL DIGEST TO CONVERT
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
