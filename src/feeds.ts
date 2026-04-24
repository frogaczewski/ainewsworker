import { RSS_FEEDS } from './config';
import { parseRssFeed } from './rss-parser';
import type { RssItem, FeedStatus } from './types';

interface FeedResult {
  items: RssItem[];
  failed: number;
  total: number;
  errors: string[];
  feedStatuses: FeedStatus[];
}

export async function fetchSingleFeed(feed: { name: string; url: string; editorial?: boolean }): Promise<{ items: RssItem[]; error?: string }> {
  const userAgents = [
    'DailyNewsDigest/2.0 (Cloudflare Worker)',
    'Mozilla/5.0 (compatible; NewsBot/2.0; +https://ainews.rogaczewski.me)',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko)',
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(feed.url, {
        headers: {
          'User-Agent': userAgents[attempt] || userAgents[0],
          'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*',
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      clearTimeout(timeoutId);

      if (response.status === 403 && attempt < 2) {
        // Bot detection — retry with different User-Agent after brief delay
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }

      if (!response.ok) {
        return { items: [], error: `${feed.name}: HTTP ${response.status}` };
      }

      const xml = await response.text();
      const items = parseRssFeed(xml, feed.name, feed.editorial);
      if (feed.editorial) {
        for (const item of items) {
          item.editorial = true;
        }
      }
      return { items };
    } catch (err) {
      if (attempt < 2 && err instanceof Error && err.name === 'AbortError') {
        // Timeout — retry once
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      return { items: [], error: `${feed.name}: ${message}` };
    }
  }

  return { items: [], error: `${feed.name}: failed after 3 attempts` };
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
  const feedStatuses: FeedStatus[] = [];
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const feedName = RSS_FEEDS[i].name;
    allItems.push(...result.items);
    if (result.error) {
      errors.push(result.error);
      failed++;
      feedStatuses.push({ name: feedName, ok: false, itemCount: 0, error: result.error });
    } else {
      feedStatuses.push({ name: feedName, ok: true, itemCount: result.items.length });
    }
  }

  console.log(`[Feeds] Fetched ${allItems.length} items, ${failed} feeds failed out of ${RSS_FEEDS.length}`);

  return {
    items: allItems,
    failed,
    total: RSS_FEEDS.length,
    errors,
    feedStatuses,
  };
}
