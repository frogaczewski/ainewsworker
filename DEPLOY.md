# Deploying the AI News Digest Worker

## Prerequisites
- Node.js installed
- A Cloudflare account (free tier works)

## Step 1: Install Wrangler CLI
```bash
npm install -g wrangler
```

## Step 2: Authenticate with Cloudflare
```bash
wrangler login
```
This opens a browser window — authorize the CLI.

## Step 3: Deploy the Worker
```bash
cd cloudflare-worker
wrangler deploy
```
After deploying, Wrangler prints your Worker URL, something like:
`https://ai-news-digest.<your-subdomain>.workers.dev`

## Step 4: Set Secrets
```bash
wrangler secret put MAILJET_API_KEY
# paste: 10108f29c02a0bde3cdcd848a9e25a04

wrangler secret put MAILJET_SECRET_KEY
# paste: 19b5dee332c9cf7ae75d015c2031141d

wrangler secret put AUTH_TOKEN
# choose any strong random string, e.g.: openssl rand -hex 32
```

## Step 5: Test It
```bash
curl -X POST https://ai-news-digest.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-AUTH_TOKEN>" \
  -d '{"markdown": "# Test\n\nHello from the AI News Digest!"}'
```

You should receive the test email within seconds.

## How It Works
POST a JSON body to the Worker URL:
```json
{
  "markdown": "# Your digest content...",
  "subject": "Optional custom subject",
  "from_email": "ainews@rogaczewski.me",
  "to_email": "frogaczewski@gmail.com"
}
```
Only `markdown` is required — all other fields have sensible defaults.
