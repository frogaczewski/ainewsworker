# AI News Digest Worker — Operating Manual

## Architecture

The pipeline runs in **two phases** connected by a Cloudflare Queue:

```
cron 03:00 UTC  ─▶  Phase 1 (data collection)          writes phase1:{date} to KV
                     │                                    writes digest:phase1Success
                     └─▶ DIGEST_QUEUE.send() ─┐
                                              ▼
                                    Phase 2 (compile + send)   reads phase1:{date}
                                              │                 writes digest:{date}
                                              │                 writes digest:lastSuccess
                                              │
                                  on failure → up to 2 retries with 60s delay
                                              │
                                              ▼
                                    ainewsworker-digest-dlq    sends alarm email

cron 03:30 UTC  ─▶  Retry (heartbeat-gated)
                     • if digest:lastSuccess == today → skip
                     • if digest:phase1Success == today → re-enqueue Phase 2
                     • else → re-run Phase 1, then enqueue Phase 2
```

Each phase runs in a **fresh Worker invocation** with its own 15-min wall
budget. A slow Sonnet call in Phase 2 can no longer consume time that Phase 1
needs (and vice versa).

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

### One-time setup: create the queues

The two queues referenced in `wrangler.toml` must exist before the worker
will deploy cleanly. This is a one-time step per Cloudflare account:

```bash
cd cloudflare-worker
npx wrangler login        # browser auth
npx wrangler queues create ainewsworker-digest
npx wrangler queues create ainewsworker-digest-dlq
```

To inspect queue state later:

```bash
npx wrangler queues list
npx wrangler queues info ainewsworker-digest
```

### Manual deploy (fallback)

Only use when CI is broken or you're on a branch that doesn't auto-deploy:

```bash
cd cloudflare-worker
npx wrangler login        # one-time, opens browser
npx wrangler deploy
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

- **03:00 UTC** — cron fires **Phase 1** inline, then enqueues a message for
  Phase 2. The queue consumer picks it up in a fresh invocation.
- **03:30 UTC** — retry, gated by two heartbeats:
  - `digest:lastSuccess == today` → everything shipped, skip.
  - `digest:phase1Success == today` → Phase 1 is done, just re-enqueue Phase 2.
  - else → re-run Phase 1 and re-enqueue Phase 2.
- **04:00 UTC** — **watchdog**. Silent if `digest:lastSuccess == today`.
  Otherwise emails `frogaczewski@gmail.com` with a diagnosis (which phase
  completed, which recovery curl to run). Because it's a separate Worker
  invocation it runs cleanly even when the earlier crons were killed by the
  platform (exceededCpu / wall-time) before their own error-email handlers
  could fire — which is exactly what happened on 2026-04-23.

Phase 2 itself auto-retries via the queue (2 retries, 60s delay) before
landing in the DLQ. The DLQ consumer sends an alarm email.

### External uptime monitor (recommended, belt-and-suspenders)

The in-Worker watchdog catches every Cloudflare-side failure mode we can see
from inside a Worker — but not an account-level Cloudflare outage. For that,
Phase 2 also pings an external heartbeat URL on success. If the ping stops
arriving, the external service emails you directly.

One-time setup with [healthchecks.io](https://healthchecks.io) (free tier):

1. Create a free check. Name it `ainewsworker-digest`.
2. Set *Schedule* → **Cron** = `0 3 * * *`, *Grace time* = **90 minutes**
   (covers the 03:00 run + 03:30 retry + 04:00 watchdog window).
3. Copy the Ping URL (`https://hc-ping.com/<uuid>`).
4. Add it as a Worker secret:
   ```bash
   cd cloudflare-worker
   npx wrangler secret put HEARTBEAT_URL
   # paste the URL when prompted
   ```
5. Healthchecks.io → Integrations → add your email; enable it for this check.

Same flow works with Better Uptime, Cronitor, or any URL-ping monitor —
the Worker just fires a `GET` at `env.HEARTBEAT_URL` at the end of Phase 2,
with a 10-second timeout. If the secret isn't set the ping is a no-op and
everything still works.

### Manual triggers

Base URL: `https://ainewsworker.rogaczewski-dev.workers.dev`

For `/run`, `/run-phase-2`, and `/resend` always pass `--max-time 900` so
curl doesn't bail before a sync run finishes.

#### `POST /run` — full pipeline

| Query param | Effect |
|---|---|
| *(none)* | Phase 1 sync, Phase 2 enqueued. Returns ~1-3 min after Phase 1 done. |
| `?test=true` | Phase 1 + Phase 2 **sync**, emails only to Filip. Full end-to-end test. |
| `?dry=true` | Save triaged stories to KV, skip compilation and emails. |
| `?classifyOnly=true` | Phase 1 stops after classification; writes `classified:{date}`. |
| `?selectOnly=true` | Phase 1 stops after selection; writes `selected:{date}` + `phase1:{date}`. |

