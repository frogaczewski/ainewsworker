import type { Env } from '../types';
import {
  streamWithRetry,
  type LLMProvider,
  type ParsedEvent,
  type Tier,
} from './base';

const MODELS: Record<Tier, string> = {
  cheap: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-4-6',
};

interface AnthropicStreamEvent {
  type?: string;
  delta?: {
    text?: string;
    type?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: unknown;
}

// Text-mode parser: accumulates content_block_delta `text` chunks. Used by
// the regular `call` path.
function parseAnthropicTextEvent(data: string): ParsedEvent | null {
  let event: AnthropicStreamEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (event.type === 'content_block_delta' && event.delta?.text) {
    return { text: event.delta.text };
  }
  if (event.type === 'message_start' && event.message?.usage) {
    return { inputTokens: event.message.usage.input_tokens ?? 0 };
  }
  if (event.type === 'message_delta' && event.usage) {
    return { outputTokens: event.usage.output_tokens };
  }
  if (event.type === 'error') {
    throw new Error(`Stream error: ${JSON.stringify(event.error)}`);
  }
  return null;
}

// Tool-use parser: accumulates `input_json_delta.partial_json` chunks into
// the tool's input JSON. Used by `callJson`. Anthropic guarantees the
// concatenated stream is valid JSON matching the schema.
function parseAnthropicToolUseEvent(data: string): ParsedEvent | null {
  let event: AnthropicStreamEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    event.type === 'content_block_delta' &&
    event.delta?.type === 'input_json_delta' &&
    typeof event.delta.partial_json === 'string'
  ) {
    return { text: event.delta.partial_json };
  }
  if (event.type === 'message_start' && event.message?.usage) {
    return { inputTokens: event.message.usage.input_tokens ?? 0 };
  }
  if (event.type === 'message_delta' && event.usage) {
    return { outputTokens: event.usage.output_tokens };
  }
  if (event.type === 'error') {
    throw new Error(`Stream error: ${JSON.stringify(event.error)}`);
  }
  return null;
}

const STRUCTURED_TOOL_NAME = 'emit_structured_output';

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
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          messages: [{ role: 'user', content: prompt }],
          tools: [{
            name: STRUCTURED_TOOL_NAME,
            description: 'Emit the structured digest output. The model MUST invoke this tool — its `input` is parsed and used directly downstream.',
            input_schema: schema,
          }],
          tool_choice: { type: 'tool', name: STRUCTURED_TOOL_NAME },
        }),
        signal,
      }),
      parseAnthropicToolUseEvent,
    );
    try {
      return JSON.parse(accumulated) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[LLM] Anthropic tool_use returned unparsable JSON (${msg}). First 200 chars: ${accumulated.slice(0, 200)}`);
    }
  },
};
