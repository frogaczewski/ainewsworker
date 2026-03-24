import { MARKET_TICKERS, CURRENCY_PAIRS } from './config';
import type { MarketQuote, CurrencyRate, MarketData } from './types';

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

async function fetchYahooQuote(ticker: { name: string; symbol: string }): Promise<MarketQuote> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker.symbol}?interval=1d&range=2d`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'DailyNewsDigest/2.0' },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as YahooChartResult;
    const meta = data.chart?.result?.[0]?.meta;

    if (!meta?.regularMarketPrice) {
      throw new Error('No price data');
    }

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
}

async function fetchCurrencyRate(pair: { from: string; to: string }): Promise<CurrencyRate> {
  try {
    const url = `https://api.frankfurter.app/latest?from=${pair.from}&to=${pair.to}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as { rates: Record<string, number> };
    const rate = data.rates[pair.to];

    if (!rate) {
      throw new Error('No rate data');
    }

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
}

export async function fetchMarketData(): Promise<MarketData> {
  const [quotes, currencies] = await Promise.all([
    Promise.all(MARKET_TICKERS.map(t => fetchYahooQuote(t))),
    Promise.all(CURRENCY_PAIRS.map(p => fetchCurrencyRate(p))),
  ]);

  return { quotes, currencies };
}
