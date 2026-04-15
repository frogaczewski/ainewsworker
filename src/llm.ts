import type { Env } from './types';

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const RETRIABLE_STATUS_CODES = new Set([403, 408, 429, 500, 502, 503, 504, 529]);

function parseApiError(status: number, body: string): { type: string; message: string; code?: number } {
  try {
    const json = JSON.parse(body);
    return {
      type: json?.error?.type ?? 'unknown',
      message: json?.error?.message ?? body,
      code: json?.error?.error_code,
    };
  } catch {
    return { type: 'unknown', message: body.slice(0, 500) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
  if (!env.CLAUDE_PLATFORM_API) {
    throw new Error('[LLM] CLAUDE_PLATFORM_API secret is not set — add it in the Cloudflare dashboard');
  }

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user' as const, content: prompt }],
  };

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.log(`[LLM] Retry ${attempt}/${MAX_RETRIES} for ${model} after ${delayMs}ms...`);
      await sleep(delayMs);
    }

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
      const parsed = parseApiError(response.status, errorText);
      const detail = parsed.code ? ` (code ${parsed.code})` : '';
      lastError = new Error(
        `Anthropic API error (${response.status}/${parsed.type}): ${parsed.message}${detail}`
      );
      console.error(`[LLM] ${model} attempt ${attempt}: ${lastError.message}`);

      if (RETRIABLE_STATUS_CODES.has(response.status)) {
        continue;
      }
      // Non-retriable (401, 404, etc.) — fail immediately
      throw lastError;
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

  throw lastError ?? new Error(`[LLM] ${model}: all ${MAX_RETRIES} retries exhausted`);
}

export async function callHaiku(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-haiku-4-5-20251001', prompt, 16000);
}

export async function callSonnet(env: Env, prompt: string): Promise<string> {
  return callClaude(env, 'claude-sonnet-4-6', prompt, 16000);
}
