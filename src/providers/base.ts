import type { Env } from '../types';

// A tier maps to the "kind" of LLM call each pipeline stage needs:
// - 'cheap' for classification and dedup (many batched calls over small payloads)
// - 'standard' for compile / email briefing / translate (few calls over large payloads)
// Each LLMProvider chooses concrete model IDs for each tier (Haiku vs Sonnet,
// Flash vs Pro, etc.).
export type Tier = 'cheap' | 'standard';

export type ProviderId = 'anthropic' | 'gemini' | 'openai';

export interface LLMProvider {
  readonly id: ProviderId;
  modelFor(tier: Tier): string;
  call(env: Env, tier: Tier, prompt: string, maxTokens: number): Promise<string>;
  // Optional: native structured output via tool-use / function-calling. The
  // model is constrained to emit JSON matching `schema`; the caller gets back
  // the already-parsed object instead of a string. Providers without native
  // support omit this and the caller falls back to text + parse.
  callJson?<T>(
    env: Env,
    tier: Tier,
    prompt: string,
    schema: object,
    maxTokens: number,
  ): Promise<T>;
}

// A recipe naming which provider to use at each stage. Same-provider-end-to-end
// configs (like 'claude' and 'gemini') are the starting case; future mixes
// (e.g. 'gemini-classify-claude-compose') slot into the same shape.
export interface VariantConfig {
  id: string;
  label: string;       // used in email footer attribution
  classify: ProviderId;
  compose: ProviderId;
}

export interface ParsedEvent {
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
}

const MAX_RETRIES = 1;
const RETRY_BASE_MS = 2000;
const RETRIABLE_STATUS_CODES = new Set([403, 408, 429, 500, 502, 503, 504, 529]);

// Cloudflare's scheduled event / queue consumer has a 15-minute wall-time
// ceiling. Without these guard rails a stalled fetch or silently hung stream
// can burn the entire budget and the digest never ships (see exceededCpu /
// wallTimeMs=899985 incidents on 2026-04-17 and 2026-04-26). The chunk-idle
// timeout catches truly stuck streams quickly; the attempt timeout caps the
// "slow-but-progressing" Sonnet structured-compile call (EN+PL output for
// ~75 stories streams ~5–7 minutes at typical 60–80 tps).
//
// 600s × (1 + MAX_RETRIES=1) = 1200s worst case in-process — still inside the
// 15-min queue wall, with backoff. If both attempts time out the queue retries
// the whole message on a fresh worker.
const ATTEMPT_TIMEOUT_MS = 600_000;
const CHUNK_IDLE_TIMEOUT_MS = 45_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseApiError(body: string): { type: string; message: string; code?: number | string } {
  try {
    const json = JSON.parse(body);
    return {
      type: json?.error?.type ?? json?.error?.status ?? 'unknown',
      message: json?.error?.message ?? body,
      code: json?.error?.code ?? json?.error?.error_code,
    };
  } catch {
    return { type: 'unknown', message: body.slice(0, 500) };
  }
}

function readChunkWithTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
  onTimeout: () => void,
): Promise<ReadableStreamReadResult<T>> {
  return new Promise<ReadableStreamReadResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Stream idle for ${idleMs}ms`));
    }, idleMs);
    reader.read().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Shared fetch+SSE+retry loop for every provider adapter. Each adapter passes
// its own buildRequest (handles endpoint, headers, body shape) and parseEvent
// (extracts text/tokens from one SSE data line; returns null to skip malformed
// or irrelevant events; throws to signal a non-retriable stream-level error).
export async function streamWithRetry(
  providerName: string,
  model: string,
  buildRequest: (signal: AbortSignal) => Promise<Response>,
  parseEvent: (data: string) => ParsedEvent | null,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.log(`[LLM] Retry ${attempt}/${MAX_RETRIES} for ${model} after ${delayMs}ms...`);
      await sleep(delayMs);
    }

    const controller = new AbortController();
    const attemptTimer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
    // Sentinel so the catch block knows this is an API-side failure it has
    // already classified (retriable vs not), not a network/stream fault.
    let apiError: Error | null = null;

    try {
      const response = await buildRequest(controller.signal);

      if (!response.ok) {
        const errorText = await response.text();
        const parsed = parseApiError(errorText);
        const detail = parsed.code ? ` (code ${parsed.code})` : '';
        apiError = new Error(
          `${providerName} API error (${response.status}/${parsed.type}): ${parsed.message}${detail}`,
        );
        lastError = apiError;
        console.error(`[LLM] ${model} attempt ${attempt}: ${apiError.message}`);

        if (RETRIABLE_STATUS_CODES.has(response.status)) {
          continue;
        }
        throw apiError;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`No response body from ${providerName} API`);
      }

      const decoder = new TextDecoder();
      let text = '';
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { done, value } = await readChunkWithTimeout(
          reader,
          CHUNK_IDLE_TIMEOUT_MS,
          () => controller.abort(),
        );
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          const event = parseEvent(data);
          if (!event) continue;
          if (event.text) text += event.text;
          if (event.inputTokens !== undefined) inputTokens = event.inputTokens;
          if (event.outputTokens !== undefined) outputTokens = event.outputTokens;
        }
      }

      if (inputTokens || outputTokens) {
        console.log(`[LLM] ${model}: ${inputTokens} input tokens, ${outputTokens} output tokens`);
      }

      if (!text) {
        throw new Error(`Empty response from ${providerName} (${model})`);
      }

      return text;
    } catch (err) {
      if (apiError && err === apiError) {
        throw err;
      }
      const wrapped = err instanceof Error ? err : new Error(String(err));
      lastError = wrapped;
      console.error(`[LLM] ${model} attempt ${attempt} failed: ${wrapped.message}`);
      if (attempt < MAX_RETRIES) {
        continue;
      }
      throw wrapped;
    } finally {
      clearTimeout(attemptTimer);
    }
  }

  throw lastError ?? new Error(`[LLM] ${model}: all ${MAX_RETRIES} retries exhausted`);
}
