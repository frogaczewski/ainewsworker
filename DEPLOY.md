# AI News Digest Worker — Operating Manual

## Deploy

Deploys happen **automatically on push to GitHub**. CI picks up the change,
runs `wrangler deploy`, and the new code is live within ~1 minute.

```bash
git add -A
git commit -m "describe change"
git push
```

No manual `wrangler deploy` step is needed. If CI fails, check the GitHub
Actions run for the error.

### Manual deploy (fallback)

Only use when CI is broken or you're on a branch that doesn't auto-deploy:

```bash
cd cloudflare-worker
wrangler login        # one-time, opens browser
wrangler deploy
```

## Configuration

### Secrets

Already set in the Cloudflare dashboard:

- `CLAUDE_PLATFORM_API` — Anthropic API key
- `MAILJET_API_KEY` — Mailjet public key
- `MAILJET_SECRET_KEY` — Mailjet secret key

To rotate: `wrangler secret put <NAME>`.

### Environment variables (`wrangler.toml` → `[vars]`)

- `USE_BATCHED_CLASSIFICATION` — feature flag for the classify-then-select
  pipeline. `"true"` runs the new Haiku-based batched flow; `"false"` or unset
  runs the legacy single-call Sonnet triage.

To flip the flag: edit `wrangler.toml` and push. (Dashboard override also
works — the dashboard value wins over the `wrangler.toml` value if both are
set.)

## Operating the pipeline

### Scheduled runs

- **03:00 UTC** — primary daily digest
- **03:30 UTC** — retry, gated by a heartbeat KV key (`digest:lastSuccess`).
  Runs only if the 03:00 attempt didn't write the heartbeat. Alarms via
  email if both runs fail.

### Manual triggers (`POST /run`)

Base URL: `https://ainewsworker.rogaczewski-dev.workers.dev`

Curl stays open for the full run (up to 15 min). Always pass `--max-time 900`
so curl doesn't bail before the worker finishes.

| Query param | Effect |
|---|---|
| `?dry=true` | Legacy path only — runs fetch + legacy triage, writes `digest:{date}` stories, skips compilation and email. |
| `?classifyOnly=true` | **Batched path only** — runs Stages 1-3 (classify + dedup), writes `classified:{date}` to KV, stops. Good for "did we even classify the right things?" checks. |
| `?selectOnly=true` | **Batched path only** — runs Stages 1-4 (classify + dedup + select), writes `selected:{date}` to KV, stops. Good for "did the section balance work?" checks. |
| `?test=true` | Full pipeline, but emails go only to `frogaczewski@gmail.com` (no Polish recipients). Use this for end-to-end tests. |
| *(none)* | Full production run — English + Polish emails to all recipients. |

Examples:

```bash
# Stage 1-3 only — cheap sanity check before committing to a full run
curl -X POST --max-time 900 \
  "https://ainewsworker.rogaczewski-dev.workers.dev/run?classifyOnly=true"

# End-to-end test, email only to Filip
curl -X POST --max-time 900 \
  "https://ainewsworker.rogaczewski-dev.workers.dev/run?test=true"

# Full production run (same as cron)
curl -X POST --max-time 900 \
  "https://ainewsworker.rogaczewski-dev.workers.dev/run"
```

## Observing

### Live logs

```bash
wrangler tail --format=pretty
```

Run in a separate terminal before triggering `/run`. Streams each
`console.log` from the worker in real time.

### Inspecting KV state

```bash
# What's in today's classified pool? (after ?classifyOnly=true)
wrangler kv key get "classified:$(date -u +%Y-%m-%d)" --binding=DIGEST_KV \
  | jq 'length'

# Section-by-section story count (after ?selectOnly=true or full run)
wrangler kv key get "selected:$(date -u +%Y-%m-%d)" --binding=DIGEST_KV \
  | jq '.sections[] | {key, count: (.stories | length)}'

# See what got dropped and why
wrangler kv key get "selected:$(date -u +%Y-%m-%d)" --binding=DIGEST_KV \
  | jq '.dropped'

# See any gap notes (e.g. missing Ukraine coverage)
wrangler kv key get "selected:$(date -u +%Y-%m-%d)" --binding=DIGEST_KV \
  | jq '.gaps'

# Per-batch classification checkpoints (for debugging a stuck retry)
wrangler kv key list --binding=DIGEST_KV --prefix="classified:batch:$(date -u +%Y-%m-%d)"
```

### KV TTLs

| Key pattern | TTL | Purpose |
|---|---|---|
| `classified:batch:{date}:{N}` | 2 hours | Per-batch checkpoint for 03:30 retry resumption |
| `classified:{date}` | 7 days | Audit the full classified pool |
| `selected:{date}` | 7 days | Audit which stories were selected into which section |
| `digest:latest` | ∞ | Landing-page source |
| `digest:{date}` | ∞ | Archive |
| `articles:index` | ∞ | Date index for pagination |
| `digest:lastSuccess` | ∞ | Heartbeat for retry cron |

## Troubleshooting

### "Classification returned 0 items — every batch failed"

Every Haiku call failed. Check `wrangler tail` for API errors (rate limit,
auth, etc.). The 03:30 retry will automatically re-run.

### Retry didn't skip completed batches

Verify the batch keys exist:
```bash
wrangler kv key list --binding=DIGEST_KV --prefix="classified:batch:$(date -u +%Y-%m-%d)"
```
If empty, the 03:00 run died before any batch wrote to KV.

### Wall-clock over 15 minutes

Check per-stage timings in `wrangler tail`. Classification is usually the
biggest variable. If it's consistently tight, the safest knob is to move
the cron to 02:45 UTC in `wrangler.toml`:

```toml
[triggers]
crons = ["45 2 * * *", "15 3 * * *"]
```

### Rolling back to the legacy pipeline

Edit `wrangler.toml`:
```toml
[vars]
USE_BATCHED_CLASSIFICATION = "false"
```
Push → CI redeploys → next run uses the Sonnet single-call path.
