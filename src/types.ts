export interface Env {
  CLAUDE_PLATFORM_API: string;
  MAILJET_API_KEY: string;
  MAILJET_SECRET_KEY: string;
  TRIGGER_TOKEN?: string;
  DIGEST_KV: KVNamespace;
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
}
