import { EMAIL_FROM, EMAIL_TO } from './config';
import type { Env, FeedStatus } from './types';

const DEFAULT_PUBLIC_ORIGIN = 'https://ainewsworker.rogaczewski-dev.workers.dev';

export function resolvePublicOrigin(env: Env): string {
  const raw = env.PUBLIC_ORIGIN?.trim();
  if (!raw) return DEFAULT_PUBLIC_ORIGIN;
  return raw.replace(/\/+$/, '');
}

export interface MailjetInlinedAttachment {
  ContentType: string;
  Filename: string;
  ContentID: string;
  Base64Content: string;
}

export interface MailjetPayload {
  Messages: Array<{
    From: { Email: string; Name: string };
    To: Array<{ Email: string; Name: string }>;
    Subject: string;
    HTMLPart?: string;
    TextPart?: string;
    InlinedAttachments?: MailjetInlinedAttachment[];
  }>;
}

/**
 * Shared Mailjet POST. Respects env.DRY_EMAIL === 'true' by logging the payload
 * instead of sending — used by `wrangler dev` so local testing doesn't hit the
 * real API. Callers should treat a dry-mode call as a successful send.
 */
export async function postMailjet(env: Env, payload: MailjetPayload): Promise<void> {
  if (env.DRY_EMAIL === 'true') {
    const subj = payload.Messages[0]?.Subject;
    const to = payload.Messages[0]?.To?.[0]?.Email;
    console.log(`[Email][DRY] would send "${subj}" to ${to}`);
    console.log(`[Email][DRY] payload: ${JSON.stringify(payload).slice(0, 2000)}`);
    return;
  }

  const credentials = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);
  const response = await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  console.log(`[Email] Mailjet HTTP ${response.status} response: ${responseText}`);

  if (!response.ok) {
    throw new Error(`Mailjet error (${response.status}): ${responseText}`);
  }

  let responseData: {
    Messages?: Array<{
      Status?: string;
      To?: Array<{ Email?: string; MessageID?: number; MessageUUID?: string }>;
      Errors?: Array<{ ErrorMessage?: string; ErrorCode?: string }>;
    }>;
  };
  try {
    responseData = JSON.parse(responseText);
  } catch {
    throw new Error(`Mailjet returned non-JSON: ${responseText}`);
  }

  const msg = responseData.Messages?.[0];
  console.log(`[Email] Mailjet status: ${msg?.Status}, MessageID: ${msg?.To?.[0]?.MessageID}, MessageUUID: ${msg?.To?.[0]?.MessageUUID}`);

  if (msg?.Errors && msg.Errors.length > 0) {
    console.error(`[Email] Mailjet errors: ${JSON.stringify(msg.Errors)}`);
  }

  if (msg?.Status === 'error') {
    throw new Error(`Mailjet delivery error: ${JSON.stringify(msg.Errors)}`);
  }
}

export function markdownToHtml(md: string): string {
  // Handle blockquotes before HTML escaping
  md = md.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  // Merge consecutive blockquotes
  md = md.replace(/<\/blockquote>\n<blockquote>/g, '\n');

  let html = md
    // Escape HTML entities (but preserve markdown syntax and blockquotes)
    .replace(/&/g, '&amp;')
    .replace(/<(?!\/?blockquote>)/g, '&lt;')
    .replace(/(?<!blockquote)>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Horizontal rules
    .replace(/^---$/gm, '<hr>')
    // Unordered list items
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" style="color:#9B4D3A">$1</a>');

  // Wrap consecutive <li> in <ul>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Simple table conversion
  html = html.replace(/^\|(.+)\|$/gm, (match) => {
    const cells = match.split('|').filter(c => c.trim());
    return '<tr>' + cells.map(c => `<td>${c.trim()}</td>`).join('') + '</tr>';
  });
  // Remove separator rows
  html = html.replace(/<tr><td>[-:]+<\/td>(?:<td>[-:]+<\/td>)*<\/tr>\n?/g, '');
  // Wrap consecutive <tr> in <table>
  html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');
  // Make first row of each table use <th>
  html = html.replace(/<table><tr>(.*?)<\/tr>/g, (_match, row: string) => {
    const headerRow = row.replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>');
    return `<table><thead><tr>${headerRow}</tr></thead><tbody>`;
  });
  html = html.replace(/<\/table>/g, '</tbody></table>');

  // Paragraphs: wrap remaining bare lines
  html = html.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('<')) return trimmed;
    return `<p>${trimmed}</p>`;
  }).join('\n');

  return html;
}

function buildFeedStatusFooter(feedStatuses?: FeedStatus[]): string {
  if (!feedStatuses || feedStatuses.length === 0) return '';

  const ok = feedStatuses.filter(f => f.ok);
  const failed = feedStatuses.filter(f => !f.ok);

  let html = `<details style="margin-top:32px;padding:16px;background:#F0EBE3;border-radius:6px;font-size:13px;color:#5C4A3A">
<summary style="cursor:pointer;font-weight:600;color:#3D3029">Source Status: ${ok.length} active, ${failed.length} failed</summary>
<div style="margin-top:12px">`;

  if (failed.length > 0) {
    html += `<p style="margin:8px 0;font-weight:600;color:#9B4D3A">Failed sources:</p><ul style="padding-left:18px;margin:4px 0">`;
    for (const f of failed) {
      const reason = f.error?.replace(/^[^:]+:\s*/, '') || 'unknown error';
      html += `<li>${f.name} — ${reason}</li>`;
    }
    html += `</ul>`;
  }

  html += `<p style="margin:8px 0;font-weight:600;color:#5C4A3A">Active sources (${ok.length}):</p><ul style="padding-left:18px;margin:4px 0">`;
  for (const f of ok) {
    html += `<li>${f.name} (${f.itemCount} items)</li>`;
  }
  html += `</ul></div></details>`;

  return html;
}

