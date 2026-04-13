#!/usr/bin/env node
/**
 * Test all RSS feeds from config.ts
 * Run: node test-feeds.mjs
 */

import { readFileSync } from 'fs';

const config = readFileSync('./src/config.ts', 'utf-8');
const feeds = [];
const re = /\{\s*name:\s*'([^']+)',\s*url:\s*'([^']+)'/g;
let m;
while ((m = re.exec(config)) !== null) {
  feeds.push({ name: m[1], url: m[2] });
}

console.log(`Testing ${feeds.length} feeds...\n`);

const TIMEOUT = 10_000;
const CONCURRENCY = 10;

async function testFeed({ name, url }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'AiNewsWorker-FeedChecker/1.0' },
      redirect: 'follow',
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { name, url, status: 'HTTP_ERROR', detail: `${res.status} ${res.statusText}` };
    }
    const text = await res.text();
    const head = text.slice(0, 500).toLowerCase();
    if (!head.includes('<rss') && !head.includes('<feed') && !head.includes('<rdf') && !head.includes('<?xml')) {
      return { name, url, status: 'PARSE_ERROR', detail: 'No XML/RSS markers in response' };
    }
    const items = (text.match(/<item[\s>]/g) || []).length + (text.match(/<entry[\s>]/g) || []).length;
    return { name, url, status: 'OK', detail: `${items} items` };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { name, url, status: 'TIMEOUT', detail: `>${TIMEOUT / 1000}s` };
    }
    return { name, url, status: 'NETWORK_ERROR', detail: err.message.slice(0, 80) };
  }
}

// Run in batches
const results = [];
for (let i = 0; i < feeds.length; i += CONCURRENCY) {
  const batch = feeds.slice(i, i + CONCURRENCY);
  const batchResults = await Promise.all(batch.map(testFeed));
  results.push(...batchResults);
  process.stdout.write(`  ${Math.min(i + CONCURRENCY, feeds.length)}/${feeds.length}\r`);
}

const ok = results.filter(r => r.status === 'OK');
const fail = results.filter(r => r.status !== 'OK');

console.log(`\n${'='.repeat(60)}`);
console.log(`WORKING: ${ok.length}/${results.length}`);
console.log(`${'='.repeat(60)}`);
for (const r of ok) {
  console.log(`  ✓ ${r.name.padEnd(25)} ${r.detail}`);
}

if (fail.length > 0) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`FAILING: ${fail.length}/${results.length}`);
  console.log(`${'='.repeat(60)}`);
  for (const r of fail) {
    console.log(`  ✗ ${r.name.padEnd(25)} [${r.status}] ${r.detail}`);
  }
}
