// A&R365 record check. Measures the finished record and the raw take, and says in plain words what to fix.
// Pure functions, no DOM: runs in the DSP worker.
import { rms, peak, gainToDb, dbToGain, freqToMidi, snapToScale, toMono, NOTE_NAMES, SCALE_LABELS } from './dsp.js';

const pct = (v) => `${Math.round(v * 100)}%`;
const db1 = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

// 300 Hz – 4 kHz energy, where a vocal has to win against the beat.
function midBand(x, sr) {
  let lp1 = 0, lp2 = 0, acc = 0, n = 0;
  const a1 = 1 - Math.exp(-2 * Math.PI * 4000 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 300 / sr);
  for (let i = 0; i < x.length; i++) {
    lp1 += (x[i] - lp1) * a1; lp2 += (x[i] - lp2) * a2;
    const v = lp1 - lp2;
    if (Math.abs(x[i]) > 0.003) { acc += v * v; n++; }
  }
  return Math.sqrt(acc / Math.max(1, n));
}

// How far the finished vocal sits above (+) or below (-) the beat, in dB. Aim for about +3.
export const BALANCE_TARGET = 3;
export function vocalBeatBalance(vocalStem, beat, beatDb, sr) {
  const v = midBand(toMono(vocalStem), sr), b = midBand(toMono(beat), sr) * dbToGain(beatDb);
  return v > 0 && b > 0 ? gainToDb(v) - gainToDb(b) : null;
}

function frameLevels(x, sr, ms = 20) {
  const f = Math.max(1, Math.round(sr * ms / 1000)), n = Math.floor(x.length / f);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rms(x, i * f, (i + 1) * f);
  return out;
}

