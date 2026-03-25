import type { Env } from './types';

// Use streaming to avoid Cloudflare's fetch() timeout on long-running API calls.
// Without streaming, Cloudflare waits for the full response body — if Anthropic
// takes >100s to generate, the fetch() gets a 524 timeout.
// With streaming, each chunk resets the timeout window.
export async function callClaude(
  env: Env,
  model: string,
  prompt: string,
  maxTokens: number = 8192,
): Promise<string> {
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
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

  // Parse SSE stream
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body from Anthropic API');
  }

  const decoder = new TextDecoder();
  let text = '';
  let buffer = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE lines
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data);

        if (event.type === 'content_block_delta' && event.delta?.text) {
          text += event.delta.text;
        } else if (event.type === 'message_delta' && event.usage) {
          outputTokens = event.usage.output_tokens ?? outputTokens;
        } else if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? 0;
        } else if (event.type === 'error') {
          throw new Error(`Stream error: ${JSON.stringify(event.error)}`);
        }
      } catch (e) {
        if (e instanceof SyntaxError) continue; // Skip malformed JSON
        throw e;
      }
    }
  }

  if (inputTokens || outputTokens) {
    console.log(`[LLM] ${model}: ${inputTokens} input tokens, ${outputTokens} output tokens`);
  }

  if (!text) {
    throw new Error('Empty response from Claude');
  }

  return text;
}

export async function callHaiku(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-haiku-4-5-20251001', prompt, 16000);
}

export async function callSonnet(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-sonnet-4-6', prompt, 16000);
}
