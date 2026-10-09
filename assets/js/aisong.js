// HSW365studio AI Song. Describe a song and it is written, sung and played for you; then change the words,
// the parts or the sound and make it again, or open it in the studio with the vocal and the music on their
// own tracks. The music model runs behind the AI Song service (supabase/functions/studio365-ai), which
// checks the member's plan key and counts songs per month. Nothing secret lives in this file.
import { hasPlan, openPro, planKey, PLANS } from './pro.js';

const cfg = window.STUDIO365_CONFIG || {};
const API = String(cfg.AI_API_URL || '').replace(/\/+$/, '');
const NEED = cfg.AI_PLAN || 'pro';
const PER_MONTH = Number(cfg.AI_SONGS_PER_MONTH) || 10;
const NEED_PLAN = PLANS.find((p) => p.id === NEED) || { name: 'Pro', price: 25 };

const GENRES = ['Hip-hop', 'Trap', 'Drill', 'R&B', 'Pop', 'Afrobeats', 'Reggaeton', 'Gospel', 'Country', 'Rock', 'House', 'Lo-fi'];
const MOODS = ['Motivational', 'Hard', 'Smooth', 'Heartfelt', 'Party', 'Dark', 'Uplifting', 'Chill'];
const VOICES = [
  { id: 'male', label: 'Male vocal', style: 'male lead vocal' },
  { id: 'female', label: 'Female vocal', style: 'female lead vocal' },
  { id: 'none', label: 'No vocal', style: 'instrumental' },
];
const LENGTHS = [30, 60, 120, 180, 240];
const SEC_MIN = 3, SEC_MAX = 120;

let host = null;          // callbacks from the studio
let dlg = null;
let view = 'create';
let busy = false;
let stand = null;         // { songsLeft, songsLimit, stemsLeft, unlimited, maxSeconds }
let form = { about: '', genre: 'Hip-hop', moods: ['Motivational'], voice: 'male', lyricsMode: 'ai', lyrics: '', seconds: 120 };
let song = null;          // the song being worked on: { id, title, plan, blob, seconds, created, peaks }
let player = null;

const $ = (id) => dlg.querySelector('#' + id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const planSeconds = (p) => p.sections.reduce((a, s) => a + s.duration_ms, 0) / 1000;

// ------------------------------------------------------------------ songs kept on this device
const DB = 'studio365-ai', STORE = 'songs';
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); res(q && q.result); };
    t.onerror = t.onabort = () => { d.close(); rej(t.error); };
  });
}
const saveSong = (s) => tx('readwrite', (st) => st.put({ id: s.id, title: s.title, plan: s.plan, blob: s.blob, seconds: s.seconds, created: s.created, peaks: s.peaks || null })).catch(() => null);
const listSongs = () => tx('readonly', (st) => st.getAll()).then((a) => (a || []).sort((x, y) => y.created - x.created)).catch(() => []);
const dropSong = (id) => tx('readwrite', (st) => st.delete(id)).catch(() => null);

// ------------------------------------------------------------------ the service
class AiError extends Error { constructor(d, status) { super(d.message || 'AI Song had a problem. Try again.'); Object.assign(this, d, { status }); } }

async function call(action, { body = null, bytes = null } = {}) {
  if (!API) throw new AiError({ code: 'off', message: 'AI Song is being switched on. Check back shortly.' }, 503);
  let r;
  try {
    r = await fetch(`${API}?action=${action}`, {
      method: 'POST',
      headers: { 'x-s365-key': planKey() || '', 'content-type': bytes ? 'application/octet-stream' : 'application/json' },
      body: bytes || JSON.stringify(body || {}),
    });
  } catch { throw new AiError({ code: 'network', message: 'Could not reach AI Song. Check your connection and try again.' }, 0); }
  const type = r.headers.get('content-type') || '';
  if (!r.ok) {
    const d = type.includes('json') ? await r.json().catch(() => ({})) : {};
    throw new AiError(d, r.status);
  }
  if (type.includes('json')) { const d = await r.json(); noteStanding(d); return d; }
  const left = r.headers.get('x-songs-left'), stems = r.headers.get('x-stems-left');
  if (stand && !stand.unlimited) { if (left != null) stand.songsLeft = Number(left); if (stems != null) stand.stemsLeft = Number(stems); }
  paintMeter();
  return r.arrayBuffer();
}
function noteStanding(d) {
  if (d && typeof d.songsLeft === 'number') stand = { songsLeft: d.songsLeft, songsLimit: d.songsLimit, stemsLeft: d.stemsLeft, unlimited: !!d.unlimited, maxSeconds: d.maxSeconds || 240 };
  paintMeter();
}

