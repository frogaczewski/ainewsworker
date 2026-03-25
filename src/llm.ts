import type { Env } from './types';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export async function callClaude(
  env: Env,
  model: string,
  prompt: string,
  maxTokens: number = 8192,
): Promise<string> {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user' as const, content: prompt }],
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.CLAUDE_PLATFORM_API,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = await response.json() as AnthropicResponse;
  const text = data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  if (!text) {
    throw new Error('Empty response from Claude');
  }

  return text;
}

export async function callHaiku(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-haiku-4-5-20251001', prompt, 16000);
}

export async function callSonnet(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-sonnet-4-6', prompt, 8000);
}
