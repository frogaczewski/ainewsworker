import type { SubscriberLang } from './types';
import { maskEmail } from './subscribers';

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    line-height: 1.6;
    color: #1A1A1A;
    background: #F9F9F9;
    display: flex;
    min-height: 100vh;
    align-items: center;
    justify-content: center;
    padding: 20px;
  }
  .card {
    background: #FFFFFF;
    border-top: 4px solid #CC0000;
    max-width: 520px;
    width: 100%;
    padding: 40px 36px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.06);
  }
  .brand { font-family: Georgia, 'Times New Roman', serif; font-size: 13px; text-transform: uppercase; letter-spacing: 2px; color: #CC0000; margin-bottom: 12px; }
  h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 26px; font-weight: 700; margin-bottom: 16px; color: #1A1A1A; }
  p { font-size: 15px; color: #333333; margin-bottom: 14px; }
  p.small { font-size: 13px; color: #666666; }
  .email { font-weight: 600; color: #1A1A1A; }
  .lang-pill { display: inline-block; padding: 2px 10px; background: #F2F2F2; border-radius: 12px; font-size: 12px; font-weight: 600; color: #666666; margin-left: 6px; }
  button, .btn {
    display: inline-block;
    background: #CC0000;
    color: #FFFFFF;
    border: none;
    padding: 12px 24px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    margin-top: 8px;
  }
  button:hover, .btn:hover { background: #990000; }
  .btn-secondary { background: transparent; color: #666666; border: 1px solid #D5D5D5; margin-left: 8px; }
  .btn-secondary:hover { background: #F2F2F2; color: #1A1A1A; }
  a { color: #CC0000; }
  .home-link { display: inline-block; margin-top: 24px; font-size: 14px; }
`;

function renderShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — AI News Digest</title>
  <meta name="robots" content="noindex">
  <style>${PAGE_CSS}</style>
</head>
<body>
  <div class="card">
    <div class="brand">AI News Digest</div>
    ${body}
    <a class="home-link" href="/">&larr; Back to today's digest</a>
  </div>
</body>
</html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function checkInboxPage(email: string): Response {
  const body = `
    <h1>Check your inbox</h1>
    <p>If <span class="email">${escapeHtml(email)}</span> is a valid address, we've just sent a confirmation link to it.</p>
    <p class="small">Click the link in the email to activate your subscription. The link expires in 24 hours.</p>
    <p class="small">Didn't get it? Check your spam folder, then try subscribing again in a few minutes.</p>
  `;
  return htmlResponse(renderShell('Check your inbox', body));
}

export function confirmSuccessPage(email: string, lang: SubscriberLang): Response {
  const body = `
    <h1>You're subscribed!</h1>
    <p>We'll send the daily digest to <span class="email">${escapeHtml(email)}</span> <span class="lang-pill">${lang.toUpperCase()}</span>.</p>
    <p>The first edition arrives tomorrow morning. Every email has an unsubscribe link — no hard feelings if you want out.</p>
  `;
  return htmlResponse(renderShell("You're subscribed", body));
}

export function confirmInvalidPage(): Response {
  const body = `
    <h1>Link expired or invalid</h1>
    <p>This confirmation link is no longer valid. Subscriptions must be confirmed within 24 hours.</p>
    <p>You can subscribe again from the <a href="/">home page</a>.</p>
  `;
  return htmlResponse(renderShell('Link expired', body), 400);
}

export function unsubscribeConfirmPage(token: string, email: string): Response {
  const masked = maskEmail(email);
  const body = `
    <h1>Unsubscribe?</h1>
    <p>You're about to stop receiving the digest at <span class="email">${escapeHtml(masked)}</span>.</p>
    <p class="small">We'll send one more email to that address with a final confirmation link. The unsubscribe takes effect only after you click that link.</p>
    <form method="post" action="/api/unsubscribe">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit">Send confirmation email</button>
      <a class="btn btn-secondary" href="/">Cancel</a>
    </form>
  `;
  return htmlResponse(renderShell('Unsubscribe', body));
}

export function unsubscribeSentPage(): Response {
  const body = `
    <h1>Check your inbox one more time</h1>
    <p>We've sent a final confirmation email. Click the link inside to complete the unsubscribe.</p>
    <p class="small">If you change your mind, just ignore the email — you'll stay subscribed.</p>
  `;
  return htmlResponse(renderShell('Almost done', body));
}

export function finalizeSuccessPage(email: string): Response {
  const body = `
    <h1>You're unsubscribed</h1>
    <p><span class="email">${escapeHtml(email)}</span> will stop receiving the digest starting tomorrow.</p>
    <p class="small">Changed your mind? You can re-subscribe any time from the <a href="/">home page</a>.</p>
  `;
  return htmlResponse(renderShell("You're unsubscribed", body));
}

export function unsubscribeInvalidPage(): Response {
  const body = `
    <h1>Link expired or invalid</h1>
    <p>This unsubscribe link is no longer valid. You may have already unsubscribed, or the link may have been mistyped.</p>
    <p>If you're still receiving the digest, please reply to any digest email and we'll remove you manually.</p>
  `;
  return htmlResponse(renderShell('Link expired', body), 400);
}

export function rateLimitedPage(): Response {
  const body = `
    <h1>Too many requests</h1>
    <p>You've submitted the subscribe form several times in a short window. Please wait a few minutes and try again.</p>
  `;
  return htmlResponse(renderShell('Too many requests', body), 429);
}

export function genericErrorPage(message: string): Response {
  const body = `
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
    <p class="small">If this keeps happening, please email the administrator.</p>
  `;
  return htmlResponse(renderShell('Error', body), 500);
}

export function invalidRequestPage(message: string): Response {
  const body = `
    <h1>Invalid request</h1>
    <p>${escapeHtml(message)}</p>
  `;
  return htmlResponse(renderShell('Invalid request', body), 400);
}