// ------------------------------------------------------------------ building the song plan
function globalStyles() {
  const v = VOICES.find((x) => x.id === form.voice);
  return [form.genre.toLowerCase(), ...form.moods.map((m) => m.toLowerCase()), v.style, 'radio ready mix'];
}
function promptText() {
  const v = VOICES.find((x) => x.id === form.voice);
  const mood = form.moods.length ? ` Mood: ${form.moods.join(', ').toLowerCase()}.` : '';
  const voice = form.voice === 'none' ? ' Instrumental only, no vocals.' : ` ${v.label} with original lyrics.`;
  return `An original ${form.genre} song.${mood}${voice} The song is about: ${form.about.trim()}`;
}

// The member's own words become the parts of the song. A blank line starts a new part; a line like
// [Chorus] or "Verse 2:" names it.
export function planFromLyrics(text, styles, seconds) {
  const blocks = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((b) => b.split('\n').map((l) => l.trim()).filter(Boolean)).filter((b) => b.length);
  const sections = [{ section_name: 'Intro', positive_local_styles: ['instrumental intro'], negative_local_styles: ['vocals'], duration_ms: 8000, lines: [] }];
  let verse = 0;
  for (const block of blocks) {
    let name = null;
    const head = block[0].match(/^\[(.+)\]$/) || block[0].match(/^((?:verse|chorus|hook|bridge|intro|outro|pre-?chorus|refrain)\b[^:]{0,20}):?$/i);
    if (head) { name = head[1].trim(); block.shift(); }
    if (!block.length && !name) continue;
    for (let i = 0; i < Math.max(1, block.length); i += 30) {
      const lines = block.slice(i, i + 30).map((l) => l.slice(0, 200));
      const label = name ? (i ? `${name} (more)` : name) : `Verse ${++verse}`;
      sections.push({ section_name: label.slice(0, 100), positive_local_styles: [], negative_local_styles: [], duration_ms: Math.round(Math.min(60, Math.max(8, lines.length * 3.2 + 2)) * 1000), lines });
    }
  }
  sections.push({ section_name: 'Outro', positive_local_styles: ['instrumental outro'], negative_local_styles: ['vocals'], duration_ms: 8000, lines: [] });
  const plan = { positive_global_styles: styles, negative_global_styles: [], sections };
  // Too long for the longest song: shorten every part by the same share.
  const total = planSeconds(plan);
  if (seconds && total > seconds) for (const s of sections) s.duration_ms = Math.max(SEC_MIN * 1000, Math.round(s.duration_ms * seconds / total));
  return plan;
}

function titleFrom(text) {
  const w = String(text).replace(/[^\p{L}\p{N}' ]+/gu, ' ').trim().split(/\s+/).slice(0, 5);
  while (w.length > 1 && /^(and|or|the|a|an|to|of|in|on|for|with|my|from|into|every|that|but)$/i.test(w[w.length - 1])) w.pop();
  const t = w.join(' ');
  return t ? t[0].toUpperCase() + t.slice(1) : 'New song';
}

// ------------------------------------------------------------------ zip (the split comes back as one)
async function unzip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('The split came back unreadable. Try again.');
  const count = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nl));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + size);
    if (!name.endsWith('/')) {
      const bytes = method === 0 ? raw.slice() : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      out.push({ name, bytes });
    }
    p += 46 + nl + xl + cl;
  }
  return out;
}

// ------------------------------------------------------------------ waveform + player
async function peaksOf(blob, n = 220) {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / n)), out = [];
    for (let i = 0; i < n; i++) { let m = 0; for (let j = i * step, e = Math.min(d.length, j + step); j < e; j += 8) { const a = Math.abs(d[j]); if (a > m) m = a; } out.push(m); }
    const top = Math.max(0.05, ...out);
    return { peaks: out.map((x) => Math.round((x / top) * 100) / 100), seconds: buf.duration };
  } catch { return { peaks: null, seconds: 0 }; }
}

