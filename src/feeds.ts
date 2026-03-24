import { RSS_FEEDS } from './config';
import { parseRssFeed } from './rss-parser';
import type { RssItem } from './types';

interface FeedResult {
  items: RssItem[];
  failed: number;
  total: number;
  errors: string[];
}

async function fetchSingleFeed(feed: { name: string; url: string }): Promise<{ items: RssItem[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout per feed

    const response = await fetch(feed.url, {
      headers: {
        'User-Agent': 'DailyNewsDigest/2.0 (Cloudflare Worker)',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { items: [], error: `${feed.name}: HTTP ${response.status}` };
    }

    const xml = await response.text();
    const items = parseRssFeed(xml, feed.name);
    return { items };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: [], error: `${feed.name}: ${message}` };
  }
}

// Fetch feeds in batches to manage subrequest budget
// Each batch runs in parallel, but batches run sequentially
async function fetchFeedsInBatches(feeds: typeof RSS_FEEDS, batchSize: number): Promise<{ items: RssItem[]; error?: string }[]> {
  const results: { items: RssItem[]; error?: string }[] = [];

  for (let i = 0; i < feeds.length; i += batchSize) {
    const batch = feeds.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(
      batch.map(feed => fetchSingleFeed(feed))
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push({ items: [], error: `Unexpected: ${result.reason}` });
      }
    }
  }

  return results;
}

export async function fetchAllFeeds(): Promise<FeedResult> {
  // Fetch all feeds in parallel (single batch) — relies on subrequest limit
  const results = await fetchFeedsInBatches(RSS_FEEDS, RSS_FEEDS.length);

  const allItems: RssItem[] = [];
  const errors: string[] = [];
  let failed = 0;

  for (const result of results) {
    allItems.push(...result.items);
    if (result.error) {
      errors.push(result.error);
      failed++;
    }
  }

  console.log(`[Feeds] Fetched ${allItems.length} items, ${failed} feeds failed out of ${RSS_FEEDS.length}`);

  return {
    items: allItems,
    failed,
    total: RSS_FEEDS.length,
    errors,
  };
}
