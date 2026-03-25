import { EMAIL_FROM, EMAIL_TO } from './config';
import type { Env } from './types';

function markdownToHtml(md: string): string {
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
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

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

function wrapInEmailTemplate(body: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.6;color:#1a1a1a;max-width:720px;margin:0 auto;padding:20px;background:#f9f9f9}
h1{color:#1a1a1a;border-bottom:3px solid #2563eb;padding-bottom:12px;font-size:24px}
h2{color:#2563eb;margin-top:32px;font-size:20px}
h3{color:#374151;margin-top:24px;font-size:17px}
p{margin:8px 0}strong{color:#111}em{color:#6b7280}
hr{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
th,thead tr th{background:#2563eb;color:white;padding:10px 14px;text-align:left;font-weight:600}
td{padding:8px 14px;border-bottom:1px solid #e5e7eb}
tr:nth-child(even){background:#f3f4f6}
ul{padding-left:20px}li{margin:4px 0}a{color:#2563eb}
blockquote{border-left:4px solid #2563eb;margin:12px 0;padding:8px 16px;background:#f0f4ff;color:#374151}
</style></head><body>${body}</body></html>`;
}

export async function sendDigestEmail(env: Env, markdown: string): Promise<void> {
  const htmlBody = markdownToHtml(markdown);
  const htmlFull = wrapInEmailTemplate(htmlBody);

  const today = new Date();
  const subject = `Daily News Digest — ${today.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;

  const payload = {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: EMAIL_TO.email, Name: EMAIL_TO.name }],
      Subject: subject,
      HTMLPart: htmlFull,
      TextPart: markdown,
    }],
  };

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

export async function sendErrorEmail(env: Env, error: string): Promise<void> {
  const payload = {
    Messages: [{
      From: { Email: EMAIL_FROM.email, Name: EMAIL_FROM.name },
      To: [{ Email: EMAIL_TO.email, Name: EMAIL_TO.name }],
      Subject: `[ERROR] Daily News Digest Failed — ${new Date().toISOString().split('T')[0]}`,
      TextPart: `The daily news digest pipeline failed.\n\nError: ${error}\n\nTimestamp: ${new Date().toISOString()}`,
    }],
  };

  const credentials = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);

  await fetch('https://api.mailjet.com/v3.1/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`,
    },
    body: JSON.stringify(payload),
  });
}
