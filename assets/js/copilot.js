// HSW365studio Mix AI: talk to the mix. Type or say what you want ("more air", "remove the reverb and delay",
// "make it dark and wide"), ask what it hears, or let it mix the vocal for you. Everything runs in the browser:
// no keys, no server, no per-use cost. It moves the same controls you can see on the Tune and Mix tabs, so every
// change is yours to adjust afterwards, and every change can be undone or compared against where you started.
import { compFromMacro, DEFAULT_MIX, DELAY_NOTES } from './mixer.js';
import { vocalBeatBalance } from './check.js';
import * as D from './dsp.js';

// ------------------------------------------------------------------ what can move, and how far
const RANGE = {
  vocalDb: [-24, 12], beatDb: [-24, 6], hpf: [40, 300], lpf: [2500, 20000],
  body: [-12, 12], mud: [-12, 12], presence: [-12, 12], air: [-12, 12],
  sibilance: [0, 10], gate: [0, 100], warmth: [0, 100], reverb: [0, 100], delay: [0, 100], glue: [0, 100],
  revDecay: [0.4, 6], revTone: [1500, 16000], delayFb: [0, 85], delayTone: [800, 12000], delayWide: [0, 100],
};
const NAMES = {
  vocalDb: 'Vocal level', beatDb: 'Beat level', hpf: 'Low cut', lpf: 'High cut', body: 'Low end', mud: 'Mud', presence: 'Presence', air: 'Air',
  sibilance: 'De-esser', gate: 'Noise gate', warmth: 'Warmth', reverb: 'Reverb', delay: 'Echo', glue: 'Glue', comp: 'Compression',
  revDecay: 'Reverb length', revTone: 'Reverb brightness', delayFb: 'Echo repeats', delayTone: 'Echo brightness', delayWide: 'Echo width',
};
const DB_KEYS = new Set(['vocalDb', 'beatDb', 'body', 'mud', 'presence', 'air']);
const clamp = (v, [a, b]) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const clone = (o) => JSON.parse(JSON.stringify(o));
const fmt = (k, v) => {
  if (DB_KEYS.has(k)) return `${v > 0 ? '+' : ''}${r1(v)} dB`;
  if (k === 'sibilance') return v ? `-${r1(v)} dB` : 'off';
  if (k === 'hpf' || k === 'lpf') return v >= 1000 ? `${r1(v / 1000)} kHz` : `${Math.round(v)} Hz`;
  if (k === 'revDecay') return `${r1(v)} s`;
  return v === 0 ? 'off' : `${Math.round(v)}%`;
};