function stopPlayer() {
  if (!player) return;
  player.audio.pause(); cancelAnimationFrame(player.raf); URL.revokeObjectURL(player.url); player = null;
}
function mountPlayer(s) {
  stopPlayer();
  const cv = $('aiWave'), btn = $('aiPlay'), time = $('aiTime');
  const url = URL.createObjectURL(s.blob), audio = new Audio(url);
  player = { audio, url, raf: 0 };
  const css = getComputedStyle(dlg);
  const on = css.getPropertyValue('--cyan').trim() || '#22d3ee', off = css.getPropertyValue('--line-2').trim() || '#33334a';
  const draw = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const pk = s.peaks || Array.from({ length: 120 }, (_, i) => 0.35 + 0.3 * Math.abs(Math.sin(i * 0.7)));
    const total = audio.duration || s.seconds || 1, done = audio.currentTime / total;
    const bw = w / pk.length;
    for (let i = 0; i < pk.length; i++) {
      const bh = Math.max(2, pk[i] * (h - 4));
      g.fillStyle = i / pk.length < done ? on : off;
      g.fillRect(i * bw + 0.5, (h - bh) / 2, Math.max(1, bw - 1.5), bh);
    }
    time.textContent = `${clock(audio.currentTime)} / ${clock(total)}`;
  };
  const tick = () => { draw(); if (player && !audio.paused) player.raf = requestAnimationFrame(tick); };
  const paintBtn = () => { btn.setAttribute('aria-label', audio.paused ? 'Play' : 'Pause'); btn.classList.toggle('playing', !audio.paused); };
  btn.onclick = () => { if (audio.paused) { audio.play().then(tick).catch(() => {}); } else audio.pause(); };
  audio.addEventListener('play', paintBtn); audio.addEventListener('pause', paintBtn);
  audio.addEventListener('ended', () => { audio.currentTime = 0; paintBtn(); draw(); });
  audio.addEventListener('loadedmetadata', draw);
  cv.onclick = (e) => { const r = cv.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * (audio.duration || s.seconds || 0); draw(); };
  paintBtn(); draw();
}

// ------------------------------------------------------------------ dialog
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const chips = (id, list, picked) => `<div class="ai-chips" id="${id}" role="group">${list.map((x) => {
  const v = x.id || x, l = x.label || x;
  return `<button type="button" class="ai-chip" data-v="${esc(v)}" aria-pressed="${picked.includes(v)}">${esc(l)}</button>`;
}).join('')}</div>`;

