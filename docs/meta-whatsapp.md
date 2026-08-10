# Meta / WhatsApp

## Account model

**Clients 1–12: own-app-per-client.** The client creates their own Business Portfolio,
pays Meta directly, we are Admin. Permanent System User token. No App Review needed —
live in days. Tech Provider paperwork starts around client 8; it changes nothing in
the code until it lands.

⚠️ **Never create a client's Meta assets under a personal Facebook profile.** If it
gets flagged, every client dies at once.

New WABAs start in a capped messaging tier. Irrelevant for an inbound-driven booking
bot, but check before any client plans a broadcast.

## Webhook routing

Each client's App has its own app secret, and the signature must be verified before
parsing the body — so client identity has to be in the URL:

```
POST /webhook/:slug        slug = random, e.g. wh_8f3a91c2
```

Random, never guessable like `sharmasalon` — junk traffic eats the 100k/day budget.

Store **both** `webhook_slug` and `phone_number_id` from day one. When we become a
Tech Provider this collapses to one shared path routed by `phone_number_id`, and the
migration should be a config change.

## Pricing — the reason for "one reply = one message"

- Since 1 Jul 2025, Meta bills per delivered **template** message.
- **From 1 Oct 2026, free-form service messages inside the 24-hour window also become
  chargeable**, benchmarked to utility/authentication template rates. Affects every
  WABA regardless of provider.
- Exact per-market rates are due from Meta by **1 Sep 2026**. Re-run the per-client
  cost model then. Until then treat the rate as unknown, not zero.

The per-client cost estimate in the business plan assumed Claude Haiku with caching.
Re-check it once the LLM endpoint is known — prompt-caching behaviour differs by
provider. Two unknowns, one deadline.

## Media in v1

Accept images and voice notes; do not attempt to answer them. Save to R2, reply
honestly ("Thanks — I've passed this to the team, someone will get back to you
shortly"), flag for handoff. Vision and Whisper transcription are post-demo.

## Deployment note

Until there is a paying client, use `workers.dev` and `pages.dev` — free, HTTPS, and
Meta accepts a `workers.dev` webhook URL. Custom domains require moving nameservers to
Cloudflare, which is a separate deliberate exercise. Don't do it early.