// ------------------------------------------------------------------ sounds
// Starting points for a whole chain. Plain settings: nothing here copies anyone's voice, and every value stays
// adjustable. The names people say ("sound like …") point at the closest one.
export const STYLES = [
  {
    id: 'melodic', name: 'Melodic trap', about: 'Fast tuning you can hear, bright top, wide echoes and a soft third above.',
    aka: ['travis scott', 'future', 'don toliver', 'lil uzi', 'juice wrld', 'young thug', 'lil durk'],
    tune: { speedMs: 8, amount: 100, keepVibrato: 15, humanize: 10 },
    mix: { hpf: 110, body: 1, mud: -2, presence: 3.5, air: 4.5, sibilance: 4.5, comp: 68, warmth: 30, reverb: 26, delay: 24, delayNote: '1/8d', delayFb: 38, delayWide: 40, glue: 40 },
    stack: { double: 55, harmony: 'thirdUp', harmonyLevel: 30 },
  },
  {
    id: 'demon', name: 'Demon voice', about: 'Deep, dark and heavy: lowered voice character, rolled-off top, a growl of warmth and an octave below.',
    aka: ['yeat', 'demon', 'monster', 'villain', 'evil'],
    tune: { speedMs: 6, amount: 100, keepVibrato: 10, formant: -3.5 },
    mix: { hpf: 90, body: 3, mud: -3, presence: 2, air: -2, lpf: 11000, sibilance: 5, comp: 78, warmth: 60, reverb: 22, revTone: 4200, revDecay: 3, delay: 20, delayTone: 2600, delayWide: 50, glue: 45 },
    stack: { double: 60, harmony: 'octaveDown', harmonyLevel: 40 },
  },
  {
    id: 'dryrap', name: 'Close and dry rap', about: 'In your face: forward mids, tight dynamics, almost no space.',
    aka: ['drake', 'kendrick', 'j cole', 'lil baby', '21 savage', 'nba youngboy', 'gunna', 'rap'],
    tune: { speedMs: 22, amount: 90, keepVibrato: 35 },
    mix: { hpf: 110, body: 1.5, mud: -2.5, presence: 4, air: 2.5, sibilance: 4.5, comp: 78, warmth: 25, reverb: 8, delay: 6, gate: 15, glue: 35 },
    stack: { double: 30, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'rnb', name: 'Smooth R&B', about: 'Silky and airy with the vibrato kept, a long room and a soft third above.',
    aka: ['the weeknd', 'weeknd', 'bruno mars', 'sza', 'frank ocean', 'usher', 'chris brown', 'r&b', 'rnb'],
    tune: { speedMs: 60, amount: 85, keepVibrato: 80 },
    mix: { hpf: 85, body: 1.5, mud: -1.5, presence: 1.5, air: 5.5, sibilance: 4.5, comp: 50, warmth: 18, reverb: 34, delay: 10, glue: 30 },
    stack: { double: 25, harmony: 'thirdUp', harmonyLevel: 35 },
  },
  {
    id: 'pop', name: 'Polished pop', about: 'Present and glossy, tuned so it sounds right without sounding tuned.',
    aka: ['ariana grande', 'ariana', 'dua lipa', 'taylor swift', 'justin bieber', 'doja cat', 'pop', 'radio'],
    tune: { speedMs: 28, amount: 95, keepVibrato: 45 },
    mix: { hpf: 100, body: 0.5, mud: -2, presence: 3.5, air: 4.5, sibilance: 5, comp: 72, warmth: 15, reverb: 18, delay: 10, gate: 10, glue: 40 },
    stack: { double: 30, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'whisper', name: 'Intimate whisper', about: 'Close, breathy and quiet-loud: heavy leveling, lots of air, wide doubles.',
    aka: ['billie eilish', 'billie', 'lorde', 'asmr', 'whisper', 'breathy'],
    tune: { speedMs: 70, amount: 50, keepVibrato: 80 },
    mix: { hpf: 120, body: 2.5, mud: -2, presence: 1, air: 6, sibilance: 6, comp: 85, warmth: 20, reverb: 12, delay: 4, gate: 25, glue: 30 },
    stack: { double: 40, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'hook', name: 'Stadium hook', about: 'A wall of voices: wide doubles, a third above and a big room.',
    aka: ['stadium', 'anthem', 'chorus', 'big hook'],
    tune: { speedMs: 10, amount: 100, keepVibrato: 25 },
    mix: { hpf: 110, body: 0, presence: 3, air: 4.5, sibilance: 4.5, comp: 65, warmth: 22, reverb: 30, delay: 16, glue: 40 },
    stack: { double: 75, harmony: 'thirdUp', harmonyLevel: 55 },
  },
  {
    id: 'robot', name: 'Robot (hard tune)', about: 'Instant, robotic snapping to every note, with a bouncing echo.',
    aka: ['t-pain', 't pain', 'robot', 'robotic', 'cher'],
    tune: { speedMs: 0, amount: 100, keepVibrato: 0 },
    mix: { hpf: 120, body: -1.5, presence: 4, air: 5, sibilance: 5, comp: 70, warmth: 25, reverb: 24, delay: 22, delayWide: 35 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'lofi', name: 'Lo-fi tape', about: 'Warm and worn: rolled-off top, heavy saturation, no shine.',
    aka: ['lo-fi', 'lofi', 'lo fi', 'tape', 'vintage', 'old school'],
    tune: { speedMs: 70, amount: 60, keepVibrato: 85 },
    mix: { hpf: 140, body: 2.5, presence: 0, air: -4, lpf: 9000, sibilance: 2, comp: 55, warmth: 75, reverb: 22, delay: 14 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'phone', name: 'Telephone', about: 'Thin, boxed and bright: only the middle of the voice gets through.',
    aka: ['telephone', 'phone', 'walkie', 'megaphone', 'intercom'],
    tune: { enabled: false },
    mix: { hpf: 300, lpf: 3400, body: -6, mud: 0, presence: 5, air: -6, sibilance: 3, comp: 85, warmth: 55, reverb: 0, delay: 0 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
  {
    id: 'narrator', name: 'Deep narrator', about: 'Big and calm: lowered voice character, chest, steady level, no tuning.',
    aka: ['narrator', 'trailer', 'announcer', 'movie voice', 'deep voice'],
    tune: { enabled: false, formant: -2.5 },
    mix: { hpf: 80, body: 4, mud: -2, presence: 2.5, air: 1, sibilance: 5, comp: 80, warmth: 30, reverb: 14, delay: 0, glue: 30 },
    stack: { double: 0, harmony: 'off', harmonyLevel: 40 },
  },
];

// What the voice is for. It sets where the vocal sits before you change anything else.
export const ROLES = {
  lead: { label: 'Lead vocal', about: 'Up front and clear.', mix: { hpf: 90, presence: 2, reverb: 16, delay: 8, comp: 55 } },
  rap: { label: 'Rap verse', about: 'Dry, forward and tight.', mix: { hpf: 110, presence: 3.5, mud: -2.5, reverb: 8, delay: 6, comp: 75, gate: 12 } },
  adlib: { label: 'Ad-libs', about: 'Washed in space so it sits behind the lead.', mix: { hpf: 170, body: -2, presence: 2.5, air: 4, reverb: 34, delay: 30, comp: 60 } },
  backing: { label: 'Backing vocals', about: 'Soft and wide, tucked under the lead.', mix: { hpf: 150, body: -1, presence: 0, air: 3, sibilance: 5, reverb: 30, delay: 12, comp: 65 } },
  spoken: { label: 'Spoken word', about: 'Even and clear, no tuning.', mix: { hpf: 80, body: 1, presence: 2.5, reverb: 0, delay: 0, comp: 68, gate: 30 }, tune: { enabled: false } },
};

// The chain, in signal order, with what "bypassed" means for each piece.
const CHAIN = [
  { id: 'gate', name: 'Noise gate', sub: 'Quiets the room between words', keys: { gate: 0 }, goto: 'mix' },
  { id: 'tune', name: 'Pitch correction', sub: 'Tunes to the key', tune: { enabled: false }, goto: 'tune' },
  { id: 'hpf', name: 'Low cut', sub: 'Removes rumble and plosives', keys: { hpf: 40 }, goto: 'mix' },
  { id: 'eq', name: 'Tone EQ', sub: 'Low end, mud, presence, air', keys: { body: 0, mud: 0, presence: 0, air: 0 }, goto: 'mix' },
  { id: 'comp', name: 'Compressor', sub: 'Evens the level out', keys: { compOn: false }, goto: 'mix' },
  { id: 'deess', name: 'De-esser', sub: 'Softens harsh S sounds', keys: { sibilance: 0 }, goto: 'mix' },
  { id: 'warmth', name: 'Warmth', sub: 'Saturation and weight', keys: { warmth: 0 }, goto: 'mix' },
  { id: 'space', name: 'Reverb and echo', sub: 'Room and repeats', keys: { reverb: 0, delay: 0 }, goto: 'mix' },
  { id: 'stack', name: 'Doubles and harmony', sub: 'Extra voices behind the lead', stack: { double: 0, harmony: 'off' }, goto: 'stack' },
  { id: 'glue', name: 'Bus glue', sub: 'Holds vocal and beat together', keys: { glue: 0 }, goto: 'mix' },
];

const QUICK = [
  { label: 'What do you hear?', say: 'what do you hear' },
  { label: 'Fix it', say: 'auto mix' },
  { label: 'More air', say: 'more air' },
  { label: 'Make it sound like Drake', say: 'make me sound like drake' },
  { label: 'Remove the reverb and delay', say: 'remove the reverb and delay' },
  { label: 'Add the demon effect', say: 'add the demon effect' },
  { label: 'Hard tune', say: 'hard tune' },
];

// ------------------------------------------------------------------ understanding what you typed
const AMT_BIG = /\b(a lot|way|much|super|very|really|hella|so much|waaay|insanely|heavily)\b/;
const AMT_SMALL = /\b(a little|a bit|slightly|touch|tad|bit|barely|subtly|just a)\b/;
const GO_UP = /\b(more|add|increase|boost|raise|up|bring up|extra|louder|higher|bigger|wetter|fuller|thicker|stronger|heavier|crank|push|lift|plus)\b/;
const GO_DOWN = /\b(less|reduce|lower|decrease|cut|down|bring down|tame|quieter|softer|dryer|drier|thinner|smaller|lighter|fewer|pull|turn down|back off|ease)\b/;
const GO_ZERO = /\b(remove|kill|no|without|get rid of|turn off|take off|take out|none|zero|off|delete|strip)\b/;

// Each target: the words for the control itself, words that already carry a direction, and how to move it.
const TARGETS = [
  { id: 'air', noun: /\b(air|highs?|top end|sparkle|shimmer|sheen|treble)\b/, up: /\b(bright(er)?|airy|airier|crisp(er)?|sparkly|shimmery|open(er)?)\b/, down: /\b(dull|dark(er)?|muffled|dim)\b/, moves: [['air', 2.5]] },
  { id: 'presence', noun: /\b(presence|clarity|forward|upfront|up front|intelligib\w*|cut through|diction)\b/, up: /\b(clear(er)?|present|in your face|forward)\b/, down: /\b(buried|back|distant|far)\b/, moves: [['presence', 2]] },
  { id: 'body', noun: /\b(body|bass|low end|lows?|weight|chest|bottom)\b/, up: /\b(full(er)?|thick(er)?|heavy|heavier|deep(er)?|big(ger)?)\b/, down: /\b(thin(ner)?|boomy|boom|bassy)\b/, moves: [['body', 2]] },
  { id: 'mud', noun: /\b(mud|muddy|boxy|box|cloudy|honk\w*|nasal)\b/, up: null, down: null, moves: [['mud', 2.5]], always: -1 },
  { id: 'sib', noun: /\b(harsh|sibilan\w*|sss+|de-?ess\w*|s sounds?|essy|sharp|piercing|spitty)\b/, up: null, down: null, moves: [['sibilance', 1.5]], always: 1 },
  { id: 'reverb', noun: /\b(reverb|room|hall|space|spacey|wet|ambien\w*|verb)\b/, up: null, down: /\b(dry|drier|dryer)\b/, moves: [['reverb', 12]] },
  { id: 'delay', noun: /\b(delay|echo(es)?|slap|repeats|ping ?pong)\b/, up: null, down: null, moves: [['delay', 10]] },
  { id: 'warmth', noun: /\b(warmth|saturation|grit|gritty|dirty|dirt|analog|tape|crunch|distort\w*|drive)\b/, up: /\b(warm(er)?)\b/, down: /\b(clean(er)?|pristine)\b/, moves: [['warmth', 15]] },
  { id: 'gate', noun: /\b(noise|hiss|background|room noise|gate|hum|static)\b/, up: null, down: null, moves: [['gate', 15]], always: 1 },
  { id: 'comp', noun: /\b(compress\w*|tighter|tight|level(ed|ing)?|even(er)?|consistent|steady|dynamics?|punch\w*|squash\w*)\b/, up: null, down: /\b(breathe|breathing|dynamic)\b/, moves: [['comp', 12]] },
  { id: 'glue', noun: /\b(glue|cohesive|together|bus)\b/, up: null, down: null, moves: [['glue', 15]] },
  { id: 'vocalDb', noun: /\b(vocals?|voice|me) (level|volume)\b|\bturn (me|my vocals?|the vocals?|the voice) (up|down)\b|\b(louder|quieter) (vocals?|voice)\b|\b(vocals?|voice) (louder|quieter)\b|\bmake me (louder|quieter)\b/, up: null, down: null, moves: [['vocalDb', 2]], level: true },
  { id: 'beatDb', noun: /\b(beat|instrumental|music)\b/, up: null, down: null, moves: [['beatDb', 2]], level: true },
];

function parseKey(text) {
  const m = text.match(/\b(?:key (?:of |to )?|(?:to|in) )([a-g])\s?(#|sharp|flat|b(?![a-z]))?\s*(major|maj|minor|min|m)?\b/);
  if (!m) return null;
  if (!m[3] && !/\bkey\b/.test(text)) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1]];
  const acc = m[2] === '#' || m[2] === 'sharp' ? 1 : m[2] === 'b' || m[2] === 'flat' ? -1 : 0;
  const q = m[3] ? (/^maj/.test(m[3]) ? 'major' : 'minor') : null;
  return { root: (base + acc + 12) % 12, scale: q };
}

function findStyle(text) {
  let best = null, bl = 0;
  for (const s of STYLES) {
    for (const a of [...s.aka, s.name.toLowerCase()]) {
      const re = new RegExp(`(^|[^a-z])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
      if (re.test(text) && a.length > bl) { best = s; bl = a.length; }
    }
  }
  return best;
}

// text -> { actions, say } . Actions are plain objects the panel then applies.
export function interpret(raw) {
  const text = ` ${String(raw || '').toLowerCase().replace(/[“”"']/g, (c) => (c === "'" ? "'" : '')).replace(/\s+/g, ' ').trim()} `.trim();
  const t = text;
  if (!t) return { actions: [] };
  const has = (re) => re.test(t);

  if (has(/^(undo|go back|revert|take that back|undo that)\b/)) return { actions: [{ op: 'undo' }] };
  if (has(/^(redo|put it back|bring it back)\b/)) return { actions: [{ op: 'redo' }] };
  if (has(/\b(compare|a\/b|a b|before and after|original)\b/)) return { actions: [{ op: 'compare' }] };
  if (has(/\b(reset|start over|clear (it )?all|back to (default|stock|start|zero)|wipe)\b/)) return { actions: [{ op: 'reset' }] };
  if (has(/\b(what do you hear|what'?s wrong|analy[sz]e|listen to|check (my|the|this) (vocal|mix|voice)|how does (it|this|that) sound|any (issues|problems)|feedback|diagnos\w*)\b/)) return { actions: [{ op: 'analyze' }] };
  if (has(/\b(auto ?-?mix|mix (it|this|my (vocal|voice|song)) for me|fix (it|my vocal|my voice|everything|this|the mix)|do your (thing|magic)|polish|make it (sound )?(good|better|professional|ready|clean|radio|release)|finish (it|this))\b/)) return { actions: [{ op: 'auto' }] };
  if (has(/\b(read|detect|find|get|what'?s|analy[sz]e|check)\b.*\b(key|tempo|bpm)\b/) && !has(/\bset\b/)) return { actions: [{ op: 'detect' }] };

  const actions = [];

  // role
  const role = t.match(/\b(?:this is|treat (?:this|it) as|set (?:the )?role|role)\b.*?\b(lead|rap|ad-?libs?|backing|harmon\w+|spoken|podcast)\b/);
  if (role) {
    const r = /rap/.test(role[1]) ? 'rap' : /ad/.test(role[1]) ? 'adlib' : /back|harm/.test(role[1]) ? 'backing' : /spoken|podcast/.test(role[1]) ? 'spoken' : 'lead';
    actions.push({ op: 'role', id: r });
    return { actions };
  }

  // key
  if (has(/\b(key|tune (it )?to|set .* to)\b/)) {
    const k = parseKey(t);
    if (k) actions.push({ op: 'key', root: k.root, scale: k.scale });
  }

  // a named sound
  const wantsStyle = has(/\b(sound(s)? like|like|style|vibe|effect|voice|preset|add the|make (it|me)|give me|turn (it|me) into)\b/);
  const style = findStyle(t);
  if (style && (wantsStyle || t.split(' ').length <= 3)) { actions.push({ op: 'style', id: style.id }); return { actions }; }

  // tuning
  if (has(/\b(hard ?-?tune|t-?pain|robot(ic)?|full auto ?-?tune|snap(ped)? (to|on) (every|the) note)\b/)) actions.push({ op: 'tune', set: { enabled: true, speedMs: 0, amount: 100, keepVibrato: 0 }, say: 'Hard tune on: every note snaps instantly.' });
  else if (has(/\b(natural|subtle|light|transparent|gentle|soft)(ly)?\b.*\b(tun\w*|pitch)\b|\b(tun\w*|pitch)\b.*\b(natural|subtle|light|transparent|gentle)\b/)) actions.push({ op: 'tune', set: { enabled: true, speedMs: 55, amount: 75, keepVibrato: 65 }, say: 'Natural tuning: gentle correction, your vibrato kept.' });
  else if (has(/\b(turn off|switch off|no|disable|remove|without|kill)\b.*\b(auto ?-?tune|tuning|pitch correction|tune)\b/)) actions.push({ op: 'tune', set: { enabled: false }, say: 'Pitch correction is off.' });
  else if (has(/\b(less)\b.*\b(auto ?-?tune|tun(ed|ing)|robotic)\b|\b(auto ?-?tune|tuning)\b.*\b(less|softer|lighter)\b/)) actions.push({ op: 'tune', rel: { speedMs: 25, amount: -15, keepVibrato: 15 }, say: 'Tuning eased off.' });
  else if (has(/\b(more)\b.*\b(auto ?-?tune|tun(ed|ing)|robotic)\b|\b(auto ?-?tune|tuning)\b.*\b(more|harder|stronger|tighter)\b/)) actions.push({ op: 'tune', rel: { speedMs: -18, amount: 12, keepVibrato: -15 }, set: { enabled: true }, say: 'Tuning pushed harder.' });
  else if (has(/\b(auto ?-?tune|tune (it|me|my vocal|the vocal|this)|pitch correct\w*|fix (my )?pitch|on key|in key|in tune)\b/)) actions.push({ op: 'tune', set: { enabled: true }, verify: true, say: 'Pitch correction on.' });

  // voice character / pitch
  const tr = t.match(/\b(?:transpose|pitch)\b.*?\b(up|down)?\s*(\d{1,2})\b/);
  if (tr) actions.push({ op: 'tune', set: { transpose: Math.max(-12, Math.min(12, (/down/.test(tr[0]) ? -1 : 1) * Number(tr[2]))) }, say: `Transposed ${/down/.test(tr[0]) ? 'down' : 'up'} ${tr[2]}.` });
  if (has(/\b(deeper|lower|darker|bigger|manlier|heavier) (voice|vocal|me)\b|\b(voice|vocal)\b.*\b(deeper|lower|darker)\b/)) actions.push({ op: 'tune', rel: { formant: -1.5 }, say: 'Voice character lowered.' });
  if (has(/\b(higher|brighter|younger|smaller|chipmunk) (voice|vocal|me)\b|\b(voice|vocal)\b.*\b(higher|younger|chipmunk)\b/)) actions.push({ op: 'tune', rel: { formant: 1.5 }, say: 'Voice character raised.' });

  // stack
  if (has(/\b(no|remove|without|kill|off)\b.*\b(doubles?|harmon\w+|stack\w*|layers?)\b/)) actions.push({ op: 'stack', set: { double: 0, harmony: 'off' }, say: 'Doubles and harmony removed.' });
  else if (has(/\b(harmon\w+)\b/)) {
    const mode = /fifth/.test(t) ? 'fifthUp' : /octave (down|below)|below an octave/.test(t) ? 'octaveDown' : /octave/.test(t) ? 'octaveUp' : /(third )?(below|under)/.test(t) ? 'thirdDown' : 'thirdUp';
    actions.push({ op: 'stack', set: { harmony: mode, harmonyLevel: 45 }, say: `Harmony on (${D.HARMONIES[mode].label.toLowerCase()}).` });
  } else if (has(/\b(doubles?|wide(r)?|thicker|stack\w*|layers?|bigger chorus|fatter)\b/) && !has(/\b(widen the echo|echo)\b/)) {
    const down = has(GO_DOWN) || has(/\b(narrow\w*|thinner)\b/);
    actions.push({ op: 'stack', rel: { double: (down ? -25 : 25) * (AMT_BIG.test(t) ? 2 : AMT_SMALL.test(t) ? 0.5 : 1) }, say: down ? 'Doubles pulled back.' : 'Doubles widened.' });
  }

  // controls, clause by clause. A bare "delay" right after "remove the reverb" inherits the "remove".
  const clauses = t.split(/\s*(?:,|;|\.|\band\b|\bthen\b|\balso\b|\bplus\b|\bbut\b|&)\s*/).filter(Boolean);
  let carry = 0;
  for (const c of clauses) {
    const mult = AMT_BIG.test(c) ? 2 : AMT_SMALL.test(c) ? 0.5 : 1;
    const dir = GO_ZERO.test(c) ? 'zero' : GO_DOWN.test(c) ? -1 : GO_UP.test(c) ? 1 : 0;
    const tooMuch = /\btoo\b/.test(c);
    for (const tg of TARGETS) {
      const noun = tg.noun.test(c);
      let d = 0;
      if (noun && tg.always) d = tg.always;                                   // "harsh", "muddy", "noisy": you name the problem, I fix it
      else if (noun && tg.level) d = dir === 'zero' ? 0 : dir;               // levels need an explicit direction
      else if (noun) d = dir || (tg.up && tg.up.test(c) ? 1 : 0) || (tg.down && tg.down.test(c) ? -1 : 0) || (tooMuch ? -1 : carry || 1);
      else if (tg.up && tg.up.test(c)) d = tooMuch ? -1 : 1;
      else if (tg.down && tg.down.test(c)) d = tooMuch ? 1 : -1;
      if (!d) continue;
      for (const [key, step] of tg.moves) actions.push({ op: 'move', target: tg.id, key, dir: d, step, mult });
    }
    if (dir !== 0) carry = dir;
  }

  // "darker" / "brighter" as a whole-sound ask
  if (!actions.some((a) => a.op === 'move' && (a.key === 'air' || a.key === 'presence')) && has(/\b(darker|warmer sound|less bright|too bright|mellow(er)?)\b/)) {
    actions.push({ op: 'move', target: 'air', key: 'air', dir: -1, step: 3, mult: 1 }, { op: 'move', target: 'presence', key: 'presence', dir: -1, step: 1.5, mult: 1 });
  }
  if (!actions.some((a) => a.op === 'move' && a.key === 'air') && has(/\b(brighter|more bright|bright(en)?)\b/) && !has(/\btoo bright\b/)) {
    actions.push({ op: 'move', target: 'air', key: 'air', dir: 1, step: 2.5, mult: 1 }, { op: 'move', target: 'presence', key: 'presence', dir: 1, step: 1.5, mult: 1 });
  }
  if (!actions.some((a) => a.op === 'move' && a.key === 'comp') && has(/\b(dynamic range|more natural)\b/)) actions.push({ op: 'move', target: 'comp', key: 'comp', dir: -1, step: 12, mult: 1 });

  // one move per control: when two clauses hit the same one, the bigger wins
  const seen = new Map();
  for (const a of [...actions]) {
    if (a.op !== 'move') continue;
    const prev = seen.get(a.key);
    if (!prev) { seen.set(a.key, a); continue; }
    if (a.step * (a.mult || 1) > prev.step * (prev.mult || 1)) { actions.splice(actions.indexOf(prev), 1); seen.set(a.key, a); } else actions.splice(actions.indexOf(a), 1);
  }

  if (!actions.length) {
    const s = findStyle(t);
    if (s) return { actions: [{ op: 'style', id: s.id }] };
  }
  return { actions };
}

// ------------------------------------------------------------------ listening to the vocal
const FRAME = 4096;
function bandsOf(x, sr) {
  const n = FRAME, win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const edges = { low: [80, 200], mud: [200, 500], mid: [500, 2000], pres: [2000, 5000], sib: [5000, 9000], air: [9000, 16000] };
  const acc = {}; Object.keys(edges).forEach((k) => { acc[k] = 0; });
  const bin = (f) => Math.max(1, Math.min(n / 2 - 1, Math.round((f * n) / sr)));
  let used = 0;
  const re = new Float32Array(n), im = new Float32Array(n);
  const hop = n * 2;
  for (let s = 0; s + n <= x.length && used < 220; s += hop) {
    let e = 0; for (let i = 0; i < n; i += 8) e += x[s + i] * x[s + i];
    if (Math.sqrt(e / (n / 8)) < 0.008) continue;            // skip silence
    for (let i = 0; i < n; i++) { re[i] = x[s + i] * win[i]; im[i] = 0; }
    D.fft(re, im);
    for (const [k, [a, b]] of Object.entries(edges)) {
      let sum = 0; const lo = bin(a), hi = bin(b);
      for (let j = lo; j <= hi; j++) sum += re[j] * re[j] + im[j] * im[j];
      acc[k] += sum / (hi - lo + 1);                         // power density, so wide and narrow bands compare fairly
    }
    used++;
  }
  if (used < 3) return null;
  const db = {}; for (const k of Object.keys(acc)) db[k] = 10 * Math.log10(acc[k] / used + 1e-18);
  return { db, frames: used };
}
function levelsOf(x, sr) {
  const f = Math.round(sr * 0.02), n = Math.floor(x.length / f), r = new Float32Array(n);
  let pk = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * f; j < (i + 1) * f; j++) { const v = x[j]; s += v * v; if (Math.abs(v) > pk) pk = Math.abs(v); } r[i] = Math.sqrt(s / f); }
  const sorted = [...r].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)] || 0;
  const active = r.filter((v) => v > 0.01);
  const act = active.length ? Math.sqrt(active.reduce((a, v) => a + v * v, 0) / active.length) : 0;
  return { n, active: active.length, rmsDb: D.gainToDb(act), peakDb: D.gainToDb(pk), floorDb: D.gainToDb(floor), crest: D.gainToDb(pk) - D.gainToDb(act), gap: D.gainToDb(act) - D.gainToDb(floor) };
}

// What to change, from what was measured. Each finding says why and carries its own fix.
function findings(m, mix, beatBalance) {
  const out = [];
  const add = (sev, text, fix) => out.push({ sev, text, fix });
  const b = m.bands.db;
  const mudRel = b.mud - b.mid, lowRel = b.low - b.mid, presRel = b.pres - b.mid, sibRel = b.sib - b.pres, airRel = b.air - b.pres;

  if (m.lv.peakDb > -0.5) add('bad', `The vocal peaks at ${r1(m.lv.peakDb)} dB, right at the ceiling, so it may be clipping.`, [{ key: 'vocalDb', delta: -3 }]);
  if (m.lv.gap < 22) add('warn', `Room noise sits only ${Math.round(m.lv.gap)} dB under the voice. Between lines you will hear it.`, [{ key: 'gate', delta: Math.round((22 - m.lv.gap) * 2.2) }]);
  if (mudRel > 3) add('warn', 'The low-mids are crowding the voice. It sounds boxy and a little muddy.', [{ key: 'mud', delta: -Math.min(4, Math.round(mudRel - 2)) }]);
  else if (mudRel < -4 && lowRel < -9) add('warn', 'It is thin: very little body underneath the voice.', [{ key: 'body', delta: 2 }]);
  if (lowRel > 6) add('warn', 'Too much low end for a vocal. It will fight the beat.', [{ key: 'hpf', delta: 20 }, { key: 'body', delta: -2 }]);
  if (presRel < -13) add('warn', 'The voice is sitting back: the 2 to 5 kHz range that carries the words is low.', [{ key: 'presence', delta: Math.min(4, Math.round((-13 - presRel) / 1.5 + 1.5)) }]);
  else if (presRel > -3) add('warn', 'It is pushing hard in the upper-mids and may feel harsh on small speakers.', [{ key: 'presence', delta: -2 }]);
  if (sibRel > -4) add('warn', 'S and T sounds are sharp.', [{ key: 'sibilance', delta: Math.min(3, Math.round((sibRel + 4) / 1.5 + 1)) }]);
  if (airRel < -18) add('info', 'No sparkle on top. A little air would open it up.', [{ key: 'air', delta: Math.min(4, Math.round((-18 - airRel) / 2 + 1.5)) }]);
  if (m.lv.crest > 17) add('warn', `The level jumps around (peaks run ${Math.round(m.lv.crest)} dB over the average). More compression will keep every word audible.`, [{ key: 'comp', delta: 15 }]);
  else if (m.lv.crest < 8 && mix.compOn) add('info', 'It is already squeezed hard. Easing the compressor will let it breathe.', [{ key: 'comp', delta: -10 }]);
  if (beatBalance != null) {
    const off = beatBalance - 3;
    if (off < -2) add('warn', `The vocal sits ${r1(Math.abs(off))} dB too far under the beat.`, [{ key: 'vocalDb', delta: Math.round(-off * 2) / 2 }]);
    else if (off > 3) add('info', `The vocal is ${r1(off)} dB on top of where vocals usually sit against the beat.`, [{ key: 'vocalDb', delta: -Math.round(off * 2) / 2 }]);
  }
  return out;
}

// ------------------------------------------------------------------ the panel
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const MODE_KEY = 'studio365:ai-mode', ROLE_KEY = 'studio365:ai-role';

const BOT = `
<svg viewBox="0 0 200 200" aria-hidden="true">
  <defs>
    <radialGradient id="mxFace" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#1c1c2a"/><stop offset="1" stop-color="#07070c"/></radialGradient>
    <linearGradient id="mxRing" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
    <filter id="mxGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <path d="M34 112 C34 52 70 24 100 24 C130 24 166 52 166 112" fill="none" stroke="#3a3a52" stroke-width="9" stroke-linecap="round"/>
  <rect class="mx-ear" x="18" y="92" width="26" height="54" rx="13" fill="#1a1a26" stroke="url(#mxRing)" stroke-width="3" filter="url(#mxGlow)"/>
  <rect class="mx-ear" x="156" y="92" width="26" height="54" rx="13" fill="#1a1a26" stroke="url(#mxRing)" stroke-width="3" filter="url(#mxGlow)"/>
  <circle cx="100" cy="112" r="62" fill="url(#mxFace)"/>
  <circle class="mx-ring" cx="100" cy="112" r="62" fill="none" stroke="url(#mxRing)" stroke-width="4" filter="url(#mxGlow)" stroke-linecap="round"/>
  <g class="mx-eyes"><rect class="mx-eye" x="76" y="96" width="14" height="30" rx="7"/><rect class="mx-eye" x="110" y="96" width="14" height="30" rx="7"/></g>
</svg>`;

export function initCopilot(api) {
  const P = () => api.P();
  const root = document.getElementById('panel-ai');
  if (!root) return { refresh() {}, reset() {} };

  let mode = 'simple', role = 'lead', busy = false, voice = null;
  try { mode = localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'; role = localStorage.getItem(ROLE_KEY) || 'lead'; } catch { /* private mode */ }
  if (!ROLES[role]) role = 'lead';
  let past = [], future = [], base = null, showingBase = null, bypass = {}, lastFound = [];

  root.innerHTML = '';
  const el = h(`
  <div class="ai">
    <div class="ai-top">
      <label class="ai-role"><span>Voice is a</span><select id="aiRole" aria-label="What this voice is"></select></label>
      <div class="seg ai-mode" role="group" aria-label="Mode">
        <button type="button" data-mode="simple" aria-pressed="true">Simple</button>
        <button type="button" data-mode="advanced" aria-pressed="false">Advanced</button>
      </div>
    </div>
    <div class="ai-stage">
      <div class="mx-bot" id="aiBot" data-state="idle">${BOT}</div>
      <p class="ai-status" id="aiStatus" aria-live="polite">Tell me what to change, or ask what I hear.</p>
      <div class="ai-prog" id="aiProg" hidden><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    </div>
    <div class="ai-hist" role="group" aria-label="History">
      <button type="button" class="tb" id="aiUndo" disabled title="Undo the last change Mix AI made"><span>Undo</span></button>
      <button type="button" class="tb" id="aiRedo" disabled title="Redo"><span>Redo</span></button>
      <button type="button" class="tb" id="aiCompare" disabled aria-pressed="false" title="Flip between where you started and now"><span>Compare</span></button>
    </div>

    <form class="ai-say" id="aiForm" autocomplete="off">
      <input id="aiText" type="text" placeholder="Describe the change…" aria-label="Describe the change" maxlength="240" enterkeyhint="send">
      <button type="button" class="ai-mic" id="aiMic" aria-label="Talk to Mix AI" aria-pressed="false" title="Talk to Mix AI">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      </button>
      <button type="submit" class="ai-go" id="aiGo" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg></button>
    </form>
    <div class="ai-log" id="aiLog" aria-live="polite"></div>

    <div class="ai-simple" id="aiSimple">
      <div class="ai-quick" id="aiQuick"><p class="ai-h">Quick asks <small>Tap one, or tell me what you hear</small></p></div>
      <div class="ai-macros" id="aiMacros"><p class="ai-h">Smart macros <small>5 moves on this channel. Drag to ride them</small></p></div>
    </div>

    <div class="ai-adv" id="aiAdv" hidden>
      <p class="ai-h">Chain <small>Signal order, top to bottom. Switch a piece off to hear without it</small></p>
      <ol class="ai-chain" id="aiChain"></ol>
      <label class="field"><span>Style</span><select id="aiStyle"><option value="">Choose a sound…</option></select></label>
      <p class="note" id="aiStyleAbout">A style sets tuning, tone, space and stacks in one pick. Settings only, adjust anything after.</p>
    </div>

    <p class="note ai-fine">Runs in your browser. Styles are settings you can change, not copies of anyone's voice. <span class="pro-pill">Plus</span></p>
  </div>`);
  root.append(el);
  const $ = (id) => el.querySelector(`#${id}`);

  // ---- role + style menus
  Object.entries(ROLES).forEach(([k, r]) => $('aiRole').add(new Option(r.label, k)));
  $('aiRole').value = role;
  STYLES.forEach((s) => $('aiStyle').add(new Option(s.name, s.id)));
  QUICK.forEach((q) => {
    const b = h(`<button type="button" class="ai-q">${esc(q.label)}</button>`);
    b.addEventListener('click', () => say(q.say, q.label));
    $('aiQuick').append(b);
  });

  // ---- macros: five controls that mirror real faders
  const MACROS = [
    { key: 'air', label: 'Air', lo: 'Less', hi: 'More', min: -6, max: 12, step: 0.5 },
    { key: 'presence', label: 'Presence', lo: 'Less', hi: 'More', min: -6, max: 9, step: 0.5 },
    { key: 'body', label: 'Body', lo: 'Less', hi: 'More', min: -6, max: 8, step: 0.5 },
    { key: 'reverb', label: 'Reverb', lo: 'Dry', hi: 'Wet', min: 0, max: 70, step: 1 },
    { key: 'delay', label: 'Delay', lo: 'Dry', hi: 'Wet', min: 0, max: 70, step: 1 },
  ];
  const macroInputs = {};
  MACROS.forEach((m) => {
    const row = h(`<div class="ai-macro"><div class="ai-macro-head"><label for="aiM-${m.key}">${m.label}</label><output></output></div>
      <input id="aiM-${m.key}" type="range" min="${m.min}" max="${m.max}" step="${m.step}"><div class="fader-scale"><span>${m.lo}</span><span>${m.hi}</span></div></div>`);
    const input = row.querySelector('input');
    let armed = false;
    const arm = () => { if (!armed) { armed = true; remember(); } };
    input.addEventListener('pointerdown', arm); input.addEventListener('keydown', arm);
    input.addEventListener('input', () => { arm(); P().mix[m.key] = Number(input.value); paintMacro(m.key); api.commit(false); });
    input.addEventListener('change', () => { armed = false; });
    $('aiMacros').append(row);
    macroInputs[m.key] = { row, input, m };
  });
  function paintMacro(key) {
    const { row, input, m } = macroInputs[key];
    const v = P().mix[key];
    input.value = v;
    row.querySelector('output').textContent = fmt(key, v);
    input.style.setProperty('--pct', `${((v - m.min) / (m.max - m.min)) * 100}%`);
  }

  // ---- chain (advanced)
  CHAIN.forEach((c) => {
    const li = h(`<li class="ai-link" data-id="${c.id}">
      <label class="ai-sw"><input type="checkbox" role="switch" checked aria-label="${esc(c.name)} on"><i></i></label>
      <div class="ai-link-t"><b>${esc(c.name)}</b><span>${esc(c.sub)}</span></div>
      <button type="button" class="link" data-goto="${c.goto}">Adjust</button></li>`);
    li.querySelector('input').addEventListener('change', (e) => setBypass(c, !e.target.checked));
    li.querySelector('[data-goto]').addEventListener('click', () => document.getElementById(`tab-${c.goto}`).click());
    $('aiChain').append(li);
  });
  const isLinkOn = (c) => !(c.id in bypass);
  function paintChain() {
    CHAIN.forEach((c) => {
      const li = $('aiChain').querySelector(`[data-id="${c.id}"]`);
      const on = isLinkOn(c);
      li.querySelector('input').checked = on; li.classList.toggle('off', !on);
    });
  }
  function setBypass(c, off) {
    if (!gate('Mix AI')) { paintChain(); return; }
    remember();
    const p = P();
    if (off) {
      const keep = {};
      if (c.keys) for (const k of Object.keys(c.keys)) { keep[k] = p.mix[k]; p.mix[k] = c.keys[k]; }
      if (c.tune) { keep.tune = {}; for (const k of Object.keys(c.tune)) { keep.tune[k] = p.tune[k]; p.tune[k] = c.tune[k]; } }
      if (c.stack) { keep.stack = {}; for (const k of Object.keys(c.stack)) { keep.stack[k] = p.stack[k]; p.stack[k] = c.stack[k]; } }
      bypass[c.id] = keep;
    } else {
      const keep = bypass[c.id] || {};
      for (const k of Object.keys(keep)) { if (k === 'tune') Object.assign(p.tune, keep.tune); else if (k === 'stack') Object.assign(p.stack, keep.stack); else p.mix[k] = keep[k]; }
      delete bypass[c.id];
    }
    api.commit(!!c.tune);
    paintChain();
  }

  // ---- history: every AI move can be undone, and the first one is the "original"
  const snap = () => { const p = P(); return { mix: clone({ ...p.mix, solo: undefined }), tune: clone(p.tune), stack: clone(p.stack), preset: p.preset || '' }; };
  const restore = (s) => {
    const p = P(); const solo = p.mix.solo;
    p.mix = { ...clone(s.mix), solo }; p.tune = clone(s.tune); p.stack = clone(s.stack); p.preset = s.preset;
    api.commit(true);
  };
  function remember() {
    if (!base) base = snap();
    past.push(snap()); if (past.length > 40) past.shift(); future = [];
    showingBase = null; paintHist();
  }
  function paintHist() {
    $('aiUndo').disabled = !past.length; $('aiRedo').disabled = !future.length;
    $('aiCompare').disabled = !base; $('aiCompare').setAttribute('aria-pressed', String(!!showingBase));
    $('aiCompare').querySelector('span').textContent = showingBase ? 'Hearing original' : 'Compare';
  }
  function undo() { const s = past.pop(); if (!s) return say2('Nothing to undo.'); future.push(snap()); restore(s); bypass = {}; paintChain(); paintHist(); status('Undone.', 'idle'); log('bot', 'Undone.'); }
  function redo() { const s = future.pop(); if (!s) return say2('Nothing to redo.'); past.push(snap()); restore(s); paintHist(); status('Redone.', 'idle'); log('bot', 'Redone.'); }
  function compare() {
    if (!base) return say2('Nothing to compare yet. Make a change first.');
    if (showingBase) { restore(showingBase.mine); showingBase = null; status('Back to your AI mix.', 'idle'); log('bot', 'Back to the Mix AI version.'); }
    else { showingBase = { mine: snap() }; restore(base); status('Hearing the original. Press Compare again for the AI mix.', 'idle'); log('bot', 'Hearing your original mix. Press Compare again to flip back.'); }
    paintHist();
  }
  $('aiUndo').addEventListener('click', undo); $('aiRedo').addEventListener('click', redo); $('aiCompare').addEventListener('click', compare);

  // ---- feedback
  function status(text, state) { $('aiStatus').textContent = text; if (state) $('aiBot').dataset.state = state; }
  function log(who, text, extra) {
    const row = h(`<div class="ai-msg ${who}"><span>${who === 'me' ? 'You' : 'Mix AI'}</span><p>${esc(text)}</p></div>`);
    if (extra) row.append(extra);
    const box = $('aiLog'); box.append(row);
    while (box.children.length > 14) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }
  const say2 = (t) => { log('bot', t); status(t, 'idle'); };
  const gate = (feature) => (api.requirePro ? api.requirePro(feature) : true);
  const hasVocal = () => api.hasVocal();

  // ---- applying changes
  function applyMove(a, notes) {
    const p = P(), step = a.step * (a.mult || 1);
    const key = a.key;
    if (key === 'comp') {
      const cur = p.mix.compOn ? Math.max(0, Math.min(100, ((-p.mix.compThr - 8) / 30) * 100)) : 0;
      const next = a.dir === 'zero' ? 0 : Math.max(0, Math.min(100, cur + (a.dir > 0 ? 1 : -1) * step));
      Object.assign(p.mix, compFromMacro(next)); p.mix.comp = next;
      notes.push(next ? `Compression ${a.dir > 0 ? 'up' : 'down'} (${Math.round(next)}%)` : 'Compressor off');
      return;
    }
    const range = RANGE[key]; if (!range) return;
    const cur = Number(p.mix[key] ?? DEFAULT_MIX[key] ?? 0);
    let next;
    if (a.dir === 'zero') next = key === 'hpf' ? 40 : key === 'lpf' ? 20000 : 0;
    else next = cur + (a.dir > 0 ? 1 : -1) * step;
    next = clamp(DB_KEYS.has(key) || key === 'sibilance' ? r1(next) : Math.round(next), range);
    if (next === cur) { notes.push(`${NAMES[key]} is already at its limit`); return; }
    p.mix[key] = next;
    notes.push(a.dir === 'zero' ? `${NAMES[key]} off` : `${NAMES[key]} ${fmt(key, next)}`);
  }
  function applyRecipe(r, notes, label) {
    const p = P();
    if (r.tune) p.tune = { ...p.tune, ...(r.tune.enabled === undefined ? { enabled: true } : {}), ...(r.aka ? { formant: 0, humanize: 0, flex: 0, glideMs: 0 } : {}), ...r.tune };
    if (r.mix) {
      p.mix = { ...p.mix, ...r.mix, ...(r.mix.comp != null ? compFromMacro(r.mix.comp) : {}) };
      if (r.mix.lpf == null) p.mix.lpf = 20000;
    }
    if (r.stack) {
      if (api.isPro()) p.stack = { ...p.stack, ...r.stack };
      else notes.push('Doubles and harmony need a Plus plan, so I left those out');
    }
    p.preset = '';
    bypass = {};
    notes.push(label);
  }

  async function run(actions) {
    const mutating = actions.some((a) => !['analyze', 'compare', 'undo', 'redo', 'detect'].includes(a.op));
    if (mutating && !gate('Mix AI')) { status('Mix AI needs a Plus plan to change your mix.', 'idle'); return; }
    for (const a of actions) {
      if (a.op === 'undo') return undo();
      if (a.op === 'redo') return redo();
      if (a.op === 'compare') return compare();
      if (a.op === 'analyze') return analyze();
      if (a.op === 'auto') return autoMix();
      if (a.op === 'detect') return detect();
      if (a.op === 'reset') {
        remember(); const p = P(); const solo = p.mix.solo;
        p.mix = { ...clone(DEFAULT_MIX), solo, mute: { ...DEFAULT_MIX.mute } }; p.preset = ''; bypass = {};
        api.commit(false); paintChain();
        return say2('The mix is back to its starting point. Undo brings your last mix back.');
      }
    }
    remember();
    const notes = [], p = P(); let tuneChanged = false, roleReply = null;
    for (const a of actions) {
      if (a.op === 'move') applyMove(a, notes);
      else if (a.op === 'style') {
        const s = STYLES.find((x) => x.id === a.id); applyRecipe(s, notes, `${s.name} on: ${s.about}`); tuneChanged = true; $('aiStyle').value = s.id; $('aiStyleAbout').textContent = s.about;
      } else if (a.op === 'role') {
        role = a.id; try { localStorage.setItem(ROLE_KEY, role); } catch { /* private mode */ }
        $('aiRole').value = role; const r = ROLES[role]; applyRecipe(r, notes, `Set up for ${r.label.toLowerCase()}: ${r.about}`); tuneChanged = true;
      } else if (a.op === 'tune') {
        tuneChanged = true;
        if (a.set) Object.assign(p.tune, a.set);
        if (a.rel) for (const [k, d] of Object.entries(a.rel)) {
          const lim = { speedMs: [0, 200], amount: [0, 100], keepVibrato: [0, 100], formant: [-5, 5] }[k] || [-1e9, 1e9];
          p.tune[k] = clamp(r1((p.tune[k] || 0) + d), lim);
        }
        if (a.rel && a.rel.formant != null && !api.isPro()) { p.tune.formant = 0; notes.push('Voice character is part of Tune Pro (Plus)'); }
        else if (a.set && a.set.transpose != null && !api.isPro()) { p.tune.transpose = 0; notes.push('Transpose is part of Tune Pro (Plus)'); }
        else notes.push(a.say);
      } else if (a.op === 'key') {
        tuneChanged = true;
        p.tune.root = a.root; if (a.scale) p.tune.scale = a.scale; p.tune.mask = null;
        notes.push(`Key set to ${D.NOTE_NAMES[a.root]} ${a.scale || p.tune.scale}. Tuning follows it`);
      } else if (a.op === 'stack') {
        if (!api.isPro()) { notes.push('Doubles and harmony need a Plus plan'); continue; }
        if (a.set) Object.assign(p.stack, a.set);
        if (a.rel) for (const [k, d] of Object.entries(a.rel)) p.stack[k] = clamp((p.stack[k] || 0) + d, [0, 100]);
        tuneChanged = true; notes.push(a.say);
      }
    }
    const verified = actions.some((a) => a.verify);
    if (verified && !hasVocal()) notes.push('No vocal yet, so it will tune once you record or import one');
    api.commit(tuneChanged);
    paintChain();
    if (!notes.length) { past.pop(); paintHist(); return say2("I didn't catch a change in that. Try “more air”, “less reverb”, “make it sound dark and wide”, or ask what I hear."); }
    const msg = `${[...new Set(notes)].map((n) => n.replace(/[.\s]+$/, '')).join('. ')}.`;
    log('bot', msg); status(notes[0], 'happy');
    setTimeout(() => { if ($('aiBot').dataset.state === 'happy') $('aiBot').dataset.state = 'idle'; }, 2200);
  }

  // ---- listening and mixing
  async function measure() {
    if (!hasVocal()) { say2('Record or import a vocal first and I can listen to it.'); return null; }
    status('Listening…', 'thinking');
    await new Promise((r) => setTimeout(r, 30));
    const stem = await api.stem();
    if (!stem) return null;
    const x = D.toMono(stem);
    const lv = levelsOf(x, api.sr()), bands = bandsOf(x, api.sr());
    if (!bands || lv.active < 8) { say2('I could not find enough voice in this take to judge it.'); return null; }
    return { lv, bands, stem };
  }
  async function analyze() {
    if (busy) return; busy = true;
    try {
      const m = await measure(); if (!m) return;
      const p = P();
      const bb = p.beat ? vocalBeatBalance(m.stem, p.beat.channels, p.mix.beatDb, api.sr()) : null;
      const list = findings(m, p.mix, bb);
      lastFound = list;
      const key = p.key ? `The beat reads as ${p.key.label}. ` : '';
      const head = `${key}Vocal averages ${Math.round(m.lv.rmsDb)} dB with peaks at ${r1(m.lv.peakDb)} dB.`;
      if (!list.length) { log('bot', `${head} Honestly it sounds balanced: tone, level and noise all sit where they should. Tell me what you want to push from here.`); status('Sounds balanced.', 'happy'); return; }
      const wrap = h('<div class="ai-finds"></div>');
      list.forEach((f) => wrap.append(h(`<p class="ai-find ${f.sev}">${esc(f.text)}</p>`)));
      const btn = h('<button type="button" class="btn small primary ai-fixall">Fix these</button>');
      btn.addEventListener('click', () => { btn.disabled = true; applyFindings(list); });
      wrap.append(btn);
      log('bot', `${head} Here is what I hear:`, wrap);
      status(`${list.length} thing${list.length > 1 ? 's' : ''} to fix.`, 'idle');
    } catch (err) { say2(`I couldn't listen just now: ${err.message}`); }
    finally { busy = false; $('aiBot').dataset.state = $('aiBot').dataset.state === 'thinking' ? 'idle' : $('aiBot').dataset.state; }
  }
  function applyFindings(list) {
    if (!gate('Mix AI')) return;
    remember(); const notes = [];
    list.forEach((f) => f.fix.forEach((fx) => applyMove({ key: fx.key, dir: fx.delta >= 0 ? 1 : -1, step: Math.abs(fx.delta), mult: 1 }, notes)));
    api.commit(false); paintChain();
    log('bot', `${[...new Set(notes)].map((n) => n.replace(/[.\s]+$/, '')).join('. ')}. Say “what do you hear” again to check.`); status('Fixed.', 'happy');
  }

  const STAGES = ['Key', 'Clean', 'Tone', 'Dynamics', 'De-ess', 'Tune', 'Space', 'Balance'];
  async function autoMix() {
    if (busy) return;
    if (!gate('Mix AI')) return;
    if (!hasVocal()) return say2('Record or import a vocal first and I will mix it.');
    busy = true;
    const prog = $('aiProg'); prog.hidden = false;
    const step = (i) => { status(`${STAGES[i]} ${i + 1} / ${STAGES.length}`, 'thinking'); [...prog.children].forEach((c, j) => { c.className = j < i ? 'done' : j === i ? 'now' : ''; }); };
    const tick = () => new Promise((r) => setTimeout(r, 160));
    remember();
    const notes = [];
    try {
      const p = P();
      step(0);
      if (p.beat) { try { await api.detectKey(); notes.push(`Session key set to ${D.NOTE_NAMES[p.tune.root]} ${p.tune.scale}`); } catch { /* keep the key you have */ } } else notes.push('No beat loaded, so I kept your key');
      await tick();

      const m = await measure(); if (!m) throw new Error('no vocal');
      const bb = p.beat ? vocalBeatBalance(m.stem, p.beat.channels, p.mix.beatDb, api.sr()) : null;
      const list = findings(m, p.mix, bb);
      const byKey = (k) => list.filter((f) => f.fix.some((x) => x.key === k)).flatMap((f) => f.fix.filter((x) => x.key === k));
      const move = (key, delta) => applyMove({ key, dir: delta >= 0 ? 1 : -1, step: Math.abs(delta), mult: 1 }, notes);

      step(1); const g = byKey('gate'); if (g.length) move('gate', g[0].delta); else if (p.mix.gate > 0) notes.push('Room noise was fine'); if (p.mix.hpf < 80) p.mix.hpf = 90; await tick();
      step(2); ['mud', 'body', 'presence', 'air', 'hpf'].forEach((k) => byKey(k).forEach((f) => move(k, f.delta))); await tick();
      step(3); const c = byKey('comp'); if (c.length) move('comp', c[0].delta); else if (!p.mix.compOn) { Object.assign(p.mix, compFromMacro(45)); notes.push('Compressor on'); } await tick();
      step(4); const s = byKey('sibilance'); if (s.length) move('sibilance', s[0].delta); await tick();
      step(5);
      if (!p.tune.enabled && role !== 'spoken') { p.tune.enabled = true; p.tune.speedMs = Math.max(p.tune.speedMs, 25); p.tune.amount = Math.min(p.tune.amount, 90); notes.push('Tuning on, natural'); }
      else if (p.tune.enabled) notes.push(`Tuning stays on in ${D.NOTE_NAMES[p.tune.root]} ${p.tune.scale}`);
      await tick();
      step(6);
      const r = ROLES[role].mix;
      if (p.mix.reverb === DEFAULT_MIX.reverb && p.mix.delay === DEFAULT_MIX.delay) { p.mix.reverb = r.reverb ?? p.mix.reverb; p.mix.delay = r.delay ?? p.mix.delay; notes.push(`Space set for ${ROLES[role].label.toLowerCase()}`); }
      await tick();
      api.commit(true);
      step(7);
      if (p.beat) { await api.balance(); notes.push(`Vocal balanced to the beat (${fmt('vocalDb', P().mix.vocalDb)})`); }
      paintChain();
      [...prog.children].forEach((x) => { x.className = 'done'; });
      log('bot', `Mixed. ${[...new Set(notes)].map((n) => n.replace(/[.\s]+$/, '')).join('. ')}. Everything is on the Tune and Mix tabs to adjust. Undo or Compare to hear where you started.`);
      status('Done. Play it back.', 'happy');
    } catch (err) {
      if (err.message !== 'no vocal') say2(`Stopped: ${err.message}`);
    } finally {
      busy = false;
      setTimeout(() => { prog.hidden = true; }, 1600);
      setTimeout(() => { if ($('aiBot').dataset.state !== 'listening') $('aiBot').dataset.state = 'idle'; }, 2400);
    }
  }
  async function detect() {
    if (!P().beat) return say2('Load a beat first and I will read its key and tempo.');
    status('Reading the beat…', 'thinking');
    try { const r = await api.detectKey(); const p = P(); say2(`Session key set to ${D.NOTE_NAMES[p.tune.root]} ${p.tune.scale}${r && r.bpm ? `, ${r.bpm} BPM` : ''}. Every tuned note lands in it now.`); }
    catch (err) { say2(`Couldn't read the beat: ${err.message}`); }
  }

  // ---- talking to it
  function say(text, shown) {
    const t = String(text || '').trim(); if (!t) return;
    log('me', shown || t); $('aiText').value = '';
    const { actions } = interpret(t);
    if (!actions.length) { say2("I didn't catch a change in that. Try “more air”, “less reverb”, “make it sound dark and wide”, or ask what I hear."); return; }
    run(actions);
  }
  $('aiForm').addEventListener('submit', (e) => { e.preventDefault(); say($('aiText').value); });

  // voice: the browser's own speech recognition
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('aiMic').addEventListener('click', () => {
    if (!SR) { say2('Voice needs Chrome, Edge or Safari. You can still type.'); return; }
    if (voice) { voice.stop(); return; }
    const rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    let heard = '';
    rec.onstart = () => { voice = rec; $('aiMic').setAttribute('aria-pressed', 'true'); el.classList.add('hearing'); status('Listening… say what you want', 'listening'); };
    rec.onresult = (e) => { heard = [...e.results].map((r) => r[0].transcript).join(' '); $('aiText').value = heard; };
    rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') say2('The browser blocked the microphone. Allow it for this site and try again.'); else if (e.error !== 'no-speech' && e.error !== 'aborted') say2(`Voice stopped: ${e.error}`); };
    rec.onend = () => { voice = null; $('aiMic').setAttribute('aria-pressed', 'false'); el.classList.remove('hearing'); if ($('aiBot').dataset.state === 'listening') $('aiBot').dataset.state = 'idle'; if (heard.trim()) say(heard); else status('Tell me what to change, or ask what I hear.', 'idle'); };
    try { rec.start(); } catch { voice = null; }
  });

  // ---- mode, role, style
  function setMode(m) {
    mode = m; try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
    el.querySelectorAll('.ai-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('aiSimple').hidden = m !== 'simple'; $('aiAdv').hidden = m !== 'advanced';
  }
  el.querySelectorAll('.ai-mode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('aiRole').addEventListener('change', (e) => {
    const id = e.target.value;
    if (!gate('Mix AI')) { e.target.value = role; return; }
    log('me', `Treat this as ${ROLES[id].label.toLowerCase()}`);
    run([{ op: 'role', id }]);
  });
  $('aiStyle').addEventListener('change', (e) => { if (!e.target.value) return; const s = STYLES.find((x) => x.id === e.target.value); log('me', `Use ${s.name}`); run([{ op: 'style', id: s.id }]); });

  function refresh() { MACROS.forEach((m) => paintMacro(m.key)); }
  function reset() { past = []; future = []; base = null; showingBase = null; bypass = {}; paintHist(); paintChain(); refresh(); }
  setMode(mode); paintHist(); paintChain(); refresh();
  log('bot', 'Hey. Tell me what to change (“more air”, “less reverb”, “make it sound like Drake”), say it with the mic, or tap Fix it and I will mix the vocal.');
  return { refresh, reset };
}
