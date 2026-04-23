import type { RssItem, TriagedStory, WeatherData, MarketData, ClassifiedItem, SelectedDigestInput } from './types';

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
   - MUST INCLUDE: At least 1 story each from Africa, Latin America, Central Asia, and South/Southeast Asia — prioritize stories told from local perspectives, not just Western coverage of those regions. Within Africa, give priority to the Sudan conflict — it is one of the world's worst ongoing humanitarian crises and is severely underreported; always include a Sudan update if one exists in the feed.

6. Deprioritize:
   - Celebrity gossip, entertainment unless truly major
   - Local crime stories with no broader significance

7. Sports: INCLUDE top results/scores from major leagues and tournaments worldwide (Champions League, Premier League, La Liga, Bundesliga, NBA, F1, Grand Slams, cricket, Olympics, etc.) and any notable upsets or milestones. Tag as "sports". Aim for 8-12 sports items.

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
Prioritize stories from Central Asia, Middle East, Africa, and Latin America — regions that tend to be underrepresented in the main sections.]

---

## 📰 Editorial Picks

[Select 2-3 of the best editorial/investigative articles from sources marked "editorial": true (Bellingcat, The Conversation, The Intercept, Global Voices, Carbon Brief, The Markup, ICIJ, OCCRP, Mongabay, African Arguments, ProPublica). IMPORTANT: Pick editorials on DIFFERENT topics — do not select multiple pieces about the same subject or from the same source. Aim for topical diversity (e.g. one environment, one tech/policy, one geopolitics). For each: write 2-3 sentences summarising the core argument and why it matters, then cite the source with link. The reader should understand what the piece argues without clicking through.]

---

## ⚽ Sports

[One-liner bullet points for major sports results from the last 24 hours. WORLDWIDE coverage — not limited to European football. Each bullet should be a single sentence with the key result/score. Format:
- **Champions League**: Barcelona 2-1 PSG in semi-final first leg. ([BBC Sport](url))
- **Premier League**: Arsenal 3-0 Chelsea, moving to top of table. ([Sky Sports](url))
- **NBA**: Lakers beat Celtics 112-108 in overtime. ([ESPN](url))
- **F1**: Verstappen wins Australian Grand Prix. ([The Guardian](url))
- **Tennis**: Djokovic advances to Roland Garros quarter-finals. ([Marca](url))
Cover: football (Champions League, Premier League, La Liga, Bundesliga, Serie A, Ekstraklasa), tennis (Grand Slams), F1, NBA, cricket, cycling, Olympics/major tournaments. Aim for 6-10 bullets. Bold the competition/league name at the start of each bullet. If no notable sports results exist for a day, write "No major results today."]

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

## UNIT NORMALIZATION

The audience is Polish/European. If any non-metric or South-Asian-numbering unit slips through from the full digest, convert it in the condensed output. Write out "million" / "billion" (translation handles Polish scale forms later).

- **South Asian numbering → international**: "crore" = 10,000,000; "lakh" = 100,000. "3.6 crore" → "36 million"; "5 lakh" → "500,000". Never keep "crore" or "lakh".
- **Imperial → metric**: miles → km, feet → m, inches → cm, pounds → kg, ounces → g, gallons → litres, °F → °C. Round sensibly (1 decimal max; no decimal for distances > 10 km). "12 miles" → "~19 km"; "75°F" → "24°C".
- **Currency**: keep native currency but add a USD or EUR equivalent in parens for less-familiar currencies (INR, PKR, PHP, NGN, IDR, etc.). Example: "500,000 rupees (~$6,000)". Do NOT convert USD, EUR, GBP, PLN.

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
11. Przelicz wszystkie jednostki niemetryczne na metryczne przed tłumaczeniem: "crore" (10 000 000) i "lakh" (100 000) zamień na miliony / setki tysięcy; mile → km; stopy → m; cale → cm; funty → kg; uncje → g; galony → litry; °F → °C. Jeśli oryginał ma już przeliczone jednostki (np. "36 million"), zostaw je bez zmian — tylko przetłumacz słowo.
12. Używaj polskich konwencji liczbowych: skale "mln" i "mld" zamiast "million"/"billion" (np. "36 mln wyborców", "2,5 mld USD"); przecinek jako separator dziesiętny ("3,6 mln", nie "3.6 mln"); spacja jako separator tysięcy ("500 000", nie "500,000"). Stopnie Celsjusza: "24°C" (bez spacji).