function wrapInEmailTemplate(
  body: string,
  feedStatusHtml: string,
  greeting?: string,
  modelLabel?: string,
  unsubFooterHtml?: string,
  imageHtml?: string,
): string {
  const greetingHtml = greeting
    ? `<p style="font-size:17px;color:#5C4A3A;margin:0 0 24px 0">${greeting}</p>`
    : '';
  const modelFooterHtml = modelLabel
    ? `<p style="margin:32px 0 0 0;text-align:center;font-size:11px;color:#A89A8A;font-style:italic">Model: ${modelLabel}</p>`
    : '';
  const unsubHtml = unsubFooterHtml ?? '';
  const heroImageHtml = imageHtml ?? '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font-family:Garamond,'EB Garamond','Times New Roman',Georgia,serif;line-height:1.7;color:#2D2A26;max-width:720px;margin:0 auto;padding:20px;background:#F7F3EE}
h1{color:#2D2A26;border-bottom:3px solid #D4835E;padding-bottom:12px;font-size:26px;font-weight:700}
h2{color:#9B4D3A;margin-top:32px;font-size:21px}
h3{color:#5C4A3A;margin-top:24px;font-size:18px}
p{margin:8px 0}strong{color:#2D2A26}em{color:#8B7B6B}
hr{border:none;border-top:1px solid #DDD5CA;margin:24px 0}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:15px}
th,thead tr th{background:#D4835E;color:#FAF6F0;padding:10px 14px;text-align:left;font-weight:600}
td{padding:8px 14px;border-bottom:1px solid #DDD5CA}
tr:nth-child(even){background:#F0EBE3}
ul{padding-left:20px}li{margin:4px 0}a{color:#9B4D3A;text-decoration:underline}
blockquote{border-left:4px solid #D4835E;margin:12px 0;padding:8px 16px;background:#FAF5EF;color:#5C4A3A}
</style></head><body>${greetingHtml}${heroImageHtml}${body}${feedStatusHtml}${modelFooterHtml}${unsubHtml}</body></html>`;
}

function buildUnsubFooter(env: Env, unsubToken: string | undefined, lang: 'en' | 'pl'): string {
  if (!unsubToken) return '';
  const origin = resolvePublicOrigin(env);
  const url = `${origin}/unsubscribe?token=${encodeURIComponent(unsubToken)}`;
  const label = lang === 'pl'
    ? 'Nie chcesz więcej otrzymywać tego newslettera?'
    : "Don't want these any more?";
  const linkText = lang === 'pl' ? 'Wypisz się' : 'Unsubscribe';
  return `<p style="margin:48px 0 0 0;padding-top:16px;border-top:1px solid #DDD5CA;text-align:center;font-size:12px;color:#A89A8A">${label} <a href="${url}" style="color:#9B4D3A">${linkText}</a></p>`;
}

const HERO_IMAGE_CID = 'digest-hero';

export interface InlineImage {
  base64: string;
  contentType: string;
  filename?: string;
}

export async function sendDigestEmail(
  env: Env,
  markdown: string,
  feedStatuses?: FeedStatus[],
  recipient?: { email: string; name: string },
  subjectOverride?: string,
  modelLabel?: string,
  unsubToken?: string,
  inlineImage?: InlineImage,
): Promise<void> {
  const to = recipient ?? EMAIL_TO;

  const htmlBody = markdownToHtml(markdown);
  const feedStatusHtml = buildFeedStatusFooter(feedStatuses);
  const firstName = to.name.split(' ')[0];
  const isPolish = subjectOverride?.includes('Codzienny') ?? false;
  const greeting = isPolish ? `☕ Dzień dobry, ${firstName}!` : `☕ Good morning, ${firstName}!`;
  const unsubFooterHtml = buildUnsubFooter(env, unsubToken, isPolish ? 'pl' : 'en');
  const imageHtml = inlineImage
    ? `<img src="cid:${HERO_IMAGE_CID}" alt="Today's illustration" style="display:block;width:100%;max-width:720px;height:auto;border-radius:6px;margin:0 0 24px 0">`
    : '';
  const htmlFull = wrapInEmailTemplate(htmlBody, feedStatusHtml, greeting, modelLabel, unsubFooterHtml, imageHtml);

  const today = new Date();
  const subject = subjectOverride ?? `Daily News Digest — ${today.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;

  const message: MailjetPayload['Messages'][number] = {
    From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
    To: [{ Email: to.email, Name: to.name }],
    Subject: subject,
    HTMLPart: htmlFull,
    TextPart: markdown,
  };
  if (inlineImage) {
    message.InlinedAttachments = [{
      ContentType: inlineImage.contentType,
      Filename: inlineImage.filename ?? 'digest.png',
      ContentID: HERO_IMAGE_CID,
      Base64Content: inlineImage.base64,
    }];
  }

  await postMailjet(env, { Messages: [message] });
}

export async function sendErrorEmail(env: Env, error: string): Promise<void> {
  await postMailjet(env, {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: EMAIL_TO.email, Name: EMAIL_TO.name }],
      Subject: `[ERROR] Daily News Digest Failed — ${new Date().toISOString().split('T')[0]}`,
      TextPart: `The daily news digest pipeline failed.\n\nError: ${error}\n\nTimestamp: ${new Date().toISOString()}`,
    }],
  });
}