function build() {
  dlg = h(`
  <dialog class="sheet ai-sheet" aria-labelledby="aiTitle">
    <header class="ai-head">
      <div class="ai-brand">
        <p class="ai-eyebrow">HSW365studio</p>
        <h2 id="aiTitle">AI Song</h2>
      </div>
      <nav class="ai-tabs" role="tablist">
        <button type="button" role="tab" data-tab="create" aria-selected="true">Create</button>
        <button type="button" role="tab" data-tab="library" aria-selected="false">My songs</button>
      </nav>
      <p class="ai-meter" id="aiMeter" aria-live="polite"></p>
      <button type="button" class="icon-btn" id="aiClose" aria-label="Close">✕</button>
    </header>

    <div class="ai-upsell" id="aiUpsell" hidden>
      <div><b>AI Song comes with ${esc(NEED_PLAN.name)}.</b><span>${PER_MONTH} full songs a month, written, sung and played for you. Change any part and make it again. $${NEED_PLAN.price} a month, nothing bills on its own.</span></div>
      <button type="button" class="btn pro" id="aiGetPlan">Get ${esc(NEED_PLAN.name)}</button>
    </div>

    <section class="ai-view" data-view="create">
      <label class="ai-field"><span>What is the song about?</span>
        <textarea id="aiAbout" rows="3" maxlength="1200" placeholder="Coming up from nothing, staying loyal to the ones who believed, and turning every negative into a positive."></textarea>
      </label>
      <div class="ai-field"><span>Sound</span>${chips('aiGenre', GENRES, [form.genre])}</div>
      <div class="ai-field"><span>Feel <i>pick up to two</i></span>${chips('aiMood', MOODS, form.moods)}</div>
      <div class="ai-grid">
        <div class="ai-field"><span>Voice</span>${chips('aiVoice', VOICES, [form.voice])}</div>
        <div class="ai-field"><span>Length</span>${chips('aiLength', LENGTHS.map((s) => ({ id: String(s), label: clock(s) })), [String(form.seconds)])}</div>
      </div>
      <div class="ai-field" id="aiLyricsField"><span>Words</span>
        ${chips('aiLyricsMode', [{ id: 'ai', label: 'Write them for me' }, { id: 'own', label: 'Use my lyrics' }], [form.lyricsMode])}
        <textarea id="aiLyrics" rows="8" maxlength="6000" hidden placeholder="[Verse 1]&#10;Type or paste your lyrics, one line per row.&#10;&#10;[Chorus]&#10;Leave an empty row between parts."></textarea>
      </div>
      <footer class="ai-foot">
        <p class="ai-note" id="aiCreateMsg" role="status" aria-live="polite">Next you see every part and every line, and can change anything before the song is made.</p>
        <button type="button" class="btn primary big" id="aiWrite">Write my song</button>
      </footer>
    </section>

    <section class="ai-view" data-view="edit" hidden>
      <div class="ai-edit-top">
        <label class="ai-field grow"><span>Song title</span><input id="aiSongTitle" type="text" maxlength="80" autocomplete="off"></label>
        <label class="ai-field grow"><span>Sound of the whole song <i>comma between each</i></span><input id="aiStyles" type="text" maxlength="400" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="ai-parts" id="aiParts"></div>
      <button type="button" class="btn ghost small" id="aiAddPart">+ Add a part</button>
      <footer class="ai-foot">
        <p class="ai-note" id="aiEditMsg" role="status" aria-live="polite"></p>
        <div class="ai-row">
          <button type="button" class="btn ghost" id="aiBack">Start over</button>
          <button type="button" class="btn primary big" id="aiMake">Make the song</button>
        </div>
      </footer>
    </section>

    <section class="ai-view" data-view="result" hidden>
      <div class="ai-result">
        <p class="ai-eyebrow" id="aiResultMeta"></p>
        <h3 id="aiResultTitle"></h3>
        <div class="ai-player">
          <button type="button" class="ai-play" id="aiPlay" aria-label="Play"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="i-play" d="M7 4.5v15l13-7.5z"/><path class="i-pause" d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg></button>
          <canvas id="aiWave" aria-hidden="true"></canvas>
          <span class="ai-time" id="aiTime">0:00 / 0:00</span>
        </div>
        <div class="ai-actions">
          <button type="button" class="ai-act lead" id="aiSplit"><b>Open with vocal and music apart</b><span>The vocal lands on a vocal track and the music on the beat track, so you can tune, mix and re-record either one.</span></button>
          <button type="button" class="ai-act" id="aiOpen"><b>Open in the studio</b><span>The whole song as one track. Record your own vocal over it, mix and master.</span></button>
          <button type="button" class="ai-act" id="aiChange"><b>Change the song</b><span>Go back to the parts and the words, change what you want and make it again.</span></button>
          <button type="button" class="ai-act" id="aiDownload"><b>Download MP3</b><span>Save the song as it is.</span></button>
        </div>
        <p class="ai-note" id="aiResultMsg" role="status" aria-live="polite"></p>
      </div>
    </section>

    <section class="ai-view" data-view="library" hidden>
      <div class="ai-lib" id="aiLib"></div>
    </section>

    <div class="ai-busy" id="aiBusy" hidden>
      <div class="ai-bars" aria-hidden="true">${'<i></i>'.repeat(9)}</div>
      <p class="ai-busy-title" id="aiBusyTitle"></p>
      <p class="ai-busy-sub" id="aiBusySub"></p>
    </div>
    <p class="ai-legal">Songs are original to you. Describe the sound you want; real artists, bands and existing songs cannot be named. Contact: ${esc(cfg.CONTACT_EMAIL || 'hsw365media@gmail.com')}</p>
  </dialog>`);
  document.body.append(dlg);

  $('aiClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', stopPlayer);
  dlg.addEventListener('cancel', (e) => { if (busy) e.preventDefault(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && !busy) dlg.close(); });
  dlg.querySelectorAll('.ai-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab === 'library' ? 'library' : song && song.blob ? 'result' : song ? 'edit' : 'create')));
  $('aiGetPlan').addEventListener('click', () => openPro('AI Song', NEED));

  const single = (id, key, map = (v) => v) => $(id).addEventListener('click', (e) => {
    const b = e.target.closest('.ai-chip'); if (!b) return;
    form[key] = map(b.dataset.v);
    $(id).querySelectorAll('.ai-chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    paintCreate();
  });
  single('aiGenre', 'genre'); single('aiVoice', 'voice'); single('aiLength', 'seconds', Number); single('aiLyricsMode', 'lyricsMode');
  $('aiMood').addEventListener('click', (e) => {
    const b = e.target.closest('.ai-chip'); if (!b) return;
    const v = b.dataset.v, i = form.moods.indexOf(v);
    if (i >= 0) form.moods.splice(i, 1); else { form.moods.push(v); if (form.moods.length > 2) form.moods.shift(); }
    $('aiMood').querySelectorAll('.ai-chip').forEach((x) => x.setAttribute('aria-pressed', String(form.moods.includes(x.dataset.v))));
  });
  $('aiAbout').addEventListener('input', (e) => { form.about = e.target.value; });
  $('aiLyrics').addEventListener('input', (e) => { form.lyrics = e.target.value; });
  $('aiWrite').addEventListener('click', writeSong);

  $('aiSongTitle').addEventListener('input', (e) => { song.title = e.target.value; });
  $('aiStyles').addEventListener('change', (e) => { song.plan.positive_global_styles = e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 16); });
  $('aiAddPart').addEventListener('click', () => { song.plan.sections.push({ section_name: 'New part', positive_local_styles: [], negative_local_styles: [], duration_ms: 20000, lines: [] }); paintParts(); });
  $('aiParts').addEventListener('input', onPartInput);
  $('aiParts').addEventListener('click', onPartClick);
  $('aiBack').addEventListener('click', () => { if (confirm('Start over? The parts and words on this page will be cleared.')) { song = null; show('create'); } });
  $('aiMake').addEventListener('click', makeSong);

  $('aiOpen').addEventListener('click', openWhole);
  $('aiSplit').addEventListener('click', openSplit);
  $('aiChange').addEventListener('click', () => show('edit'));
  $('aiDownload').addEventListener('click', () => {
    const a = document.createElement('a'), url = URL.createObjectURL(song.blob);
    a.href = url; a.download = `${fileName(song.title)}.mp3`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  });
  $('aiLib').addEventListener('click', onLibClick);
  paintCreate();
}
const fileName = (t) => (String(t || 'song').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'song').slice(0, 60);

function setBusy(title, sub = '') {
  busy = !!title;
  $('aiBusy').hidden = !busy;
  $('aiBusyTitle').textContent = title || ''; $('aiBusySub').textContent = sub;
  dlg.classList.toggle('is-busy', busy);
}
function say(id, text, tone = '') { const el = $(id); el.textContent = text; el.className = 'ai-note' + (tone ? ' ' + tone : ''); }

function paintMeter() {
  if (!dlg) return;
  const m = $('aiMeter'), member = hasPlan(NEED);
  $('aiUpsell').hidden = member;
  if (!member) { m.textContent = `${NEED_PLAN.name} plan`; m.className = 'ai-meter locked'; return; }
  if (!stand) { m.textContent = ''; return; }
  m.className = 'ai-meter' + (!stand.unlimited && stand.songsLeft === 0 ? ' out' : '');
  m.textContent = stand.unlimited ? 'Owner access' : `${String(stand.songsLeft).padStart(2, '0')} / ${String(stand.songsLimit).padStart(2, '0')} songs left`;
}
function paintCreate() {
  const own = form.lyricsMode === 'own', inst = form.voice === 'none';
  $('aiLyricsField').hidden = inst;
  $('aiLyrics').hidden = !own;
  $('aiWrite').textContent = own && !inst ? 'Set up my song' : 'Write my song';
}

function show(v) {
  view = v;
  dlg.querySelectorAll('.ai-view').forEach((s) => { s.hidden = s.dataset.view !== v; });
  dlg.querySelectorAll('.ai-tabs button').forEach((b) => b.setAttribute('aria-selected', String((b.dataset.tab === 'library') === (v === 'library'))));
  if (v !== 'result') stopPlayer();
  if (v === 'edit') paintEdit();
  if (v === 'result') paintResult();
  if (v === 'library') paintLibrary();
  dlg.scrollTop = 0;
}

// ------------------------------------------------------------------ step 1: write
function gate() {
  if (hasPlan(NEED)) return true;
  openPro('AI Song', NEED);
  return false;
}
function explain(err, id) {
  if (err.code === 'plan_too_low' || err.code === 'no_key' || err.code === 'expired' || err.code === 'bad_key') { openPro('AI Song', NEED); say(id, err.message, 'err'); return; }
  say(id, err.suggestion ? `${err.message} Try: "${err.suggestion}"` : err.message, 'err');
}

async function writeSong() {
  if (busy) return;
  const inst = form.voice === 'none', own = form.lyricsMode === 'own' && !inst;
  if (own ? form.lyrics.trim().length < 20 : form.about.trim().length < 8) {
    say('aiCreateMsg', own ? 'Paste or type your lyrics first.' : 'Say a little more about what the song is about.', 'err');
    (own ? $('aiLyrics') : $('aiAbout')).focus(); return;
  }
  if (!gate()) return;
  const max = (stand && stand.maxSeconds) || 240;
  try {
    let plan;
    if (own) plan = planFromLyrics(form.lyrics, globalStyles(), max);
    else {
      setBusy('Writing your song', 'Laying out the parts and the words.');
      plan = (await call('plan', { body: { prompt: promptText(), seconds: Math.min(form.seconds, max) } })).songPlan;
      if (!plan || !plan.sections || !plan.sections.length) throw new AiError({ message: 'The song came back empty. Try describing it a different way.' }, 500);
      const have = plan.positive_global_styles.map((s) => s.toLowerCase());
      for (const s of globalStyles().slice(0, -1)) if (!have.some((x) => x.includes(s))) plan.positive_global_styles.unshift(s);
      if (inst) { plan.sections.forEach((s) => { s.lines = []; }); plan.negative_global_styles = [...new Set([...(plan.negative_global_styles || []), 'vocals', 'singing'])]; }
    }
    song = { id: uid(), title: titleFrom(own ? form.lyrics.replace(/\[.*?\]/g, '') : form.about), plan, blob: null, seconds: 0, created: Date.now(), peaks: null };
    say('aiCreateMsg', 'Next you see every part and every line, and can change anything before the song is made.');
    setBusy(''); show('edit');
  } catch (err) { setBusy(''); explain(err, 'aiCreateMsg'); }
}

// ------------------------------------------------------------------ step 2: edit
function paintEdit() {
  $('aiSongTitle').value = song.title;
  $('aiStyles').value = song.plan.positive_global_styles.join(', ');
  $('aiMake').textContent = song.blob ? 'Make it again' : 'Make the song';
  paintParts();
}
function paintParts() {
  const S = song.plan.sections;
  $('aiParts').innerHTML = S.map((s, i) => `
    <article class="ai-part" data-i="${i}">
      <header>
        <span class="ai-num">${String(i + 1).padStart(2, '0')}</span>
        <input class="ai-part-name" data-f="name" type="text" maxlength="100" value="${esc(s.section_name)}" aria-label="Part name">
        <div class="ai-len" title="How long this part runs">
          <button type="button" data-a="less" aria-label="Shorter">&minus;</button>
          <output>${clock(s.duration_ms / 1000)}</output>
          <button type="button" data-a="more" aria-label="Longer">+</button>
        </div>
        <div class="ai-part-tools">
          <button type="button" data-a="up" aria-label="Move up" ${i ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 14l6-6 6 6"/></svg></button>
          <button type="button" data-a="down" aria-label="Move down" ${i < S.length - 1 ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10l6 6 6-6"/></svg></button>
          <button type="button" data-a="dup" aria-label="Repeat this part"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/></svg></button>
          <button type="button" data-a="del" aria-label="Remove this part" ${S.length > 1 ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/></svg></button>
        </div>
      </header>
      <textarea data-f="lines" rows="${Math.min(10, Math.max(2, s.lines.length + 1))}" maxlength="6200" placeholder="No words in this part. Music only. Type lines here to add a vocal." aria-label="Words for ${esc(s.section_name)}">${esc(s.lines.join('\n'))}</textarea>
      <input class="ai-part-style" data-f="style" type="text" maxlength="300" value="${esc(s.positive_local_styles.join(', '))}" placeholder="Sound of this part, for example: stripped back, big drums, choir" aria-label="Sound of this part" spellcheck="false">
    </article>`).join('');
  paintTotal();
}
function paintTotal() {
  const total = planSeconds(song.plan), max = (stand && stand.maxSeconds) || 240, over = total > max + 0.5;
  const left = stand && !stand.unlimited ? ` Uses 1 of your ${stand.songsLeft} songs left this month.` : '';
  say('aiEditMsg', over ? `The song runs ${clock(total)}. The longest is ${clock(max)}. Shorten or remove a part.` : `${song.plan.sections.length} parts, ${clock(total)} long.${left}`, over ? 'err' : '');
  $('aiMake').disabled = over || (stand && !stand.unlimited && stand.songsLeft <= 0);
  if (stand && !stand.unlimited && stand.songsLeft <= 0) say('aiEditMsg', `You have made all ${stand.songsLimit} of this month's songs. More arrive on the 1st.`, 'err');
}
function onPartInput(e) {
  const card = e.target.closest('.ai-part'); if (!card) return;
  const s = song.plan.sections[Number(card.dataset.i)], f = e.target.dataset.f;
  if (f === 'name') s.section_name = e.target.value.slice(0, 100);
  if (f === 'lines') s.lines = e.target.value.split('\n').map((l) => l.trim().slice(0, 200)).filter(Boolean).slice(0, 30);
  if (f === 'style') s.positive_local_styles = e.target.value.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
}
function onPartClick(e) {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  const S = song.plan.sections, i = Number(b.closest('.ai-part').dataset.i), s = S[i], a = b.dataset.a;
  if (a === 'less' || a === 'more') {
    s.duration_ms = Math.min(SEC_MAX, Math.max(SEC_MIN, Math.round(s.duration_ms / 1000) + (a === 'more' ? 2 : -2))) * 1000;
    b.parentElement.querySelector('output').textContent = clock(s.duration_ms / 1000); paintTotal(); return;
  }
  if (a === 'up' && i) [S[i - 1], S[i]] = [S[i], S[i - 1]];
  if (a === 'down' && i < S.length - 1) [S[i + 1], S[i]] = [S[i], S[i + 1]];
  if (a === 'dup') S.splice(i + 1, 0, JSON.parse(JSON.stringify(s)));
  if (a === 'del' && S.length > 1) S.splice(i, 1);
  paintParts();
}

// ------------------------------------------------------------------ step 3: make
async function makeSong() {
  if (busy || !gate()) return;
  song.title = ($('aiSongTitle').value || '').trim() || 'New song';
  song.plan.positive_global_styles = $('aiStyles').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 16);
  const total = planSeconds(song.plan);
  setBusy('Making your song', `Playing and singing ${clock(total)} of music. This takes a minute or two. Keep this page open.`);
  try {
    const buf = await call('compose', { body: { songPlan: song.plan, title: song.title } });
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const { peaks, seconds } = await peaksOf(blob);
    song = { ...song, id: uid(), blob, peaks, seconds: seconds || total, created: Date.now(), stems: null };
    await saveSong(song);
    setBusy(''); show('result');
  } catch (err) { setBusy(''); explain(err, 'aiEditMsg'); if (err.planSuggestion && confirm('The music model suggested a version of this song it can make. Use its version?')) { song.plan = err.planSuggestion; paintEdit(); } }
}

