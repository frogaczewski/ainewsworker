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

function parseAnthropicEvent(data: string): ParsedEvent | null {
  let event: { type?: string; delta?: { text?: string }; message?: { usage?: { input_tokens?: number } }; usage?: { output_tokens?: number }; error?: unknown };
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
      parseAnthropicEvent,
    );
  },
};
