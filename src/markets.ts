import { MARKET_TICKERS, CURRENCY_PAIRS } from './config';
import type { Env, MarketQuote, CurrencyRate, MarketData } from './types';

const MARKETS_KV_KEY = 'markets:last-good';
const MARKETS_KV_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

async function withRetry<T>(fn: () => Promise<T>, retries = 1, backoffMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)));
    }
  }
  throw lastErr;
}

interface YahooChartResult {
  chart?: {
    result?: Array<{
      meta?: {
        symbol?: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
    }>;
  };
}

// Fetch all tickers via Yahoo Finance chart API — one request per ticker
// Uses Promise.all so they run in parallel (counts as N subrequests but same wall-clock)
async function fetchYahooQuotes(tickers: typeof MARKET_TICKERS): Promise<MarketQuote[]> {
  return Promise.all(tickers.map(async (ticker): Promise<MarketQuote> => {
    try {
      return await withRetry(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.symbol}?interval=1d&range=2d`;
          const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: controller.signal,
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const data = await response.json() as YahooChartResult;
          const meta = data.chart?.result?.[0]?.meta;

          if (!meta?.regularMarketPrice) throw new Error('No price data');

          const price = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
          const change = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

          return {
            name: ticker.name,
            symbol: ticker.symbol,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
          };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[Markets] ${ticker.symbol} fetch failed after retry: ${reason}`);
      return {
        name: ticker.name,
        symbol: ticker.symbol,
        price: null,
        change: null,
        error: reason,
      };
    }
  }));
}

async function fetchCurrencyRates(pairs: typeof CURRENCY_PAIRS): Promise<CurrencyRate[]> {
  return Promise.all(pairs.map(async (pair): Promise<CurrencyRate> => {
    try {
      return await withRetry(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const url = `https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`;
          const response = await fetch(url, { signal: controller.signal });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const data = await response.json() as { rates: Record<string, number> };
          const rate = data.rates[pair.to];

          if (!rate) throw new Error('No rate data');

          return {
            pair: `${pair.from}/${pair.to}`,
            rate: Math.round(rate * 10000) / 10000,
          };
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[Markets] ${pair.from}/${pair.to} fetch failed after retry: ${reason}`);
      return {
        pair: `${pair.from}/${pair.to}`,
        rate: null,
        error: reason,
      };
    }
  }));
}

export async function fetchMarketData(): Promise<MarketData> {
  const [quotes, currencies] = await Promise.all([
    fetchYahooQuotes(MARKET_TICKERS),   // 5 requests
    fetchCurrencyRates(CURRENCY_PAIRS), // 2 requests
  ]);

  return { quotes, currencies };
}

interface CachedMarketSnapshot {
  quotes: MarketQuote[];
  currencies: CurrencyRate[];
  cachedFrom: string; // YYYY-MM-DD of the snapshot
}

function isFresh(quote: MarketQuote): boolean {
  return !quote.error && quote.price !== null;
}

function isFreshRate(rate: CurrencyRate): boolean {
  return !rate.error && rate.rate !== null;
}

/**
 * Wrapper around fetchMarketData that:
 *   - Persists the latest fresh quotes/currencies to KV under `markets:last-good`.
 *   - If today's pull yields zero fresh entries, returns the cached snapshot
 *     marked `stale: true` with `cachedFrom` so the digest can render
 *     "*ceny z {date}*" instead of an empty table.
 *   - Partial successes pass through unchanged — we don't merge today's
 *     errors with yesterday's prices, since markets readers expect a
 *     consistent timestamp across the panel.
 */
export async function fetchMarketDataWithCache(env: Env, runDate: string): Promise<MarketData> {
  const live = await fetchMarketData();
  const anyFreshQuote = live.quotes.some(isFresh);
  const anyFreshRate = live.currencies.some(isFreshRate);

  if (anyFreshQuote || anyFreshRate) {
    const snapshot: CachedMarketSnapshot = {
      quotes: live.quotes.filter(isFresh),
      currencies: live.currencies.filter(isFreshRate),
      cachedFrom: runDate,
    };
    if (snapshot.quotes.length > 0 || snapshot.currencies.length > 0) {
      try {
        await env.DIGEST_KV.put(MARKETS_KV_KEY, JSON.stringify(snapshot), {
          expirationTtl: MARKETS_KV_TTL_SECONDS,
        });
      } catch (err) {
        console.log(`[Markets] cache write failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    }
    return live;
  }

  // Total failure — try the cached snapshot.
  try {
    const raw = await env.DIGEST_KV.get(MARKETS_KV_KEY);
    if (raw) {
      const cached = JSON.parse(raw) as CachedMarketSnapshot;
      console.log(`[Markets] live fetch produced no fresh data; serving cached snapshot from ${cached.cachedFrom}`);
      return {
        quotes: cached.quotes,
        currencies: cached.currencies,
        stale: true,
        cachedFrom: cached.cachedFrom,
      };
    }
  } catch (err) {
    console.log(`[Markets] cache read failed: ${err instanceof Error ? err.message : err}`);
  }

  // No cache either — return the empty live result so the digest can fall
  // back to the LLM commentary explaining the outage.
  console.log('[Markets] live fetch failed and no cached snapshot available');
  return live;
}
