import type { RssItem } from './types';

/**
 * Lightweight XML-to-RSS parser for Workers runtime.
 * Handles RSS 2.0, Atom, and MRSS formats without Node.js dependencies.
 */

function extractTag(xml: string, tag: string): string {
  // Try with CDATA first
  const cdataRegex = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();

  // Regular tag content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(regex);
  if (match) return match[1].trim();

  return '';
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const regex = new RegExp(`<${tag}[^>]*\\s${attr}=["']([^"']*)["']`, 'i');
  const match = xml.match(regex);
  return match ? match[1].trim() : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function isWithinHours(dateStr: string, hours: number): boolean {
  if (!dateStr) return true; // If no date, include the item
  try {
    const itemDate = new Date(dateStr);
    if (isNaN(itemDate.getTime())) return true; // Can't parse, include it
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    return itemDate.getTime() > cutoff;
  } catch {
    return true;
  }
}

function parseRss2Items(xml: string, sourceName: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const title = stripHtml(extractTag(itemXml, 'title'));
    const summary = stripHtml(
      extractTag(itemXml, 'description') || extractTag(itemXml, 'content:encoded')
    );
    const link = extractTag(itemXml, 'link') || extractAttr(itemXml, 'link', 'href');
    const pubDate = extractTag(itemXml, 'pubDate') || extractTag(itemXml, 'dc:date');

    if (title && isWithinHours(pubDate, 36)) {
      items.push({
        title,
        summary: summary.slice(0, 300), // Cap summary length for token budget
        link,
        pubDate,
        source: sourceName,
      });
    }
  }

  return items;
}

function parseAtomEntries(xml: string, sourceName: string): RssItem[] {
  const items: RssItem[] = [];
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    const title = stripHtml(extractTag(entryXml, 'title'));
    const summary = stripHtml(
      extractTag(entryXml, 'summary') || extractTag(entryXml, 'content')
    );
    const link = extractAttr(entryXml, 'link', 'href') || extractTag(entryXml, 'link');
    const pubDate = extractTag(entryXml, 'published') || extractTag(entryXml, 'updated');

    if (title && isWithinHours(pubDate, 36)) {
      items.push({
        title,
        summary: summary.slice(0, 300),
        link,
        pubDate,
        source: sourceName,
      });
    }
  }

  return items;
}

export function parseRssFeed(xml: string, sourceName: string): RssItem[] {
  // Detect feed type and parse accordingly
  if (xml.includes('<entry')) {
    // Atom format (The Verge, etc.)
    return parseAtomEntries(xml, sourceName);
  }

  // RSS 2.0 / MRSS (covers most feeds including Al Arabiya MRSS)
  return parseRss2Items(xml, sourceName);
}
