import { MARKET_TICKERS, CURRENCY_PAIRS } from './config';
import type { MarketQuote, CurrencyRate, MarketData } from './types';

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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.symbol}?interval=1d&range=2d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
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
    fetchYahooQuotes(MARKET_TICKERS),   // 5 requests
    fetchCurrencyRates(CURRENCY_PAIRS), // 2 requests
  ]);

  return { quotes, currencies };
}
