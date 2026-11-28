# Buzzbite

Your social media. Taken care of. Live at [app.buzzbite.io](https://app.buzzbite.io).

Buzzbite keeps a brand kit for each business (logo, colours, fonts, voice, audience, content themes, facts and photo style). From it, Buzzbite:

1. **Fills the calendar.** Pick your posting days; one click creates the month's posts for LinkedIn and Instagram, each a finished design with captions written for each platform.
2. **Makes the visuals.** Photo posts get an AI photo in the brand's art direction (fal.ai, FLUX 3); video posts animate that photo into a short clip (fal.ai, Kling) with moving headlines; graphic posts use the brand's colours and type.
3. **Waits for your OK.** Review posts one at a time: approve, or ask for a change ("new photo", "make it a video", "shorter caption", or anything in your own words). "Approve all" is there when you trust it.
4. **Watches what's happening.** Trend radar searches the web for news, events, seasons and conversations in the brand's market and suggests post ideas, each with sources. "Add to calendar" turns one into a finished post on the next free day.
5. **Exports.** Download any post as a 1080×1350 PNG or an H.264 MP4.

## Stack

| Part | Choice |
| --- | --- |
| App | Next.js 15 (App Router), TypeScript |
| Database | Neon Postgres (`@neondatabase/serverless`, HTTP driver) |
| Writing, planning, trend research | Claude API (`@anthropic-ai/sdk`), model `claude-opus-5-5`, structured outputs, web search, server-side refusal fallbacks |
| Photos and video | fal.ai (`FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL` to swap models); files stored in Vercel Blob |
| Rendering | Post designs are React components (`src/templates`); exports run in the browser (`html-to-image`, WebCodecs + `mp4-muxer`) |
| Hosting | Vercel |

## Post designs

Photo, Photo + band, Framed photo, Photo + figure, Video, Statement, Big number, Checklist, Chat, Poster, Animated graphic. Claude picks the design for each post and varies them across the month.

## How the pipeline works

`/api/brands/[id]/fill` asks Claude to write finished posts for up to 7 empty posting days at a time (the calendar calls it until the month is full). Posts that need a photo are saved as "making" and their photo is queued on fal.ai. `/api/brands/[id]/advance` (polled by the calendar and review screens) collects finished photos, queues clips for video posts, and moves posts to "review".

## Auto-posting

Buzzbite posts approved content to Instagram and LinkedIn through [Zernio](https://zernio.com), which holds the
connected accounts and publishes at the scheduled time (so the app needs no scheduler of its own).

- **Connect:** Brand kit → Social accounts. Each brand gets its own Zernio profile (`externalId` = brand id).
- **Approve & schedule:** the browser renders the final files off-screen (`src/lib/deliver.tsx`): a JPEG, or carousel
  slides plus a PDF for LinkedIn, or an MP4. It uploads them to Vercel Blob, and the server books the post for its date at the
  brand's posting time and time zone (`src/lib/publish.ts`, `src/lib/zernio.ts`).
- **Changes:** moving a post re-books it; revising or un-approving cancels the booking; deleting cancels it.
- **Results:** the calendar checks due posts and shows Scheduled, Posted (with links) or Failed (with Try again / Post now).

## Accounts and billing

- **Accounts:** email and password (scrypt hashes, signed session cookie). Each customer has a workspace; brands,
  posts and media are only ever read through the signed-in user's workspace (`src/lib/accounts.ts`, `src/lib/db.ts`).
- **First run:** while no accounts exist, the sign-in page asks for the old shared `APP_PASSWORD` once, so the owner
  can create their account and keep the existing workspace. After that `APP_PASSWORD` is no longer used.
- **Sign-up is invite-only** unless `SIGNUPS_OPEN=true`. The Buzzbite team creates early-access links in
  Settings → Early access invites; workspace owners invite teammates in Settings → Workspace and team.
- **Plans** (`src/lib/plans.ts`): 14-day trial, Starter, Growth, Agency, plus an unlimited internal plan. Posts and AI
  videos per month and brands per workspace are enforced in `src/lib/limits.ts`.
- **Payments** (`src/lib/payments.ts`), each off until its keys are set:
  - Stripe (USD, cards): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER|GROWTH|AGENCY`;
    webhook URL `/api/public/billing/stripe` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`).
  - Paystack (NGN): `PAYSTACK_SECRET_KEY`, `PAYSTACK_PLAN_STARTER|GROWTH|AGENCY`; webhook URL `/api/public/billing/paystack`.

## Reliability, alerts and costs

- **No tab needed:** in production, fal.ai calls `/api/public/fal` when a photo, clip or sound finishes, so posts move to
  review on their own. Zernio calls `/api/public/zernio` (signed with a secret derived from `AUTH_SECRET`) when a post is
  published or fails; connect it once from System health. A daily Vercel cron (`/api/public/cron`, needs `CRON_SECRET`)
  picks up anything a webhook missed and gives up on jobs that never finished (`src/lib/system.ts`).
- **Alerts** (`src/lib/alerts.ts`): failed photos and videos, scheduling problems and failed posts appear on the calendar
  until fixed; failed posts are also emailed to the workspace when email is set up (see `src/lib/email.ts`).
- **Costs** (`src/lib/usage.ts`): every Claude response records its tokens at list price; every finished fal.ai job
  records an estimated price per model. System health (internal only) shows this month's cost per workspace against its
  plan price, and the most expensive posts.

## Results

- Per-post numbers (reach, impressions, likes, comments, shares, saves, clicks) and daily follower counts come from
  Zernio's analytics (needs the analytics add-on on the Zernio account) and are stored in `post_metrics` and
  `brand_followers` (`src/lib/results.ts`). They refresh when the Results page is opened (at most hourly) and in the
  daily check.
- The Results page shows totals against the previous period, followers, engagement by design and by theme, the best
  and weakest posts, and every post with its numbers.
- Once a brand has 8 posts with numbers, the planner gets a summary of what worked and leans towards it.

## Security

- Sign-in is rate limited (8 failed tries per account or 30 per address in 15 minutes); so are reset requests and
  website forms (`src/lib/security.ts`).
- Password reset: `/forgot` emails a one-time link valid for 2 hours (only its hash is stored). Without email set up,
  the workspace owner makes a reset link for a teammate in Settings → Team.
- Changing or resetting a password, or "Sign out other devices", ends every other session (a session version in the
  cookie). Changing the sign-in email needs the current password.
- Security headers (HSTS, no framing, nosniff, referrer and permissions policies) are set in `next.config.ts`.

## Reels

A reel is a vertical 9:16 video of 3-4 scenes. Claude writes each scene's photo prompt, motion, on-screen caption and
voice-over line, plus a music brief. The pipeline (`src/lib/reels.ts`) makes, per scene, a vertical photo, a clip
animated from it and a voice-over, plus one instrumental music bed: models `FAL_VOICE_MODEL`
(default `fal-ai/elevenlabs/tts/eleven-v3`, narrator chosen in the Brand kit) and `FAL_MUSIC_MODEL`
(default `fal-ai/elevenlabs/music`). The browser (`src/lib/reel.ts`) draws every frame on a canvas (title, captions,
word-by-word subtitles, logo, end card), mixes the voices over ducked music, and records an H.264 MP4 with AAC sound.
The same drawing powers the preview in the review screen, the download and auto-posting. A reel counts as one video
towards plan limits.

## Running locally

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run db:migrate           # creates the tables (safe to re-run)
npm run dev
```

Environment variables: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `AUTH_SECRET`, `BLOB_READ_WRITE_TOKEN`, `FAL_KEY`, `ZERNIO_API_KEY` for auto-posting, `CRON_SECRET` for the daily check, `ZOHO_SEND_TOKEN` + `EMAIL_FROM` for email (Zoho CPaaS/ZeptoMail; `RESEND_API_KEY` also works), and optionally `FAL_REFERENCE_MODEL` (default `openai/gpt-image-2/edit`, used for photos that show the brand's product) (see `.env.example`).

## Roadmap to a product

- Real accounts (Neon Auth) with a workspace per customer; check workspace ownership on every route.
- Publish approved posts directly to Instagram and LinkedIn.
- Run trend research and calendar filling on a schedule (Vercel Cron).
- Import a brand kit from Canva; "Edit in Canva" for hand-finishing.
- Carousels, Stories and Reels formats; billing.
