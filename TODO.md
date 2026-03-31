# TODO — AI News Digest Frontend

## Signup Form (Priority: High)
- [ ] Implement email subscription endpoint (`POST /subscribe`)
- [ ] Choose storage backend for subscribers (Cloudflare KV, D1, or external service like Mailjet contact lists)
- [ ] Add email validation (format + MX record check)
- [ ] Add double opt-in flow (send confirmation email, verify token)
- [ ] Store subscriber preferences (language, categories of interest)
- [ ] Wire up the frontend form to call the subscribe endpoint
- [ ] Add success/error feedback UI on the form
- [ ] Add unsubscribe endpoint (`GET /unsubscribe?token=...`)
- [ ] Update the digest pipeline to send to all confirmed subscribers (not just hardcoded email)

## Landing Page — Real News Content
- [ ] Store the latest generated digest (e.g. in KV) after each pipeline run
- [ ] Serve real articles on the landing page from the stored digest
- [ ] Add a "Last updated" timestamp
- [ ] Consider caching the rendered HTML for performance

## Future Enhancements
- [ ] Add language selection to signup (English, Polish, etc.)
- [ ] Add category preferences (tech, science, politics, etc.)
- [ ] Archive page — browse past digests
- [ ] RSS feed output for the digest itself
- [ ] Social sharing meta tags (Open Graph, Twitter cards)