Zwróć TYLKO przetłumaczony markdown, bez komentarzy.

=== ENGLISH DIGEST ===
${digest}`;
}

// ==============================================================================
// BATCHED CLASSIFICATION PIPELINE (feature-flagged: USE_BATCHED_CLASSIFICATION)
// ==============================================================================

/**
 * Stage 2: per-batch Haiku classification.
 * Given ~75 RSS items, emit a JSON array of ClassifiedItem objects.
 * No selection happens here — every input item is classified and returned.
 * No cross-batch dedup happens here either (see Stage 3).
 */
export function buildClassificationPrompt(items: RssItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] SOURCE: ${item.source}${item.editorial ? ' [EDITORIAL]' : ''}\nTITLE: ${item.title}\nSUMMARY: ${item.summary}\nLINK: ${item.link}\nDATE: ${item.pubDate}`
  ).join('\n\n');

  return `You are tagging news items for a daily digest. The reader lives in Cyprus with ties to Poland and follows technology, climate, science, global politics, and business. Every item below will be classified — do NOT filter anything out, even if it looks uninteresting. Importance ratings handle that.

For EACH item, return a JSON object:
{
  "link": "carried through exactly",
  "headline": "carried through (translate to English if Polish/Nepali/etc.)",
  "summary": "carried through (translate to English if needed, keep under 400 chars)",
  "source": "carried through",
  "pubDate": "carried through",
  "importance": "high" | "medium" | "low",
  "country_tags": ["PL","CY","NP","UA","IL","US","CN","RU","IN","FR","DE","UK","ES","IT","BR","SD","NG","ID","VN","JP","KR","PK","EG","IR","LB",...],
  "category_tags": ["politics","tech_ai","climate","science","business","health","sports","culture","economics","editorial"],
  "editorial": true | false
}

## IMPORTANCE RULES

**HIGH** — the story genuinely matters to a well-informed reader:
- Breaking events: wars, major attacks, deaths of world leaders, coups, elections being called/results announced
- Major policy or legal decisions with broad impact (new treaties, landmark court rulings, central bank rate decisions, large regulatory changes)
- Scientific breakthroughs (published research, drug approvals, space milestones)
- ANY story directly about Poland, Cyprus, Nepal, or Ukraine — these are priority countries
- Major humanitarian crises: Sudan, Gaza, Yemen, climate disasters with significant casualties

**MEDIUM** — substantive and worth noting, not urgent:
- Domestic politics in major countries (non-PL/CY/NP/UA)
- Policy changes in second-tier countries
- Significant business/economy stories (earnings, mergers, unemployment figures, inflation prints)
- Notable cultural events (major awards, big exhibitions, famous artist releases)
- Sports: top-flight league results (Champions League, Premier League, La Liga, Bundesliga, Serie A, Ekstraklasa; NBA finals; Grand Slam tennis; F1), notable upsets or milestones
- Climate and environment developments
- Tech/AI launches, research, regulatory decisions
- Editorial/investigative pieces from Bellingcat, The Conversation, etc.

**LOW** — don't waste the reader's time:
- Celebrity gossip, entertainment industry fluff
- Lifestyle/listicle content ("10 best beaches")
- Minor local crime in countries other than PL/CY/NP with no broader significance
- Routine league matches outside the top flight (Championship, third division, minor leagues) — UNLESS it's a historic promotion/relegation involving a well-known club
- NBA regular-season midweek games, routine injuries, minor transactions
- Op-eds without news peg, think-pieces rehashing known arguments

## TAGGING RULES

- **country_tags**: ISO 3166-1 alpha-2 codes (PL, CY, NP, UA, IL, US, ...). Include EVERY country the story directly concerns. For Middle East conflict, tag at least IL/IR/LB as appropriate. For Ukraine-Russia war, tag UA AND RU.
- **category_tags**: a story can have multiple (e.g. a Ukraine strike: ["politics"]; an EU climate regulation: ["politics","climate"]; a Polish culture festival: ["culture"]). If the source is in Bellingcat/The Conversation/Intercept/Global Voices/Carbon Brief/ICIJ/OCCRP/Mongabay/The Markup, add "editorial".
- **editorial**: true if the source is marked [EDITORIAL] in the input.
- **Sports**: always tag category "sports". Tag country_tags with the league's country (NBA → US; Ekstraklasa → PL; Premier League → UK).

## LANGUAGE

Any Polish, Nepali, or other non-English headline/summary: translate to English in the output. Keep summaries under 400 characters.

## OUTPUT

Return ONLY a JSON array of objects — one per input item, in the same order. No markdown code fences. No commentary. No items omitted.

=== RSS ITEMS ===
${itemsText}`;
}

