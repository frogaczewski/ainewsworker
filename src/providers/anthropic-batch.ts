// Anthropic Message Batches API client.
//
// Why this exists: the synchronous streaming Sonnet compile call routinely
// burned the 15-min queue wall-time budget when Anthropic's stream stalled
// (see exceededCpu / wallTimeMs=899996 incidents on 2026-04-26 and -27). The
// batches API is async (24-hour SLA, typically minutes), 50% cheaper, and
// returns a fully-validated tool_use input — no streaming, no empty-response
// retry loops eating wall time.
//
// Endpoints implemented (v1):
//   POST /v1/messages/batches         — submit
//   GET  /v1/messages/batches/{id}    — status + counts + results_url
//   GET  /v1/messages/batches/{id}/results — JSONL of per-request outcomes
//
// One thing worth knowing: while a batch is `in_progress`, request_counts
// reports `processing` only — succeeded/errored/canceled/expired are all 0
// until processing_status flips to `ended`. So the threshold logic in
// pipeline-batched.ts gates on `ended` before reading per-request outcomes.

import type { Env } from '../types';

const ANTHROPIC_VERSION = '2023-06-01';
const BATCHES_URL = 'https://api.anthropic.com/v1/messages/batches';

// 30s cap per HTTP call. Each batches call is a small JSON request — anything
// slower is a network or upstream issue and we want it to surface to the
// caller, not silently chew worker wall-time.
const HTTP_TIMEOUT_MS = 30_000;

export interface BatchRequest {
  custom_id: string;
  // Mirrors the Messages API request body shape (model, messages, max_tokens,
  // tools, tool_choice, …). Typed as `unknown` so callers can use whatever
  // they'd pass to /v1/messages without a parallel type tree.
  params: Record<string, unknown>;
}

export type BatchProcessingStatus = 'in_progress' | 'canceling' | 'ended';

export interface BatchRequestCounts {
  processing: number;
  succeeded: number;
  errored: number;
  canceled: number;
  expired: number;
}

export interface BatchStatus {
  id: string;
  processing_status: BatchProcessingStatus;
  request_counts: BatchRequestCounts;
  results_url: string | null;
  created_at: string;
  ended_at: string | null;
  expires_at: string;
}

export type BatchResultType = 'succeeded' | 'errored' | 'canceled' | 'expired';

// One line of the results JSONL. The shape is permissive on `result` — only
// `type` is guaranteed; the helpers below handle each type.
export interface BatchResultRecord {
  custom_id: string;
  result: {
    type: BatchResultType;
    message?: AnthropicMessage;
    error?: { error?: { type?: string; message?: string }; type?: string };
  };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  // tool_use blocks
  id?: string;
  name?: string;
  input?: unknown;
}

export interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function authHeaders(env: Env): Record<string, string> {
  if (!env.CLAUDE_PLATFORM_API) {
    throw new Error('[Batch] CLAUDE_PLATFORM_API secret is not set');
  }
  return {
    'x-api-key': env.CLAUDE_PLATFORM_API,
    'anthropic-version': ANTHROPIC_VERSION,
    'content-type': 'application/json',
  };
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? HTTP_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// POST /v1/messages/batches — submit N requests, get back a batch id.
// Throws on any non-2xx response with the Anthropic-formatted error body.
export async function submitBatch(env: Env, requests: BatchRequest[]): Promise<{ id: string }> {
  if (requests.length === 0) {
    throw new Error('[Batch] submitBatch called with empty requests array');
  }
  const res = await fetchWithTimeout(BATCHES_URL, {
    method: 'POST',
    headers: authHeaders(env),
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[Batch] submit failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { id?: string };
  if (!json.id) {
    throw new Error(`[Batch] submit response missing id: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { id: json.id };
}

// GET /v1/messages/batches/{id} — status + counts. Caller decides whether to
// keep polling, advance, or abort based on processing_status + request_counts.
export async function getBatchStatus(env: Env, batchId: string): Promise<BatchStatus> {
  const res = await fetchWithTimeout(`${BATCHES_URL}/${encodeURIComponent(batchId)}`, {
    method: 'GET',
    headers: authHeaders(env),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[Batch] getStatus failed (${res.status}): ${body.slice(0, 500)}`);
  }
  return (await res.json()) as BatchStatus;
}

// GET on the results_url (or /v1/messages/batches/{id}/results). Returns one
// record per custom_id, keyed by custom_id for O(1) lookup. Result line ordering
// is not guaranteed by Anthropic — always match by custom_id.
export async function getBatchResults(env: Env, batchId: string): Promise<Map<string, BatchResultRecord>> {
  const url = `${BATCHES_URL}/${encodeURIComponent(batchId)}/results`;
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: authHeaders(env),
    // Results files can be large; the /results endpoint streams JSONL. Give
    // it a longer cap than status calls.
    timeoutMs: 120_000,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[Batch] getResults failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const text = await res.text();
  const out = new Map<string, BatchResultRecord>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let record: BatchResultRecord;
    try {
      record = JSON.parse(line) as BatchResultRecord;
    } catch (err) {
      console.error(`[Batch] Skipping malformed result line: ${line.slice(0, 200)} (${err})`);
      continue;
    }
    if (!record.custom_id || !record.result?.type) continue;
    out.set(record.custom_id, record);
  }
  return out;
}

// Pull the assistant's text content out of a succeeded result. Concatenates
// every text block — Haiku classification responses are pure-text and stream
// as one or more text content blocks.
export function extractText(record: BatchResultRecord): string {
  if (record.result.type !== 'succeeded' || !record.result.message) {
    throw new Error(`[Batch] extractText called on non-succeeded result (${record.custom_id}): ${record.result.type}`);
  }
  const parts: string[] = [];
  for (const block of record.result.message.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

// Pull the tool_use input JSON out of a succeeded result. Used for the Sonnet
// structured-compile call where the model is forced to invoke the
// emit_structured_output tool. The API has already validated `input` against
// the schema — no JSON.parse needed, no salvage logic.
export function extractToolUseInput<T = unknown>(record: BatchResultRecord, toolName: string): T {
  if (record.result.type !== 'succeeded' || !record.result.message) {
    throw new Error(`[Batch] extractToolUseInput called on non-succeeded result (${record.custom_id}): ${record.result.type}`);
  }
  for (const block of record.result.message.content) {
    if (block.type === 'tool_use' && block.name === toolName && block.input !== undefined) {
      return block.input as T;
    }
  }
  throw new Error(`[Batch] No tool_use block named "${toolName}" in result for ${record.custom_id}`);
}
