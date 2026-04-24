import type { Env } from './types';

const IP_WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 3;

const GLOBAL_WINDOW_SECONDS = 60 * 60;
const GLOBAL_ALARM_THRESHOLD = 5;
const GLOBAL_KV_TTL_SECONDS = GLOBAL_WINDOW_SECONDS + 5 * 60; // a bit of slack past the window

const ALARM_THROTTLE_SECONDS = 24 * 60 * 60;

const UNSUB_PER_TOKEN_DAILY_LIMIT = 3;
const UNSUB_PER_TOKEN_TTL_SECONDS = 48 * 60 * 60;

/**
 * KV-based counters. KV has no atomic increment, so the read-add-write loop
 * below is racy: two near-simultaneous requests can both read N and both
 * write N+1, effectively allowing one extra hit past the limit. At the
 * expected traffic for this worker (<5 subscribes/hour) that race is not a
 * meaningful bypass. For real abuse-at-scale defence, configure Cloudflare's
 * Rate Limiting Rules at the edge (dashboard-level, not here).
 */

async function hashIp(ip: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(ip));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < 6; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

function currentIpWindowStart(): number {
  return Math.floor(Date.now() / 1000 / IP_WINDOW_SECONDS) * IP_WINDOW_SECONDS;
}

function currentHourKey(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
}

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function parseCounter(raw: string | null): number {
  if (raw === null) return 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export interface IpRateLimitResult {
  allowed: boolean;
  count: number;
}

export async function checkAndIncrementIpRateLimit(
  env: Env,
  ip: string | null,
): Promise<IpRateLimitResult> {
  if (!ip) return { allowed: true, count: 0 };
  const h = await hashIp(ip);
  const key = `ratelimit:ip:${h}:${currentIpWindowStart()}`;
  const current = parseCounter(await env.DIGEST_KV.get(key));
  if (current >= IP_LIMIT) return { allowed: false, count: current };
  await env.DIGEST_KV.put(key, String(current + 1), { expirationTtl: IP_WINDOW_SECONDS });
  return { allowed: true, count: current + 1 };
}

export async function incrementGlobalSubscribeCounter(env: Env): Promise<number> {
  const key = `ratelimit:global:${currentHourKey()}`;
  const next = parseCounter(await env.DIGEST_KV.get(key)) + 1;
  await env.DIGEST_KV.put(key, String(next), { expirationTtl: GLOBAL_KV_TTL_SECONDS });
  return next;
}

export async function shouldFireAlarm(env: Env, currentCount: number): Promise<boolean> {
  if (currentCount <= GLOBAL_ALARM_THRESHOLD) return false;
  const throttle = await env.DIGEST_KV.get('alarm:throttle');
  if (throttle !== null) return false;
  await env.DIGEST_KV.put('alarm:throttle', '1', { expirationTtl: ALARM_THROTTLE_SECONDS });
  return true;
}

export interface UnsubRateLimitResult {
  allowed: boolean;
  count: number;
}

export async function checkAndIncrementUnsubTokenRateLimit(
  env: Env,
  token: string,
): Promise<UnsubRateLimitResult> {
  const key = `unsub-rate:${token}:${todayKey()}`;
  const current = parseCounter(await env.DIGEST_KV.get(key));
  if (current >= UNSUB_PER_TOKEN_DAILY_LIMIT) return { allowed: false, count: current };
  await env.DIGEST_KV.put(key, String(current + 1), { expirationTtl: UNSUB_PER_TOKEN_TTL_SECONDS });
  return { allowed: true, count: current + 1 };
}

export const RATE_LIMIT_THRESHOLDS = {
  ipPerWindow: IP_LIMIT,
  ipWindowSeconds: IP_WINDOW_SECONDS,
  globalAlarmThreshold: GLOBAL_ALARM_THRESHOLD,
  globalWindowSeconds: GLOBAL_WINDOW_SECONDS,
  unsubPerTokenDaily: UNSUB_PER_TOKEN_DAILY_LIMIT,
} as const;