/**
 * Stage 3b: semantic dedup across ALL classified items (post URL-dedup).
 * One Haiku call sees every surviving item at once and returns groups of items
 * that describe the same event.
 *
 * Input: minimal tuples — summaries are NOT included to keep the payload small.
 */
export function buildSemanticDedupPrompt(items: ClassifiedItem[]): string {
  const itemsText = items.map((item, i) =>
    `[${i}] ${item.source} — "${item.headline}" — tags: ${(item.country_tags || []).join(',')} — ${item.pubDate}`
  ).join('\n');

  return `You are finding duplicate news stories. Each line below is ONE news item: [idx] source — "headline" — country_tags — pubDate.

Group items that describe the SAME real-world event. Two items are duplicates when they report on the same specific event, even if they emphasise different aspects (e.g., "civilian toll" and "diplomatic response" to the same strike are duplicates; they cover the same event from different angles).

NOT duplicates:
- Two separate events involving the same actor (two different Trump announcements on the same day)
- Same general topic but different specific events (two unrelated climate protests)
- Multi-day coverage of an ongoing situation — treat different days as separate events unless the headline is clearly about the SAME news moment

Output format — return ONLY a JSON array:
[
  {"primary": 3, "duplicates": [7, 11, 19], "rationale": "short note — all about today's Iran strike"},
  {"primary": 5, "duplicates": [14], "rationale": "both about today's Polish sejm vote"}
]

- "primary" is the idx of the most authoritative/original entry (prefer major agencies: Reuters, BBC, Bloomberg; or the source closest to the story — e.g. Al Jazeera for Middle East, Kathmandu Post for Nepal).
- "duplicates" lists the OTHER idxs that cover the same event. Do NOT include the primary's own idx.
- Only emit groups with at least one duplicate. Items not in any group are implicit singletons — do not list them.
- If multiple sources cover the same event from clearly contradictory angles (e.g. Western outlet vs Russian state media with different framings), still put them in the same group — add "conflicting" before the rationale, like: "conflicting — BBC reports casualties, TASS denies them"

Return ONLY the JSON array, no markdown fences, no commentary.

=== ITEMS ===
${itemsText}`;
}

/**
 * Stage 5 (new): compilation prompt that takes pre-sectioned input.
 * The LLM's job is reduced to prose-writing — selection, sectioning, and dedup
 * are already done upstream.
 */
