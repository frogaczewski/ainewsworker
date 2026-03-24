import { MARKET_TICKERS, CURRENCY_PAIRS } from './config';
import type { MarketQuote, CurrencyRate, MarketData } from './types';

interface YahooQuoteResult {
  quoteResponse?: {
    result?: Array<{
      symbol?: string;
      regularMarketPrice?: number;
      regularMarketChangePercent?: number;
      regularMarketPreviousClose?: number;
    }>;
  };
}

interface YahooChartResult {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
    }>;
  };
}

// Batch fetch all tickers in a single request using the quote endpoint
async function fetchYahooQuotesBatch(tickers: typeof MARKET_TICKERS): Promise<MarketQuote[]> {
  try {
    const symbols = tickers.map(t => t.symbol).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DailyNewsDigest/2.0' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as YahooQuoteResult;
    const results = data.quoteResponse?.result ?? [];

    return tickers.map(ticker => {
      const quote = results.find(r => r.symbol === ticker.symbol);
      if (quote?.regularMarketPrice) {
        return {
          name: ticker.name,
          symbol: ticker.symbol,
          price: Math.round(quote.regularMarketPrice * 100) / 100,
          change: Math.round((quote.regularMarketChangePercent ?? 0) * 100) / 100,
        };
      }
      return {
        name: ticker.name,
        symbol: ticker.symbol,
        price: null,
        change: null,
        error: 'No data in batch response',
      };
    });
  } catch (err) {
    console.log(`[Markets] Batch Yahoo quote failed: ${err instanceof Error ? err.message : err}`);
    // Fallback: try chart API individually (costs more subrequests)
    return fetchYahooQuotesIndividual(tickers);
  }
}

// Fallback: fetch one at a time via chart API
async function fetchYahooQuotesIndividual(tickers: typeof MARKET_TICKERS): Promise<MarketQuote[]> {
  console.log('[Markets] Falling back to individual chart API calls');
  return Promise.all(tickers.map(async (ticker): Promise<MarketQuote> => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.symbol}?interval=1d&range=2d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'DailyNewsDigest/2.0' },
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
    } catch (err) {
      return {
        name: ticker.name,
        symbol: ticker.symbol,
        price: null,
        change: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
}

async function fetchCurrencyRates(pairs: typeof CURRENCY_PAIRS): Promise<CurrencyRate[]> {
  // Fetch each pair (can't easily batch different base currencies)
  return Promise.all(pairs.map(async (pair): Promise<CurrencyRate> => {
    try {
      const url = `https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`;
      const response = await fetch(url);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json() as { rates: Record<string, number> };
      const rate = data.rates[pair.to];

      if (!rate) throw new Error('No rate data');

      return {
        pair: `${pair.from}/${pair.to}`,
        rate: Math.round(rate * 10000) / 10000,
      };
    } catch (err) {
      return {
        pair: `${pair.from}/${pair.to}`,
        rate: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
}

export async function fetchMarketData(): Promise<MarketData> {
  const [quotes, currencies] = await Promise.all([
    fetchYahooQuotesBatch(MARKET_TICKERS),  // 1 request (instead of 5)
    fetchCurrencyRates(CURRENCY_PAIRS),      // 2 requests
  ]);

  return { quotes, currencies };
}