export function recordCheck({ sr, master, stats, target, masterOn, take, f0, shift, tune, vocalStem, beat, beatDb = 0, gateAmount = 0, stacked = false }) {
  const items = [];
  const add = (id, label, state, value, detail, fix) => items.push({ id, label, state, value, detail, fix: fix || null });
  const seconds = master[0].length / sr;

  // ---- loudness
  if (!masterOn) {
    add('loud', 'Loudness', 'warn', 'Master off', 'Mastering is switched off, so the file will come out quieter than other records. Turn the master on before you release.', 'master');
  } else if (stats && stats.lufs != null) {
    const off = stats.lufs - target;
    if (Math.abs(off) <= 1) add('loud', 'Loudness', 'good', `${stats.lufs.toFixed(1)} LUFS`, `Right on the ${target} LUFS target. It will sit level with other records.`);
    else add('loud', 'Loudness', 'warn', `${stats.lufs.toFixed(1)} LUFS`, off < 0
      ? `${Math.abs(off).toFixed(1)} dB under the ${target} LUFS target. The record is very dynamic, so the limiter is protecting the peaks. More compression on the vocal will let it come up.`
      : `${off.toFixed(1)} dB over the ${target} LUFS target.`);
  }

  // ---- peak
  const pk = gainToDb(peak(master));
  if (pk <= -0.9) add('peak', 'Peak level', 'good', `${pk.toFixed(1)} dB`, 'Peaks stay under -1 dB, so streaming encoders will not distort it.');
  else add('peak', 'Peak level', 'bad', `${pk.toFixed(1)} dB`, 'Peaks are above -1 dB and can distort once a streaming service encodes the file. Turn the master on.', 'master');

  // ---- how hard the limiter works
  if (masterOn && stats && stats.reductionDb != null) {
    const gr = Math.abs(stats.reductionDb);
    if (gr <= 4) add('limit', 'Limiting', 'good', `${gr.toFixed(1)} dB`, 'The limiter is barely working. The mix keeps its punch.');
    else if (gr <= 8) add('limit', 'Limiting', 'warn', `${gr.toFixed(1)} dB`, 'The limiter is pulling peaks down a fair amount. Drums may lose some snap. The Streaming target is gentler.');
    else add('limit', 'Limiting', 'bad', `${gr.toFixed(1)} dB`, 'The limiter is squashing the record. Pick the Streaming target or bring the beat down a little.');
  }

  // ---- the raw take
  if (take && take.length) {
    const tp = peak([take]);
    let clipped = 0;
    for (let i = 0; i < take.length; i++) if (Math.abs(take[i]) >= 0.985) clipped++;
    const tdb = gainToDb(tp);
    if (clipped > take.length * 0.00005) add('clip', 'Recording level', 'bad', 'Clipped', 'The take hit the top of the mic input and distorted. No mix can undo that. Back off the mic or lower your input gain and sing it again.');
    else if (tdb < -30) add('clip', 'Recording level', 'warn', `${tdb.toFixed(0)} dB peak`, 'The take is very quiet, so raising it also raises room noise. Move closer to the mic or turn your input up.');
    else add('clip', 'Recording level', 'good', `${tdb.toFixed(0)} dB peak`, 'Healthy level with no clipping.');

    const lv = Float32Array.from(frameLevels(take, sr)).sort();
    if (lv.length > 20) {
      const quiet = lv[Math.floor(lv.length * 0.08)], loud = lv[Math.floor(lv.length * 0.92)];
      const snr = gainToDb(loud) - gainToDb(Math.max(quiet, 1e-7));
      if (snr < 14) add('noise', 'Background noise', 'info', 'No gaps to measure', 'The take is sung wall to wall, so there are no quiet gaps to measure room noise in.');
      else if (snr >= 38) add('noise', 'Background noise', 'good', `${snr.toFixed(0)} dB clean`, 'The gaps between lines are quiet.');
      else if (gateAmount > 0) add('noise', 'Background noise', 'good', `${snr.toFixed(0)} dB, gated`, 'There is room noise in the take, and the noise gate is pulling it down between lines.');
      else add('noise', 'Background noise', snr < 24 ? 'bad' : 'warn', `${snr.toFixed(0)} dB`, 'Room noise, a fan or headphone bleed is audible between lines. The noise gate will pull it down.', 'gate');
    }
  }

  // ---- pitch
  if (f0 && tune) {
    let voiced = 0, inRaw = 0, inTuned = 0, moved = 0;
    for (let i = 0; i < f0.length; i++) {
      if (!f0[i]) continue;
      voiced++;
      const m = freqToMidi(f0[i]);
      if (Math.abs(m - snapToScale(m, tune.root, tune.scale)) <= 0.25) inRaw++;
      const t = m + (shift ? shift[i] : 0);
      if (Math.abs(t - snapToScale(t, tune.root, tune.scale)) <= 0.25) inTuned++;
      moved += Math.abs(shift ? shift[i] : 0);
    }
    const keyName = `${NOTE_NAMES[tune.root]} ${SCALE_LABELS[tune.scale].toLowerCase()}`;
    if (voiced < 40) {
      add('pitch', 'Pitch', 'info', 'No sung notes', 'This take is spoken or rapped without held notes, so there is nothing to tune. That is fine.');
    } else if (!tune.enabled) {
      const r = inRaw / voiced;
      add('pitch', 'Pitch', r >= 0.8 ? 'good' : 'warn', `${pct(r)} in key`, r >= 0.8 ? `Tuning is off and the take already sits in ${keyName}.` : `Tuning is off and ${pct(1 - r)} of the sung notes fall outside ${keyName}. Turn pitch correction on.`, r >= 0.8 ? null : 'tune');
    } else {
      const avg = (moved / voiced) * 100, r = inTuned / voiced;
      if (avg > 70) add('pitch', 'Pitch', 'warn', `${avg.toFixed(0)} cents moved`, `Notes are being moved a long way to reach ${keyName}. That usually means the key is wrong for this song. Read the key from the beat again, or pick it by ear.`, 'key');
      else add('pitch', 'Pitch', r >= 0.85 ? 'good' : 'warn', `${pct(r)} in key`, r >= 0.85
        ? `${pct(inRaw / voiced)} of your notes were in ${keyName} as sung. After tuning it is ${pct(r)}.`
        : `After tuning, ${pct(r)} of notes sit in ${keyName}. A faster retune speed or more strength will tighten it.`);
    }
  }

  // ---- vocal against beat
  if (vocalStem && beat) {
    const d = vocalBeatBalance(vocalStem, beat, beatDb, sr);
    if (d != null) {
      if (d < BALANCE_TARGET - 4) add('balance', 'Vocal against beat', d < BALANCE_TARGET - 8 ? 'bad' : 'warn', db1(d), 'The beat is covering the vocal. People need to hear the words on the first listen.', 'balance');
      else if (d > BALANCE_TARGET + 5) add('balance', 'Vocal against beat', 'warn', db1(d), 'The vocal is far out in front and the beat sounds small behind it.', 'balance');
      else add('balance', 'Vocal against beat', 'good', db1(d), `The vocal sits on top of the beat without burying it${stacked ? ', stacks included' : ''}.`);
    }
  }

  // ---- mono
  {
    const L = master[0], R = master[1];
    let lr = 0, ll = 0, rr = 0, mono = 0;
    for (let i = 0; i < L.length; i += 2) { lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i]; const m = (L[i] + R[i]) / 2; mono += m * m; }
    const corr = lr / Math.sqrt(ll * rr || 1);
    const loss = 10 * Math.log10((mono || 1e-12) / ((ll + rr) / 2 || 1e-12));
    if (corr >= 0.3) add('mono', 'Phone and club speakers', 'good', `${loss.toFixed(1)} dB in mono`, 'The record holds together when it is played in mono, like on a phone speaker or a club system.');
    else add('mono', 'Phone and club speakers', 'warn', `${loss.toFixed(1)} dB in mono`, 'A lot of the sound sits wide in the stereo field and thins out on a phone speaker. Ease off the doubles or re-centre the vocal.');
  }

  // ---- dead air and length
  {
    const m = toMono(master), th = dbToGain(-50);
    let first = 0;
    while (first < m.length && Math.abs(m[first]) < th) first++;
    const lead = first / sr;
    if (lead > 1.5) add('start', 'Start of the track', 'warn', `${lead.toFixed(1)} s of silence`, 'There is dead air before the music starts. Listeners skip in the first seconds.');
    if (seconds < 30) add('length', 'Length', 'warn', `${Math.round(seconds)} s`, 'Under 30 seconds. Streaming services generally only count a play after 30 seconds of listening.');
    else add('length', 'Length', 'good', `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`, 'Long enough to count as a play on streaming services.');
  }

  const cost = { good: 0, info: 0, warn: 8, bad: 18 };
  const score = Math.max(0, 100 - items.reduce((a, it) => a + cost[it.state], 0));
  const order = { bad: 0, warn: 1, good: 2, info: 3 };
  items.sort((a, b) => order[a.state] - order[b.state]);
  const bad = items.filter((i) => i.state === 'bad').length, warn = items.filter((i) => i.state === 'warn').length;
  const verdict = bad ? `${bad} thing${bad > 1 ? 's' : ''} to fix before you release` : warn ? `Close. ${warn} thing${warn > 1 ? 's' : ''} worth a look` : 'Ready to release';
  return { score, verdict, items };
}
