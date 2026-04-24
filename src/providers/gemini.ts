import type { Env } from '../types';
import {
  streamWithRetry,
  type LLMProvider,
  type ParsedEvent,
  type Tier,
} from './base';

const MODELS: Record<Tier, string> = {
  cheap: 'gemini-2.5-flash',
  standard: 'gemini-2.5-pro',
};

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  };
  error?: unknown;
}

function parseGeminiEvent(data: string): ParsedEvent | null {
  let chunk: GeminiStreamChunk;
  try {
    chunk = JSON.parse(data);
  } catch {
    return null;
  }
  if (chunk.error) {
    throw new Error(`Stream error: ${JSON.stringify(chunk.error)}`);
  }
  const event: ParsedEvent = {};
  const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
  if (text) event.text = text;
  if (chunk.usageMetadata?.promptTokenCount !== undefined) {
    event.inputTokens = chunk.usageMetadata.promptTokenCount;
  }
  if (chunk.usageMetadata?.candidatesTokenCount !== undefined) {
    event.outputTokens = chunk.usageMetadata.candidatesTokenCount;
  }
  return event.text || event.inputTokens !== undefined || event.outputTokens !== undefined ? event : null;
}

export const geminiProvider: LLMProvider = {
  id: 'gemini',
  modelFor: (tier) => MODELS[tier],
  call: async (env: Env, tier: Tier, prompt: string, maxTokens: number): Promise<string> => {
    if (!env.GEMINI_API_KEY) {
      throw new Error('[LLM] GEMINI_API_KEY secret is not set — add it via `wrangler secret put GEMINI_API_KEY`');
    }
    const model = MODELS[tier];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`;
    return streamWithRetry(
      'Gemini',
      model,
      async (signal) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
        signal,
      }),
      parseGeminiEvent,
    );
  },
};