export function buildSectionedCompilationPrompt(
  input: SelectedDigestInput,
  weather: WeatherData[],
  markets: MarketData,
  feedStats: { total: number; failed: number },
): string {
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

  // Serialize sections as JSON so the LLM knows exactly what to format.
  const sectionsJson = JSON.stringify(input.sections, null, 2);
  const gapsJson = JSON.stringify(input.gaps ?? [], null, 2);
  const weatherJson = JSON.stringify(weather, null, 2);
  const marketsJson = JSON.stringify(markets, null, 2);

  return `You are writing a daily news digest for Filip in Pegeia, Cyprus (ties to Poland, follows technology, climate, science, global politics, business).

**IMPORTANT: stories have ALREADY been selected, sectioned, and deduplicated upstream. Your job is ONLY to format each section and write prose. Do NOT:**
- re-select stories (use every story provided, unless truly none exist in a section)
- move stories between sections
- drop stories
- add stories from elsewhere
- mention the same event in two different sections

## FORMAT RULES BY SECTION

The sections come pre-formatted in a JSON array. Each section has a "format" field:

**format: "prose"** — 3-6 sentences per story. Structure:
\`\`\`
**Bold Headline**

Story prose here, 3-6 sentences with key facts, figures, quotes, context. ([Source Name](url))

**Next Headline**

Next prose. ([Source](url))
\`\`\`

**format: "bullets"** — one line per story. Structure:
\`\`\`
- **Bold prefix**: one-sentence summary. ([Source](url))
\`\`\`
Bold prefix examples: for happened-in-the-world, use country ("**Kazakhstan**"); for sports, use competition ("**Champions League**", "**Premier League**", "**NBA**"); for culture, use type ("**Film**", "**Music**", "**Art**", "**Polish culture**").

**format: "editorial"** — 2-3 sentences summarising the argument:
\`\`\`
**Bold Title**

2-3 sentence summary of what the piece argues and why it matters. ([Source](url))
\`\`\`

## MULTI-SOURCE ATTRIBUTION

If a story has "all_sources" with multiple entries:
- Name 2-3 outlets explicitly: "According to BBC, Reuters, and France 24..." or "...reported by [BBC](url), [Reuters](url), and [France 24](url)"
- If entries have "angle" fields: describe each perspective by name. "BBC focused on the humanitarian toll, while Al Jazeera emphasised the diplomatic fallout"
- If "conflicting" is true: explicitly contrast. "Western outlets (BBC, Reuters) reported X, while TASS framed the situation as Y"

## UNIT NORMALIZATION

The audience is Polish/European. Readers do not know South Asian numbering or imperial units — convert everything to metric / international form before writing. Write out "million" / "billion" (not "mln" / "mld"; translation handles Polish scale forms later).

- **South Asian numbering → international**: "crore" = 10,000,000; "lakh" = 100,000. Examples: "3.6 crore voters" → "36 million voters"; "5 lakh rupees" → "500,000 rupees". Never leave "crore" or "lakh" in the output.
- **Imperial → metric**: miles → km (×1.609), feet → m (×0.3048), inches → cm (×2.54), pounds → kg (×0.4536), ounces → g (×28.35), gallons → litres (×3.785), °F → °C ((F − 32) × 5/9). Round sensibly: 1 decimal max for most; no decimal for distances over 10 km. Examples: "12 miles" → "~19 km"; "75°F" → "24°C"; "150 pounds" → "68 kg".
- **Currency**: leave the native currency but add a USD or EUR equivalent in parentheses when the amount is in a less-familiar currency (INR, PKR, PHP, NGN, IDR, BDT, LKR, EGP, NGN, KES, ZAR, ARS, BRL, MXN, VND, etc.). Example: "500,000 rupees (~$6,000)". Do NOT convert USD, EUR, GBP, or PLN — readers know those.
- **Preserving nuance**: on first mention, you may keep the original in parens if helpful — "36 million (3.6 crore)". On subsequent mentions, use the converted form only.
- **If the source is already metric/international**: leave it alone.

## GAPS

After a section, if input.gaps lists a note for that section, emit the note as a single italicised line. Example: *No major Ukraine developments in today's feeds.*

## OUTPUT STRUCTURE (follow exactly)

# Daily News Digest — ${dateStr}

*Compiled from ${sourcesNote}. All stories from the last 24 hours. Cross-referenced across outlets.*

---

[For each section in input.sections (already in correct order), emit:
## {section.header}

{formatted stories per section.format}

{gap note if any, as italic line}

---
]

## 📈 Markets & Macro

| Index / Asset | Value | Change |
|---|---|---|
[market table rows]

**Market Commentary**

[1-2 sentences on what drove markets today, using market data provided]

**Macro & Inflation Watch**

[3-5 sentences on the most significant macroeconomic developments — CPI/PPI prints, central bank decisions, GDP/employment/trade data, IMF/World Bank forecasts, tariffs/sanctions. If none today, note what's coming up this week. Always cite sources.]

---

## 🌤️ Weather Forecast

### Pegeia, Cyprus (next 3 days)
| Day | Conditions | High / Low |
|---|---|---|
[rows]

### Gdańsk, Poland (next 3 days)
| Day | Conditions | High / Low |
|---|---|---|
[rows]

---
*Generated automatically by AI News Digest. [Read the full digest online.](https://ainewsworker.rogaczewski-dev.workers.dev/)*

## GUIDELINES

- Target ~2,800-3,800 words total
- Each prose story 3-6 sentences, reader should not need to click through
- Every story MUST start with **bold headline**, then blank line, then text (for prose format)
- Bullet stories: single line, **bold prefix**, one sentence, source link
- Always cite as ([Source Name](url)) — clickable markdown links
- NO markdown blockquotes (lines starting with \`>\`) — they do not render in email
- If a section has zero stories, OMIT the entire section (do not emit header + "no stories today")

=== INPUT SECTIONS (ordered, pre-formatted) ===
${sectionsJson}

=== GAPS ===
${gapsJson}

=== WEATHER DATA ===
${weatherJson}

=== MARKET DATA ===
${marketsJson}`;
}
