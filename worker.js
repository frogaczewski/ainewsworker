/**
 * Cloudflare Worker: AI News Digest Email Sender
 *
 * Receives a POST with markdown digest content and sends it as a
 * styled HTML email via Mailjet's API.
 *
 * Environment variables (set in Cloudflare dashboard or wrangler.toml):
 *   MAILJET_API_KEY
 *   MAILJET_SECRET_KEY
 *   AUTH_TOKEN  — a secret token to protect the endpoint
 */

export default {
  async fetch(request, env) {
    // Only accept POST
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Simple auth check
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || authHeader !== `Bearer ${env.AUTH_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const body = await request.json();
      const { markdown, subject, from_email, from_name, to_email, to_name } = body;

      if (!markdown) {
        return new Response(JSON.stringify({ error: 'Missing "markdown" field' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Convert markdown to simple HTML
      const htmlBody = markdownToHtml(markdown);
      const htmlFull = wrapInTemplate(htmlBody);

      // Send via Mailjet API
      const mailjetPayload = {
        Messages: [{
          From: {
            Email: from_email || 'ainews@rogaczewski.me',
            Name: from_name || 'AI News Digest'
          },
          To: [{
            Email: to_email || 'frogaczewski@gmail.com',
            Name: to_name || 'Filip Rogaczewski'
          }],
          Subject: subject || `Daily News Digest — ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
          TextPart: markdown,
          HTMLPart: htmlFull
        }]
      };

      const credentials = btoa(`${env.MAILJET_API_KEY}:${env.MAILJET_SECRET_KEY}`);

      const mjResponse = await fetch('https://api.mailjet.com/v3.1/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`
        },
        body: JSON.stringify(mailjetPayload)
      });

      const mjData = await mjResponse.json();

      if (!mjResponse.ok) {
        return new Response(JSON.stringify({ error: 'Mailjet error', details: mjData }), {
          status: 502,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        success: true,
        messageId: mjData.Messages?.[0]?.To?.[0]?.MessageID
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

// --- Simple Markdown to HTML converter ---
function markdownToHtml(md) {
  let html = md
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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
  // Remove separator rows (|---|---|)
  html = html.replace(/<tr><td>[-:]+<\/td>(?:<td>[-:]+<\/td>)*<\/tr>/g, '');
  // Wrap consecutive <tr> in <table>
  html = html.replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>');
  // Make first row of each table use <th>
  html = html.replace(/<table><tr>(.*?)<\/tr>/g, (match, row) => {
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

function wrapInTemplate(body) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
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
</style></head><body>${body}</body></html>`;
}
