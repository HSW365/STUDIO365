# STUDIO365 by HSW365

Record it tonight. Release it tonight.

A full vocal studio that runs in the browser: record over a beat, pitch-correct to key, mix, master to a loudness target, export. Static site, no build step, no server required.

## What's in it

| Page | What it does |
| --- | --- |
| `index.html` | Landing page with a live raw vs. tuned A/B demo, pricing, FAQ, Pro early-access form |
| `studio.html` | The studio |

### Studio features (all working, all client-side)

- **Record** over a beat with sample-accurate AudioWorklet capture, count-in, click track, mic monitoring, input meter, latency compensation, punch-in from the playhead. Unlimited takes.
- **Import** beats and vocal files (MP3, WAV, M4A, FLAC, OGG); drag and drop onto the timeline.
- **Key and tempo detection** from the beat (chroma + Krumhansl profiles, onset autocorrelation).
- **Pitch correction**: YIN pitch tracking, scale snapping (major, minor, harmonic minor, pentatonics, chromatic), retune speed, strength, vibrato keep, WSOLA-aligned granular pitch shifting. Runs in a Web Worker.
- **Mix chain**: low cut, mud cut, body, presence, sibilance cut, air, compression with makeup, saturation, convolution reverb, tempo-synced 1/8 echo, pan, vocal timing nudge, auto vocal-to-beat balance.
- **Master**: ITU-R BS.1770 integrated loudness to -14 / -9 / -16 LUFS, lookahead brickwall limiter at -1 dB.
- **Export**: 24-bit WAV master, MP3 320, MP3 128 (lamejs), processed vocal stem.
- **Sessions** autosave to IndexedDB (audio included) and reopen on return.
- Shortcuts: Space play/stop, R record.

## Files

```
index.html  studio.html  config.js  supabase.sql
assets/css/   base.css  site.css  studio.css
assets/js/    dsp.js (engine)  dsp-worker.js  mixer.js  store.js  recorder-worklet.js  studio.js  landing.js
assets/img/   favicon.svg  og.png
render.yaml   Render static-site blueprint
```

## Deploy

Any static host works. Two options already set up for this repo:

- **Render**: New > Static Site > this repo, publish directory `.`, no build command (or use `render.yaml`).
- **GitHub Pages**: Settings > Pages > Deploy from branch > `main` / root.

## Pro early-access list (optional)

1. In Supabase, run the `studio365_waitlist` block at the bottom of `supabase.sql`.
2. Put the project URL and anon/publishable key in `config.js`.

Until then, the form opens the visitor's email app addressed to hsw365media@gmail.com.

## Scope notes

- Pitch correction is real DSP, not a VST wrapper. It is tuned for monophonic vocals; harmonies and heavy reverb on the input reduce accuracy.
- Pro features listed on the landing page (cloud sessions, distribution, A&R365, network) are marked "Opening soon" and are not built in this repo. `supabase.sql` holds the schema for them.
- Payments are not wired. No card is ever collected.

© HSW365 Media LLC
