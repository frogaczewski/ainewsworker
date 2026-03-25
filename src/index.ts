import type { Env } from './types';
import { EMAIL_FROM, EMAIL_TO } from './config';

async function sendTestEmail(env: Env): Promise<string> {
  console.log('[Test] Starting email test...');
  console.log(`[Test] From: ${EMAIL_FROM.email} (${EMAIL_FROM.name})`);
  console.log(`[Test] To: ${EMAIL_TO.email} (${EMAIL_TO.name})`);
  console.log(`[Test] MAILJET_API_KEY present: ${!!env.MAILJET_API_KEY}, length: ${env.MAILJET_API_KEY?.length}`);
  console.log(`[Test] MAILJET_SECRET_KEY present: ${!!env.MAILJET_SECRET_KEY}, length: ${env.MAILJET_SECRET_KEY?.length}`);

  const credentials = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);
  console.log(`[Test] Auth header (first 20 chars): Basic ${credentials.substring(0, 20)}...`);

  const payload = {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: EMAIL_TO.email, Name: EMAIL_TO.name }],
      Subject: `[TEST] Email Test — ${new Date().toISOString()}`,
      TextPart: 'This is a test email from the AI News Digest Cloudflare Worker.\n\nIf you received this, email delivery is working correctly.',
      HTMLPart: '<h1>Test Email</h1><p>This is a test email from the <strong>AI News Digest</strong> Cloudflare Worker.</p><p>If you received this, email delivery is working correctly.</p>',
    }],
  };

  console.log(`[Test] Sending payload: ${JSON.stringify(payload, null, 2)}`);

  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  console.log(`[Test] Mailjet HTTP status: ${response.status}`);
  console.log(`[Test] Mailjet response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
  console.log(`[Test] Mailjet response body: ${responseText}`);

  if (!response.ok) {
    throw new Error(`Mailjet error (${response.status}): ${responseText}`);
  }

  return responseText;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sendTestEmail(env));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        const result = await sendTestEmail(env);
        return new Response(JSON.stringify({ status: 'success', mailjet: JSON.parse(result) }), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Test] Error: ${msg}`);
        return new Response(JSON.stringify({ status: 'error', error: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('Email test worker. POST /run to send a test email.', { status: 200 });
  },
};
