import type { Env } from '../types';
import {
  streamWithRetry,
  type LLMProvider,
  type ParsedEvent,
  type Tier,
} from './base';

const MODELS: Record<Tier, string> = {
  cheap: 'claude-haiku-5-5',
  standard: 'claude-sonnet-5-5',
};

// Both models run adaptive thinking by default. Thinking tokens count toward
// max_tokens, so callers size their budgets with headroom for it. Thinking
// text is omitted from the stream (empty `thinking_delta`s), so only the
// answer's `text_delta`s are accumulated below.
const EFFORT = 'high';

interface AnthropicStreamEvent {
  type?: string;
  delta?: {
    text?: string;
    type?: string;
    stop_reason?: string;
  };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: unknown;
}

// Accumulates the answer's `text_delta` chunks. Used by both `call` and
// `callJson` — with structured outputs the JSON arrives as ordinary text.
function parseAnthropicTextEvent(data: string): ParsedEvent | null {
  let event: AnthropicStreamEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
    return { text: event.delta.text };
  }
  if (event.type === 'message_start' && event.message?.usage) {
    return { inputTokens: event.message.usage.input_tokens ?? 0 };
  }
  // A safety-classifier decline arrives as a normal stream ending in
  // stop_reason=refusal; any text before it is partial, so don't return it.
  if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') {
    throw new Error('Model declined the request (stop_reason=refusal)');
  }
  if (event.type === 'message_delta' && event.usage) {
    return { outputTokens: event.usage.output_tokens };
  }
  if (event.type === 'error') {
    throw new Error(`Stream error: ${JSON.stringify(event.error)}`);
  }
  return null;
}

export interface StructuredMessageOptions {
  model: string;
  prompt: string;
  schema: object;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs?: number;
}

// One non-streaming Messages call constrained by structured outputs
// (`output_config.format`), so the text block is guaranteed to be JSON that
// matches `schema` — unless the model stopped early, which we surface as an
// error rather than handing back a truncated object. Used for the editorial
// clustering call, which is small enough to run inline in Stage B.
export async function createStructuredMessage<T>(env: Env, opts: StructuredMessageOptions): Promise<T> {
  if (!env.CLAUDE_PLATFORM_API) {
    throw new Error('[LLM] CLAUDE_PLATFORM_API secret is not set — add it in the Cloudflare dashboard');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.CLAUDE_PLATFORM_API,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: 'user', content: opts.prompt }],
      output_config: {
        ...(opts.effort && { effort: opts.effort }),
        format: { type: 'json_schema', schema: opts.schema },
      },
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 300_000),
  });
  if (!res.ok) {
    throw new Error(`[LLM] ${opts.model} HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const message = (await res.json()) as {
    stop_reason: string | null;
    content: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  console.log(
    `[LLM] ${opts.model} structured: stop=${message.stop_reason} ` +
      `in=${message.usage?.input_tokens ?? '?'} out=${message.usage?.output_tokens ?? '?'}`,
  );
  if (message.stop_reason !== 'end_turn') {
    throw new Error(`[LLM] ${opts.model} stopped with ${message.stop_reason} — output not usable`);
  }
  const text = message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
  return JSON.parse(text) as T;
}

export const anthropicProvider: LLMProvider = {
  id: 'anthropic',
  modelFor: (tier) => MODELS[tier],
  call: async (env: Env, tier: Tier, prompt: string, maxTokens: number): Promise<string> => {
    if (!env.CLAUDE_PLATFORM_API) {
      throw new Error('[LLM] CLAUDE_PLATFORM_API secret is not set — add it in the Cloudflare dashboard');
    }
    const model = MODELS[tier];
    return streamWithRetry(
      'Anthropic',
      model,
      async (signal) => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.CLAUDE_PLATFORM_API,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          output_config: { effort: EFFORT },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      }),
      parseAnthropicTextEvent,
    );
  },
  callJson: async <T>(
    env: Env,
    tier: Tier,
    prompt: string,
    schema: object,
    maxTokens: number,
  ): Promise<T> => {
    if (!env.CLAUDE_PLATFORM_API) {
      throw new Error('[LLM] CLAUDE_PLATFORM_API secret is not set — add it in the Cloudflare dashboard');
    }
    const model = MODELS[tier];
    const accumulated = await streamWithRetry(
      'Anthropic',
      model,
      async (signal) => fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.CLAUDE_PLATFORM_API,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        // Structured outputs: decoding is constrained to `schema`, so the
        // answer text is guaranteed-valid JSON. (Forced tool_choice, used
        // before, returns a 400 on Sonnet 5.5.)
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          output_config: {
            effort: EFFORT,
            format: { type: 'json_schema', schema },
          },
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      }),
      parseAnthropicTextEvent,
    );
    try {
      return JSON.parse(accumulated) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LLM] Anthropic structured output was unparsable JSON (${msg}). First 200 chars: ${accumulated.slice(0, 200)}`);
    }
  },
};
