import { EMAIL_TO, EMAIL_TO_PL } from './config';
import type {
  Env,
  PendingSubscriberRecord,
  SubscriberLang,
  SubscriberRecord,
  TokenPayload,
} from './types';

const PENDING_TTL_SECONDS = 24 * 60 * 60;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (email.length === 0 || email.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function isValidLang(lang: unknown): lang is SubscriberLang {
  return lang === 'en' || lang === 'pl';
}

async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', key, enc.encode(message));
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function deriveUnsubToken(env: Env, email: string, lang: SubscriberLang): Promise<string> {
  const msg = `unsub|${normalizeEmail(email)}|${lang}`;
  const sig = await hmacSha256(env.UNSUB_TOKEN_SECRET, msg);
  return base64UrlEncode(sig).slice(0, 32);
}

function activeKey(lang: SubscriberLang, email: string): string {
  return `sub:active:${lang}:${normalizeEmail(email)}`;
}

function pendingKey(lang: SubscriberLang, email: string): string {
  return `sub:pending:${lang}:${normalizeEmail(email)}`;
}

function byEmailKey(email: string): string {
  return `sub:byemail:${normalizeEmail(email)}`;
}

function pendingByEmailKey(email: string): string {
  return `sub:pendingbyemail:${normalizeEmail(email)}`;
}

function confirmTokenKey(token: string): string {
  return `token:confirm:${token}`;
}

function unsubConfirmTokenKey(token: string): string {
  return `token:unsub-confirm:${token}`;
}

function suppressKey(email: string): string {
  return `suppress:${normalizeEmail(email)}`;
}

export async function isSuppressed(env: Env, email: string): Promise<boolean> {
  const v = await env.DIGEST_KV.get(suppressKey(email));
  return v !== null;
}

export async function loadSuppressionSet(env: Env, emails: string[]): Promise<Set<string>> {
  const normalized = [...new Set(emails.map(normalizeEmail))];
  const results = await Promise.all(normalized.map(e => env.DIGEST_KV.get(suppressKey(e))));
  const out = new Set<string>();
  for (let i = 0; i < normalized.length; i++) {
    if (results[i] !== null) out.add(normalized[i]);
  }
  return out;
}

export async function getActiveLangForEmail(env: Env, email: string): Promise<SubscriberLang | null> {
  const v = await env.DIGEST_KV.get(byEmailKey(email));
  if (v === 'en' || v === 'pl') return v;
  return null;
}

export async function getPendingLangForEmail(env: Env, email: string): Promise<SubscriberLang | null> {
  const v = await env.DIGEST_KV.get(pendingByEmailKey(email));
  if (v === 'en' || v === 'pl') return v;
  return null;
}

export async function getPendingSubscriber(
  env: Env,
  email: string,
  lang: SubscriberLang,
): Promise<PendingSubscriberRecord | null> {
  const raw = await env.DIGEST_KV.get(pendingKey(lang, email));
  return raw ? (JSON.parse(raw) as PendingSubscriberRecord) : null;
}

export async function getActiveSubscriber(
  env: Env,
  email: string,
  lang: SubscriberLang,
): Promise<SubscriberRecord | null> {
  const raw = await env.DIGEST_KV.get(activeKey(lang, email));
  return raw ? (JSON.parse(raw) as SubscriberRecord) : null;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export interface StartSubscribeResult {
  action: 'created-pending' | 'refreshed-pending' | 'already-active' | 'dropped-suppressed';
  pending?: PendingSubscriberRecord;
}

/**
 * Idempotent "start or refresh a subscription" flow. Callers should always send
 * the user a generic "check your inbox" response regardless of the returned
 * action so the endpoint isn't a subscription-enumeration oracle.
 *
 * - `created-pending` / `refreshed-pending`: caller should send a confirmation email.
 * - `already-active`: do nothing; user is already subscribed.
 * - `dropped-suppressed`: currently unused — suppression is cleared on confirm,
 *   so a suppressed re-subscribe still goes through the pending path. Kept as a
 *   hook if we ever want to gate re-subscribe behind an admin action.
 */
export async function startSubscribe(
  env: Env,
  email: string,
  lang: SubscriberLang,
  name: string | undefined,
): Promise<StartSubscribeResult> {
  const normEmail = normalizeEmail(email);

  const activeLang = await getActiveLangForEmail(env, normEmail);
  if (activeLang) {
    return { action: 'already-active' };
  }

  const existingPendingLang = await getPendingLangForEmail(env, normEmail);
  const now = Date.now();
  const token = randomToken();
  const pending: PendingSubscriberRecord = {
    email: normEmail,
    name,
    lang,
    confirmToken: token,
    tokenExpiresAt: now + PENDING_TTL_SECONDS * 1000,
    createdAt: now,
  };

  // If there's an existing pending record (same or different lang), overwrite
  // cleanly: delete the old confirm-token pointer and any stale lang-scoped
  // pending record so we don't leave orphans behind.
  if (existingPendingLang) {
    const prior = await getPendingSubscriber(env, normEmail, existingPendingLang);
    const deletes: Promise<unknown>[] = [];
    if (prior) deletes.push(env.DIGEST_KV.delete(confirmTokenKey(prior.confirmToken)));
    if (existingPendingLang !== lang) {
      deletes.push(env.DIGEST_KV.delete(pendingKey(existingPendingLang, normEmail)));
    }
    await Promise.all(deletes);
  }

  const tokenPayload: TokenPayload = { email: normEmail, lang, purpose: 'confirm' };
  await Promise.all([
    env.DIGEST_KV.put(pendingKey(lang, normEmail), JSON.stringify(pending), {
      expirationTtl: PENDING_TTL_SECONDS,
    }),
    env.DIGEST_KV.put(pendingByEmailKey(normEmail), lang, {
      expirationTtl: PENDING_TTL_SECONDS,
    }),
    env.DIGEST_KV.put(confirmTokenKey(token), JSON.stringify(tokenPayload), {
      expirationTtl: PENDING_TTL_SECONDS,
    }),
  ]);

  return { action: existingPendingLang ? 'refreshed-pending' : 'created-pending', pending };
}

export interface ConfirmResult {
  status: 'ok' | 'invalid-token' | 'missing-pending';
  subscriber?: SubscriberRecord;
}

export async function confirmSubscriber(env: Env, token: string): Promise<ConfirmResult> {
  const raw = await env.DIGEST_KV.get(confirmTokenKey(token));
  if (!raw) {
    return { status: 'invalid-token' };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(raw) as TokenPayload;
  } catch {
    return { status: 'invalid-token' };
  }
  if (payload.purpose !== 'confirm') {
    return { status: 'invalid-token' };
  }

  const { email, lang } = payload;

  // Idempotency: if the user clicks twice, the second click finds an existing
  // active record and still renders success.
  const existing = await getActiveSubscriber(env, email, lang);
  if (existing) {
    // Belt-and-suspenders: delete any leftover token/pending keys from the
    // first click so we don't leak orphans.
    await Promise.all([
      env.DIGEST_KV.delete(confirmTokenKey(token)),
      env.DIGEST_KV.delete(pendingKey(lang, email)),
      env.DIGEST_KV.delete(pendingByEmailKey(email)),
    ]);
    return { status: 'ok', subscriber: existing };
  }

  const pending = await getPendingSubscriber(env, email, lang);
  if (!pending) {
    return { status: 'missing-pending' };
  }

  const unsubToken = await deriveUnsubToken(env, email, lang);
  const now = Date.now();
  const subscriber: SubscriberRecord = {
    email,
    name: pending.name,
    lang,
    unsubToken,
    confirmedAt: now,
    createdAt: pending.createdAt,
  };

  await Promise.all([
    env.DIGEST_KV.put(activeKey(lang, email), JSON.stringify(subscriber)),
    env.DIGEST_KV.put(byEmailKey(email), lang),
    env.DIGEST_KV.delete(suppressKey(email)),
    env.DIGEST_KV.delete(pendingKey(lang, email)),
    env.DIGEST_KV.delete(pendingByEmailKey(email)),
    env.DIGEST_KV.delete(confirmTokenKey(token)),
  ]);

  return { status: 'ok', subscriber };
}

export async function listActiveSubscribers(
  env: Env,
  lang: SubscriberLang,
): Promise<SubscriberRecord[]> {
  const out: SubscriberRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.DIGEST_KV.list({ prefix: `sub:active:${lang}:`, cursor });
    const values = await Promise.all(page.keys.map(k => env.DIGEST_KV.get(k.name)));
    for (const raw of values) {
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw) as SubscriberRecord);
      } catch {
        // Corrupted record — skip.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export interface VerifiedUnsubTarget {
  email: string;
  lang: SubscriberLang;
  source: 'kv' | 'hardcoded';
}

/**
 * Verify an HMAC-derived unsubscribe token by re-deriving the expected token
 * for every (email, lang) candidate and matching. Candidates are the union of
 * active KV subscribers and the hardcoded lists in config.ts — so this works
 * uniformly for both populations.
 *
 * At the current scale (~20-100 recipients) this is a few HMAC computes, so
 * linear scan is fine. If the list grows past a few thousand, introduce a
 * `token:unsub:<token>` → email index on confirm and look up there first.
 */
export async function verifyUnsubToken(env: Env, token: string): Promise<VerifiedUnsubTarget | null> {
  if (!token || token.length < 10 || token.length > 64) return null;

  const [kvEn, kvPl] = await Promise.all([
    listActiveSubscribers(env, 'en'),
    listActiveSubscribers(env, 'pl'),
  ]);

  const candidates: Array<{ email: string; lang: SubscriberLang; source: 'kv' | 'hardcoded' }> = [
    ...kvEn.map(s => ({ email: s.email, lang: 'en' as SubscriberLang, source: 'kv' as const })),
    ...kvPl.map(s => ({ email: s.email, lang: 'pl' as SubscriberLang, source: 'kv' as const })),
    { email: normalizeEmail(EMAIL_TO.email), lang: 'en' as SubscriberLang, source: 'hardcoded' as const },
    ...EMAIL_TO_PL.map(r => ({
      email: normalizeEmail(r.email),
      lang: 'pl' as SubscriberLang,
      source: 'hardcoded' as const,
    })),
  ];

  // De-dup: same email may appear as both 'kv' and 'hardcoded' (Filip is in both).
  // Prefer the kv source so the active record drives the unsubscribe behaviour.
  const seen = new Set<string>();
  const unique: typeof candidates = [];
  for (const c of candidates) {
    const key = `${c.lang}|${c.email}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  for (const c of unique) {
    const expected = await deriveUnsubToken(env, c.email, c.lang);
    if (constantTimeEquals(expected, token)) {
      return c;
    }
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createUnsubConfirmToken(
  env: Env,
  email: string,
  lang: SubscriberLang,
): Promise<string> {
  const token = randomToken();
  const payload: TokenPayload = {
    email: normalizeEmail(email),
    lang,
    purpose: 'unsub-confirm',
  };
  await env.DIGEST_KV.put(unsubConfirmTokenKey(token), JSON.stringify(payload), {
    expirationTtl: PENDING_TTL_SECONDS,
  });
  return token;
}

export interface FinalizeUnsubResult {
  status: 'ok' | 'invalid-token';
  email?: string;
  lang?: SubscriberLang;
}

export async function finalizeUnsubscribe(env: Env, token: string): Promise<FinalizeUnsubResult> {
  const raw = await env.DIGEST_KV.get(unsubConfirmTokenKey(token));
  if (!raw) return { status: 'invalid-token' };
  let payload: TokenPayload;
  try {
    payload = JSON.parse(raw) as TokenPayload;
  } catch {
    return { status: 'invalid-token' };
  }
  if (payload.purpose !== 'unsub-confirm') return { status: 'invalid-token' };

  const { email, lang } = payload;

  await Promise.all([
    env.DIGEST_KV.delete(activeKey(lang, email)),
    env.DIGEST_KV.delete(byEmailKey(email)),
    env.DIGEST_KV.delete(unsubConfirmTokenKey(token)),
    env.DIGEST_KV.put(suppressKey(email), '1'),
  ]);

  return { status: 'ok', email, lang };
}

/** Mask the local part of an email for display on unsub-confirmation pages. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${'*'.repeat(Math.min(local.length - 2, 6))}${local[local.length - 1]}@${domain}`;
}