function paintResult() {
  $('aiResultTitle').textContent = song.title;
  $('aiResultMeta').textContent = `${clock(song.seconds)} · ${song.plan.sections.length} parts · saved in My songs`;
  const vocal = song.plan.sections.some((s) => s.lines.length);
  $('aiSplit').hidden = !vocal;
  $('aiOpen').classList.toggle('lead', !vocal);
  say('aiResultMsg', '');
  mountPlayer(song);
}

// ------------------------------------------------------------------ into the studio
const asFile = (bytes, name) => new File([bytes], name, { type: 'audio/mpeg' });
function okToReplace() { return !host.hasAudio() || confirm('This session already has audio in it. Put the song in a new session?\n\nOK opens a new session. Cancel keeps you here.'); }

async function openWhole() {
  if (busy || !okToReplace()) return;
  stopPlayer();
  setBusy('Opening in the studio', 'Loading the song onto the beat track.');
  try { await host.openSong({ title: song.title, music: asFile(song.blob, `${fileName(song.title)}.mp3`), vocal: null }); setBusy(''); dlg.close(); }
  catch (err) { setBusy(''); say('aiResultMsg', err.message, 'err'); mountPlayer(song); }
}
async function openSplit() {
  if (busy || !gate() || !okToReplace()) return;
  stopPlayer();
  setBusy('Taking the vocal off the music', 'About a minute. Keep this page open.');
  try {
    if (!song.stems) {
      const files = await unzip(await call('stems', { bytes: await song.blob.arrayBuffer() }));
      const vocal = files.find((f) => /vocal|voice/i.test(f.name)), music = files.find((f) => f !== vocal && /\.(mp3|wav|flac|m4a|ogg)$/i.test(f.name));
      if (!vocal || !music) throw new Error('The split came back incomplete. Try again.');
      song.stems = { vocal: vocal.bytes, music: music.bytes, ext: (music.name.match(/\.(\w+)$/) || [0, 'mp3'])[1] };
    }
    setBusy('Opening in the studio', 'Vocal to a vocal track, music to the beat track.');
    const n = fileName(song.title), x = song.stems.ext;
    await host.openSong({ title: song.title, music: asFile(song.stems.music, `${n} (music).${x}`), vocal: asFile(song.stems.vocal, `${n} (vocal).${x}`) });
    setBusy(''); dlg.close();
  } catch (err) { setBusy(''); if (err instanceof AiError) explain(err, 'aiResultMsg'); else say('aiResultMsg', err.message, 'err'); mountPlayer(song); }
}

