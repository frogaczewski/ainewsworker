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

/** Decode XML entities in URLs (e.g. &amp; → &) */
function decodeXmlEntities(url: string): string {
  return url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/** Extract image URL from an RSS item using multiple fallback sources */
function extractImageUrl(itemXml: string): string {
  // 1. media:content url attribute (most common for news feeds)
  const mediaContent = extractAttr(itemXml, 'media:content', 'url');
  if (mediaContent && looksLikeImageUrl(mediaContent)) return decodeXmlEntities(mediaContent);

  // 2. media:thumbnail url attribute
  const mediaThumbnail = extractAttr(itemXml, 'media:thumbnail', 'url');
  if (mediaThumbnail) return decodeXmlEntities(mediaThumbnail);

  // 3. enclosure with image type
  const enclosureType = extractAttr(itemXml, 'enclosure', 'type');
  if (enclosureType && enclosureType.startsWith('image/')) {
    const enclosureUrl = extractAttr(itemXml, 'enclosure', 'url');
    if (enclosureUrl) return decodeXmlEntities(enclosureUrl);
  }

  // 4. First <img> in description/content (some feeds embed HTML)
  const descHtml = extractTag(itemXml, 'description') || extractTag(itemXml, 'content:encoded');
  if (descHtml) {
    const imgMatch = descHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch && imgMatch[1] && looksLikeImageUrl(imgMatch[1])) return imgMatch[1];
  }

  return '';
}

function looksLikeImageUrl(url: string): boolean {
  if (!url || url.length < 10) return false;
  // Skip tracking pixels and tiny icons
  if (url.includes('1x1') || url.includes('pixel') || url.includes('tracking')) return false;
  const lower = url.toLowerCase();
  return lower.startsWith('http') && (
    lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.png') ||
    lower.includes('.webp') || lower.includes('image') || lower.includes('/img/') ||
    lower.includes('/photo') || lower.includes('/media/') || lower.includes('resize')
  );
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
    const imageUrl = extractImageUrl(itemXml);

    if (title && isWithinHours(pubDate, 36)) {
      items.push({
        title,
        summary: summary.slice(0, 300), // Cap summary length for token budget
        link,
        pubDate,
        source: sourceName,
        ...(imageUrl && { imageUrl }),
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
    const imageUrl = extractImageUrl(entryXml);

    if (title && isWithinHours(pubDate, 36)) {
      items.push({
        title,
        summary: summary.slice(0, 300),
        link,
        pubDate,
        source: sourceName,
        ...(imageUrl && { imageUrl }),
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