#### `POST /run-phase-2` — re-trigger Phase 2 alone

Useful when Phase 1 already wrote `phase1:{date}` but Phase 2 never ran
(e.g. you flipped the queue config mid-day, or Phase 2 hit an API outage
and you've resolved it).

| Query param | Effect |
|---|---|
| `?date=YYYY-MM-DD` | Use a specific day's `phase1:{date}` (default: today). |
| `?test=true` | Email only Filip. |
| `?sync=true` | Run inline; without this the job is queued. |

#### `POST /resend` — resend the cached email briefing

Doesn't recompute anything — reads `digest:{date}.emailMarkdown` and sends
it. Use this when emails need to go out again to everyone (or a subset).

| Query param | Effect |
|---|---|
| `?date=YYYY-MM-DD` | Which day's digest to resend (default: today). |
| `?test=true` | Only to Filip. |
| `?to=email@example.com` | Only to this single recipient. Uses known name if the address is in `EMAIL_TO` / `EMAIL_TO_PL`, falls back to the local-part otherwise. |
| `?sync=true` | Send inline; default is queued. |

Returns 404 if there's no `emailMarkdown` cached for that date (i.e. Phase 2
never completed that day).

#### Examples

```bash
# Standard manual run (same as cron)
curl -X POST --max-time 900 \
  "https://ainewsworker.rogaczewski-dev.workers.dev/run"

# End-to-end test, email only to Filip, sync
curl -X POST --max-time 900 \
  "https://ainewsworker.rogaczewski-dev.workers.dev/run?test=true"

# Phase 1 ran, Phase 2 didn't — re-kick Phase 2
curl -X POST "https://ainewsworker.rogaczewski-dev.workers.dev/run-phase-2"

# Resend today's digest to everyone
curl -X POST "https://ainewsworker.rogaczewski-dev.workers.dev/resend"

# Resend yesterday's digest to a single recipient (for debugging)
curl -X POST \
  "https://ainewsworker.rogaczewski-dev.workers.dev/resend?date=2026-04-22&to=frogaczewski@gmail.com"
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
| `classified:batch:{date}:{N}` | 2 hours | Per-batch checkpoint for Phase 1 resumption |
| `classified:{date}` | 7 days | Audit the full classified pool |
| `selected:{date}` | 7 days | Audit which stories were selected into which section |
| `phase1:{date}` | 7 days | **Full Phase 1 output** — what Phase 2 reads |
| `digest:latest` | ∞ | Landing-page source |
| `digest:{date}` | ∞ | Archive; also read by `/resend` |
| `articles:index` | ∞ | Date index for pagination |
| `digest:phase1Success` | ∞ | Heartbeat: Phase 1 completed for this date |
| `digest:lastSuccess` | ∞ | Heartbeat: Phase 2 completed (emails sent) for this date |

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

With the two-phase split each phase gets its own 15-min budget — this
should rarely trigger now. If Phase 1 alone overruns, classification is
usually the biggest variable. Check per-stage timings in `wrangler tail`.

### Phase 2 hit the DLQ

The DLQ consumer emails an alarm. To recover:

1. Check `wrangler tail` or the recent logs for the root cause.
2. If the issue is resolved and Phase 1 state is still intact (check
   `wrangler kv key get "phase1:$(date -u +%Y-%m-%d)" --binding=DIGEST_KV`),
   re-kick Phase 2:
   ```bash
   curl -X POST "https://ainewsworker.rogaczewski-dev.workers.dev/run-phase-2"
   ```
3. If `phase1:{date}` is gone or corrupt, run the full pipeline:
   ```bash
   curl -X POST --max-time 900 "https://ainewsworker.rogaczewski-dev.workers.dev/run"
   ```

### Emails need to go out again to everyone

```bash
curl -X POST "https://ainewsworker.rogaczewski-dev.workers.dev/resend"
```

This reads the cached `emailMarkdown` from `digest:{today}` and resends
without recomputing anything. For a specific date, add `?date=YYYY-MM-DD`.

### A non-metric unit leaked into the digest

The compilation and email-briefing prompts normalize units (crore/lakh, miles,
°F, pounds, etc.) before writing. If a unit slips through, expand the
`UNIT NORMALIZATION` list in `src/prompts.ts` to cover the new case, then
redeploy.

### Rolling back to the legacy pipeline

Edit `wrangler.toml`:
```toml
[vars]
USE_BATCHED_CLASSIFICATION = "false"
```
Push → CI redeploys → next run uses the Sonnet single-call path.