// ------------------------------------------------------------------ my songs
let lib = [];
async function paintLibrary() {
  lib = await listSongs();
  $('aiLib').innerHTML = lib.length ? lib.map((s) => `
    <article class="ai-song" data-id="${esc(s.id)}">
      <div><b>${esc(s.title)}</b><span>${clock(s.seconds || 0)} · ${new Date(s.created).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
      <button type="button" class="btn ghost small" data-a="open">Open</button>
      <button type="button" class="ai-x" data-a="del" aria-label="Delete ${esc(s.title)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4.5h4V7M7 7l1 12.5h8L17 7"/></svg></button>
    </article>`).join('')
    : `<div class="ai-empty"><b>No songs yet</b><span>Every song you make is kept here on this device, with its parts and words, so you can come back and change it.</span><button type="button" class="btn primary" data-a="new">Make your first song</button></div>`;
}
async function onLibClick(e) {
  const b = e.target.closest('button[data-a]'); if (!b) return;
  if (b.dataset.a === 'new') { show(song ? 'edit' : 'create'); return; }
  const id = b.closest('.ai-song').dataset.id, s = lib.find((x) => x.id === id);
  if (b.dataset.a === 'open' && s) { song = { ...s, stems: null }; show('result'); }
  if (b.dataset.a === 'del' && s && confirm(`Delete "${s.title}" from this device?`)) { await dropSong(id); if (song && song.id === id) song = null; paintLibrary(); }
}

// ------------------------------------------------------------------ public
// host: { hasAudio(): boolean, openSong({ title, music: File, vocal: File|null }): Promise }
export function initAiSong(h0) { host = h0; }

export function openAiSong() {
  if (!dlg) build();
  paintMeter();
  if (!dlg.open) dlg.showModal();
  show(view === 'library' ? 'library' : song && song.blob ? 'result' : song ? 'edit' : 'create');
  if (hasPlan(NEED) && API) call('status').catch(() => {});
}
// The plan changed (a key was turned on or removed) while the page is open.
export function refreshAiSong() { stand = null; paintMeter(); if (dlg && dlg.open && hasPlan(NEED) && API) call('status').catch(() => {}); }
