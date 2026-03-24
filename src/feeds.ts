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

export async function fetchAllFeeds(): Promise<FeedResult> {
  const results = await Promise.allSettled(
    RSS_FEEDS.map(feed => fetchSingleFeed(feed))
  );

  const allItems: RssItem[] = [];
  const errors: string[] = [];
  let failed = 0;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value.items);
      if (result.value.error) {
        errors.push(result.value.error);
        failed++;
      }
    } else {
      errors.push(`Unexpected error: ${result.reason}`);
      failed++;
    }
  }

  return {
    items: allItems,
    failed,
    total: RSS_FEEDS.length,
    errors,
  };
}
