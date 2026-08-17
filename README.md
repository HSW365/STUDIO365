# STUDIO365 — HSW365 production web app

"Record. Autotune. Mix like a pro. Ship to every platform. All AI."

This repository is a static GitHub Pages front end plus Supabase Edge Functions. It is intentionally build-step free.

## 1. What is included

- Hash-routed dashboard, Studio, Distribution, Network, A&R365, Pricing and Account screens.
- Supabase Auth and database integration.
- Browser microphone recording with MediaRecorder.
- Real-time level meter + waveform.
- Beat import/playback.
- Native Web Audio processing controls for the pro rack.
- WAV export and MP3 320/128 export through lamejs.
- AI Engineer and A&R365 requests through a server-side Anthropic proxy.
- Stripe Checkout + Customer Portal through server-side Edge Functions.
- Stripe trial/subscription state sync through webhook.
- Distribution submission endpoint with manual queue fallback when no aggregator credentials exist.
- Supabase Realtime room chat.
- RLS policies and the requested tables.

## 2. Important production honesty

- The pro rack is native Web Audio plus JS/WASM-capable DSP. It does not bundle proprietary VST plugins.
- The included AutoTune AudioWorklet is a safe pass-through scaffold. A production pitch-shifting algorithm/WASM module must be connected before marketing "hard-tune" quality as equivalent to commercial autotune. The UI and routing are already prepared for it.
- Distribution requires a real Revelator, SonoSuite, FUGA, or other approved aggregator API contract/key. Without it, the Edge Function explicitly queues the release for manual delivery.
- Secret keys never belong in `config.js`.

## 3. Supabase setup

1. Create a Supabase project.
2. Open SQL Editor and run `supabase.sql`.
3. Create Storage buckets:
   - `masters`
   - `covers`
4. Keep masters private. Add storage RLS policies so authenticated users can upload/read only their own path (`auth.uid() = first path segment`).
5. Authentication: enable Email provider and choose your email confirmation policy.
6. Realtime: the SQL adds `messages` to the realtime publication.

## 4. Front-end config

Copy `config.js` values:

- `SUPABASE_URL`: Project URL
- `SUPABASE_ANON_KEY`: anon public key
- `STRIPE_PUBLISHABLE_KEY`: Stripe publishable key (not used for secrets)
- `EDGE_FN_URL`: e.g. `https://YOUR_PROJECT.supabase.co/functions/v1`

Do not put any other secret in the front end.

## 5. Stripe setup

Create a recurring Stripe Price at `$23 USD/month`.

Create a one-time coupon for `$8 off`, duration `once`.

Set these Supabase Edge Function secrets:

- `STRIPE_SECRET_KEY`
- `STRIPE_PRICE_ID_23`
- `STRIPE_FIRST_MONTH_COUPON_ID`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`

The Checkout Function uses:
- 7-day subscription trial
- payment method collection at checkout
- $8 one-time coupon
- $23 recurring price

Result: 7 free days -> $15 first paid billing cycle -> $23/month.

Create a Stripe webhook pointing to:

`https://YOUR_PROJECT.supabase.co/functions/v1/stripe-webhook`

Subscribe it to:
- customer.subscription.created
- customer.subscription.updated
- customer.subscription.deleted

## 6. Anthropic AI

Set:

`ANTHROPIC_API_KEY`

in Supabase Edge Function secrets.

The browser calls `/ai-proxy`; the Edge Function calls Anthropic. The API key never reaches the browser.

If your Anthropic account uses a different current model identifier, update `functions/ai-proxy.ts`.

## 7. Distribution

Choose one aggregator and obtain the actual API contract/key.

Set:

- `DISTRIBUTOR_API_URL`
- `DISTRIBUTOR_API_KEY`

The included function sends normalized release metadata to that endpoint. Because aggregator APIs differ, map their exact required fields in `functions/distribute-submit.ts` before going live.

If these variables are absent, the release remains in Supabase with `pending` status and the UI says it is queued for manual delivery. This is intentional and prevents false claims of direct Spotify/Apple delivery.

## 8. Deploy Edge Functions

Install the Supabase CLI, link your project, then deploy:

```bash
supabase functions deploy stripe-checkout
supabase functions deploy stripe-portal
supabase functions deploy stripe-webhook
supabase functions deploy ai-proxy
supabase functions deploy distribute-submit
```

Set secrets:

```bash
supabase secrets set STRIPE_SECRET_KEY=...
supabase secrets set STRIPE_PRICE_ID_23=...
supabase secrets set STRIPE_FIRST_MONTH_COUPON_ID=...
supabase secrets set STRIPE_WEBHOOK_SECRET=...
supabase secrets set ANTHROPIC_API_KEY=...
supabase secrets set DISTRIBUTOR_API_URL=...
supabase secrets set DISTRIBUTOR_API_KEY=...
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
```

## 9. GitHub Pages

Push the contents of this folder to a GitHub repository:

```bash
git init
git add .
git commit -m "Build STUDIO365"
git branch -M main
git remote add origin YOUR_GITHUB_REPO_URL
git push -u origin main
```

Then GitHub:
Settings -> Pages -> Deploy from branch -> `main` -> `/ (root)`.

Because this is hash routing, no server rewrite is required.

## 10. Before public launch

- Use HTTPS/your GitHub Pages HTTPS origin for microphone permissions.
- Configure Supabase Auth redirect URLs to your GitHub Pages URL.
- Configure Stripe success/cancel URLs for the final domain.
- Test webhook signature verification.
- Test RLS with two separate accounts.
- Keep masters private.
- Replace the placeholder distributor adapter with the exact API fields from your chosen provider.
- Replace the pass-through AutoTune processor with a licensed/owned pitch-correction DSP implementation if you intend to advertise true real-time pitch correction.
- Test WAV/MP3 exports on current Chrome, Edge, Safari and mobile browsers.
- Add legal Terms, Privacy, copyright/takedown and distribution agreement pages before accepting public customers.

## 11. 30-minute wiring order

1. Supabase project + SQL.
2. Buckets + storage policies.
3. Email auth + redirect URL.
4. Put public values in `config.js`.
5. Stripe product/price/coupon.
6. Edge secrets.
7. Deploy five functions.
8. Stripe webhook.
9. Anthropic key.
10. Aggregator key and adapter.
11. Push to GitHub Pages.
12. Test one account through signup -> trial -> recording -> export -> Stripe -> distribution queue.

## 12. Production status model

Studio access:
- `trialing` = unlocked
- `active` = unlocked
- `canceled` / `past_due` / `unpaid` = read-only/locked behavior

Paid-only:
- distribution
- member network
- A&R365

The client never treats a missing aggregator key as a successful store delivery.
