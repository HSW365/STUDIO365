# STUDIO365 by HSW365

Record it tonight. Release it tonight.

A full vocal studio that runs in the browser: record over a beat, pitch-correct to key, mix, master to a loudness target, export. Static site, no build step, no server required.

## What's in it

| Page | What it does |
| --- | --- |
| `index.html` | Landing page with a live raw vs. tuned A/B demo, pricing, FAQ, Cash App checkout for Pro |
| `studio.html` | The studio |
| `admin.html` | Key maker for the owner: turns a Cash App payment into a Pro key |

### Studio features (all working, all client-side)

- **Record** over a beat with sample-accurate AudioWorklet capture, count-in, click track, mic monitoring, input meter, latency compensation, punch-in from the playhead. Unlimited takes.
- **Import** beats and vocal files (MP3, WAV, M4A, FLAC, OGG); drag and drop onto the timeline.
- **Key and tempo detection** from the beat (chroma + Krumhansl profiles, onset autocorrelation).
- **Pitch correction**: YIN pitch tracking with octave-error repair, scale snapping (major, minor, harmonic minor, pentatonics, chromatic), retune speed, strength, vibrato keep. The shifter is formant-preserving TD-PSOLA, so a corrected or transposed note keeps the singer's tone. Runs in a Web Worker.
- **Console**: playback runs live through the mix graph, so every control answers while the song plays. Channel strips for Vocal, Stack, Beat, Reverb return, Echo return and Master, each with a long-throw fader and live meter; pan, mute and solo where they apply; gain-reduction meters on the vocal compressor and the limiter.
- **Vocal channel**: 6-point EQ you drag on a curve (low cut, four bands with frequency, gain and width, high cut) over a live spectrum; compressor with threshold, ratio, attack, release and make-up; split-band de-esser; noise gate; saturation; reverb and echo sends; timing nudge; auto vocal-to-beat balance.
- **Beat channel**: low end, vocal pocket and top end EQ. **Reverb**: decay, pre-delay, brightness, low cut. **Echo**: tempo-synced note values, repeats, brightness, side-to-side bounce. **Bus**: glue compression and trim.
- **Editing**: drag to select part of the take, then trim, cut out, silence, fade in, fade out, clip gain, normalize, reverse, or lift the selection to a new take. Move the take against the beat, zoom the timeline, loop a selection. Undo and redo.
- **Master**: ITU-R BS.1770 integrated loudness to -14 / -9 / -16 LUFS, lookahead brickwall limiter at -1 dB.
- **Export**: 24-bit WAV master, MP3 320, MP3 128 (lamejs), processed vocal stem.
- **Sessions** autosave to IndexedDB (audio included) and reopen on return.
- Shortcuts: Space play/stop, R record, L loop, Ctrl+Z undo, Ctrl+Shift+Z redo, Delete silences the selection, + and - zoom.

### Pro (paid with Cash App)

- **Tune Pro**: humanize, flex (leaves bends alone), note glide, transpose, voice character (formant), fine tune, a keyboard to pick exactly which notes the tuning may land on, and a pitch editor where each note is a block you drag to a new pitch or leave untuned.
- **Vocal stacks**: wide doubles and an in-key harmony voice generated from the lead take, plus any other take stacked under the lead with its own level and pan.
- **Six more presets** (three are free).
- **A&R365 record check**: scores the finished record and the raw take (loudness, peaks, limiting, clipping, room noise, pitch, vocal-to-beat balance, mono, length) with one-click fixes.
- **Release pack**: one ZIP with 24-bit master, 16-bit 44.1 kHz master, tagged MP3 320 with cover, 3000 px cover and a release sheet.
- **Session backup**: save a whole session to a `.studio365` file and open it on another computer.

## How Pro and Cash App work

There is no server. A Pro key is a short signed note (email + end date). The site holds only the public half of the signing key, so it can check a key but nobody can make one from the page source.

1. A customer presses **Go Pro**, pays the cashtag in `config.js` with Cash App, and puts their email in the note.
2. You open **`admin.html`** (the key maker), load `studio365-owner-key.json` once, type their email and press **Make key**.
3. Send them the message it writes. Their link turns Pro on in one tap. Keys end on their own; a renewal is a new payment and a new key.

Things to know:

- `studio365-owner-key.json` is **not** in this repo and must never be. Whoever has it can make Pro keys. Keep a backup.
- The key maker page is public but does nothing without the owner file. Its member list lives in your browser only; download the CSV now and then.
- Prices and the cashtag live in `config.js` (`PRO_PRICE`, `PRO_FIRST_MONTH`, `CASHTAG`).
- Cash App cannot bill automatically or prove a payment to the site, so approval is manual. A key is not tied to one device; a customer could share theirs. The studio runs in the browser, so like any web app a determined person could edit the code to skip the check.
- Selling through Cash App needs a Cash App business account under its terms.

## Files

```
index.html  studio.html  admin.html  config.js  supabase.sql
assets/css/   base.css  site.css  studio.css  console.css  pro.css
assets/js/    dsp.js (engine)  dsp-worker.js  mixer.js (console signal path)  console.js (strips, meters, EQ)
              strip-worklet.js (compressor, de-esser, limiter)  edit.js  check.js  presets.js  pack.js  store.js
              recorder-worklet.js  studio.js  landing.js  license.js  pro.js  admin.js
assets/img/   favicon.svg  og.png
render.yaml   Render static-site blueprint
```

## Deploy

Any static host works. It must be served over https (the mic and Pro keys need it); opening the files straight from a folder will not work.

- **GitHub Pages** (recommended, free): Settings > Pages > Deploy from branch > `main` / root.
- **Render**: New > Static Site > this repo, publish directory `.`, no build command (or use `render.yaml`).

## Payment notices table (optional)

Without Supabase, "I paid. Send my key" opens the customer's email app addressed to `CONTACT_EMAIL`. To log notices in a table instead, run the `studio365_pro_requests` block at the bottom of `supabase.sql` and put the project URL and anon/publishable key in `config.js`.

## Scope notes

- Pitch correction and harmony are real DSP, not a VST wrapper. They are tuned for monophonic vocals; harmonies and heavy reverb on the input reduce accuracy.
- Cloud sessions, direct distribution to stores, and an artist network are not built. `supabase.sql` holds a schema sketch for them.
- No card is ever collected by this site. Payment happens inside Cash App.

© HSW365 Media LLC
