import type { Env } from '../types';
import {
  streamWithRetry,
  type LLMProvider,
  type ParsedEvent,
  type Tier,
} from './base';

const MODELS: Record<Tier, string> = {
  // gpt-4.1-mini handles structured JSON classification fine and is ~6× cheaper
  // than Claude Haiku. Use gpt-4.1-nano if you want to push cost further.
  cheap: 'gpt-4.1-mini',
  // gpt-4.1 is the flagship text model — comparable Polish-prose quality to
  // Claude Sonnet 4.6 at ~2/3 the price.
  standard: 'gpt-4.1',
};

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: unknown;
}

function parseOpenAIEvent(data: string): ParsedEvent | null {
  let chunk: OpenAIStreamChunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return null;
  }
  if (chunk.error) {
    throw new Error(`Stream error: ${JSON.stringify(chunk.error)}`);
  }
  const event: ParsedEvent = {};
  const text = chunk.choices?.[0]?.delta?.content;
  if (text) event.text = text;
  if (chunk.usage?.prompt_tokens !== undefined) {
    event.inputTokens = chunk.usage.prompt_tokens;
  }
  if (chunk.usage?.completion_tokens !== undefined) {
    event.outputTokens = chunk.usage.completion_tokens;
  }
  return event.text !== undefined || event.inputTokens !== undefined || event.outputTokens !== undefined
    ? event
    : null;
}

export const openaiProvider: LLMProvider = {
  id: 'openai',
  modelFor: (tier) => MODELS[tier],
  call: async (env: Env, tier: Tier, prompt: string, maxTokens: number): Promise<string> => {
    if (!env.OPENAI_API_KEY) {
      throw new Error('[LLM] OPENAI_API_KEY secret is not set — add it via `wrangler secret put OPENAI_API_KEY`');
    }
    const model = MODELS[tier];
    return streamWithRetry(
      'OpenAI',
      model,
      async (signal) => fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          stream: true,
          // include_usage makes the final SSE chunk carry token counts.
          stream_options: { include_usage: true },
        }),
        signal,
      }),
      parseOpenAIEvent,
    );
  },
};
