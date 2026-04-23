export interface Env {
  CLAUDE_PLATFORM_API: string;
  MAILJET_API_KEY: string;
  MAILJET_SECRET_KEY: string;

  DIGEST_KV: KVNamespace;
  DIGEST_QUEUE: Queue<QueueMessage>;

  // Feature flag: switch the triage stage from single Sonnet call over 200 items
  // to parallel Haiku classification over all items. Set to 'true' to enable.
  USE_BATCHED_CLASSIFICATION?: string;

  // Optional: external uptime-monitor ping URL (healthchecks.io, Better Uptime,
  // cronitor, etc.). Phase 2 GETs this on successful completion; if no ping
  // arrives within the grace period the external service emails the alarm —
  // independent of Cloudflare, so it catches account-level outages our own
  // watchdog can't. Set via `npx wrangler secret put HEARTBEAT_URL`.
  HEARTBEAT_URL?: string;
}

// Messages flowing through DIGEST_QUEUE between Phase 1 (cron / /run) and
// Phase 2 (queue consumer). The discriminator `kind` keeps it forward-compatible
// — add a new variant rather than overloading an existing one.
export type QueueMessage =
  | {
      // Standard handoff: Phase 1 wrote phase1:{date} to KV, run Phase 2 now.
      kind: 'compile-and-send';
      date: string;
      testMode?: boolean;
    }
  | {
      // Manual retrigger: skip compile, just resend cached emailMarkdown to all.
      kind: 'resend';
      date: string;
      testMode?: boolean;
      onlyTo?: { email: string; name: string };
    };

// Persisted output of Phase 1 — everything Phase 2 needs to compile + send.
// Lives at `phase1:{date}` in KV, 7-day TTL.
export interface Phase1Output {
  date: string;
  selectedInput: SelectedDigestInput;
  triagedStories: TriagedStory[];
  weather: WeatherData[];
  markets: MarketData;
  feedStats: { total: number; failed: number; succeeded: number };
  storyImages: Record<string, string>;
}

export interface RssFeedConfig {
  name: string;
  url: string;
  category: string;
  editorial?: boolean;
}

export interface RssItem {
  title: string;
  summary: string;
  link: string;
  pubDate: string;
  source: string;
  editorial?: boolean;
  imageUrl?: string;
}

export interface TriagedStory {
  headline: string;
  summary: string;
  source: string;
  link: string;
  country_tags: string[];
  category_tags: string[];
  importance: 'high' | 'medium';
  duplicate_of: number | null;
  conflicting?: boolean;
  conflict_note?: string;
  editorial?: boolean;
  imageUrl?: string;
  all_sources?: { name: string; link: string; angle?: string }[];
}

// Output of Stage 2 (Haiku classification). Minimal shape: each item keeps its
// original fields plus three-tier importance and category/country tags. No
// duplicate_of or all_sources here — those are built in Stage 3 after seeing
// items across batches.
export interface ClassifiedItem {
  headline: string;
  summary: string;
  source: string;
  link: string;
  pubDate: string;
  country_tags: string[];
  category_tags: string[];
  importance: 'high' | 'medium' | 'low';
  editorial?: boolean;
  imageUrl?: string;
  // Populated during Stage 3 (URL dedup + semantic dedup). Lists every outlet
  // that covered the same event so compilation can cite multiple perspectives.
  all_sources?: { name: string; link: string; angle?: string }[];
  conflicting?: boolean;
  conflict_note?: string;
}

// Output of Stage 4 (balance-aware selection). Stories are pre-assigned to
// their target section; compilation just formats them.
export type SectionKey =
  | 'politics'
  | 'poland'
  | 'cyprus'
  | 'nepal'
  | 'europe'
  | 'brics'
  | 'usa'
  | 'tech'
  | 'climate'
  | 'science'
  | 'business'
  | 'health'
  | 'globalSouth'
  | 'alsoNotable'
  | 'happenedInWorld'
  | 'editorial'
  | 'sports'
  | 'culture';

export interface SelectedDigestSection {
  key: SectionKey;
  header: string;           // e.g. '🏛️ Global Politics'
  format: 'prose' | 'bullets' | 'editorial';
  stories: ClassifiedItem[];
}

export interface SelectedDigestInput {
  sections: SelectedDigestSection[];
  // Selection metadata for debugging — what was dropped and why
  dropped?: { reason: string; link: string; headline: string }[];
  // Flagged gaps (e.g. no Ukraine story today) — compilation will surface these
  gaps?: { section: SectionKey; note: string }[];
}

export interface WeatherLocation {
  name: string;
  lat: number;
  lon: number;
  timezone: string;
}

export interface WeatherDay {
  date: string;
  conditions: string;
  tempMax: number;
  tempMin: number;
}

export interface WeatherData {
  location: string;
  days: WeatherDay[];
}

export interface MarketTicker {
  name: string;
  symbol: string;
}

export interface CurrencyPair {
  from: string;
  to: string;
}

export interface MarketQuote {
  name: string;
  symbol: string;
  price: number | null;
  change: number | null;
  error?: string;
}

export interface CurrencyRate {
  pair: string;
  rate: number | null;
  error?: string;
}

export interface MarketData {
  quotes: MarketQuote[];
  currencies: CurrencyRate[];
}

export interface PipelineResult {
  rssItems: RssItem[];
  rssFeedsFailed: number;
  rssFeedsTotal: number;
  weather: WeatherData[];
  markets: MarketData;
  triagedStories: TriagedStory[];
  digest: string;
}

export interface FeedStatus {
  name: string;
  ok: boolean;
  itemCount: number;
  error?: string;
}

export interface DigestData {
  date: string;
  stories: TriagedStory[];
  weather: WeatherData[];
  markets: MarketData;
  feedStats: { total: number; succeeded: number };
  digestMarkdown?: string;
  emailMarkdown?: string;
  storyImages?: Record<string, string>; // maps article URL → image URL
}
