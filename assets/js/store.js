// Session library in IndexedDB. Everything a user creates stays on their device, including audio.
//
// A session is saved in two parts, the way a DAW keeps a small session file next to an audio folder:
//   meta   one small record per session (settings, tracks, clip positions). Rewritten on every change.
//   audio  one record per piece of audio (a beat channel, one version of a take, the cover). Written once.
// Moving a fader therefore saves a few kilobytes, never the audio again.
const DB = 'studio365';
const LEGACY = 'projects';   // sessions saved before the split: one big record, audio inside
const META = 'meta', AUDIO = 'audio';

let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LEGACY)) db.createObjectStore(LEGACY, { keyPath: 'id' }).createIndex('updated', 'updated');
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO);
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; db.onclose = () => { dbp = null; }; resolve(db); };
    req.onerror = () => { dbp = null; reject(req.error); };
    req.onblocked = () => { dbp = null; reject(new Error('Close the other HSW365studio tabs and try again.')); };
  });
  return dbp;
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage aborted')); });
const range = (id) => IDBKeyRange.bound(`${id}/`, `${id}/￿`);

// What is already on disk for the open session, so each piece of audio is written exactly once.
const onDisk = new Map();   // project id -> Set of audio keys
const takeKey = (pid, t) => `${pid}/t/${t.id}/${t.rev || 0}`;

function describe(p) {
  const sr = p.sr || 48000;
  let samples = p.beat ? p.beat.channels[0].length : 0;
  for (const t of p.takes || []) samples = Math.max(samples, Math.round((t.start || 0) * sr) + t.audio.length);
  return { takes: (p.takes || []).length, seconds: samples / sr, beatName: p.beat ? p.beat.name : null };
}

export async function saveProject(p) {
  const db = await open();
  const pid = p.id;
  const need = new Map();   // key -> data
  const meta = { ...p, updated: Date.now(), summary: describe(p) };
  delete meta.tuned;
  if (p.beat) {
    meta.beat = { ...p.beat, channels: p.beat.channels.map((c, i) => { const key = `${pid}/b/${p.beat.id}/${i}`; need.set(key, c); return { key }; }) };
  }
  meta.takes = (p.takes || []).map((t) => { const key = takeKey(pid, t); need.set(key, t.audio); return { ...t, audio: { key } }; });
  if (p.cover && p.cover.bytes) {
    if (!p.cover.id) p.cover.id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const key = `${pid}/c/${p.cover.id}`; need.set(key, p.cover.bytes);
    meta.cover = { ...p.cover, bytes: { key } };
  }
  let have = onDisk.get(pid);
  if (!have) {
    have = new Set(await req2p(db.transaction(AUDIO).objectStore(AUDIO).getAllKeys(range(pid))));
    onDisk.set(pid, have);
  }
  const t = db.transaction([META, AUDIO, LEGACY], 'readwrite');
  const audio = t.objectStore(AUDIO);
  for (const [key, data] of need) if (!have.has(key)) audio.put(data, key);
  for (const key of have) if (!need.has(key)) audio.delete(key);
  t.objectStore(META).put(meta);
  t.objectStore(LEGACY).delete(pid);
  await done(t);
  onDisk.set(pid, new Set(need.keys()));
}

export async function deleteProject(id) {
  const db = await open();
  const t = db.transaction([META, AUDIO, LEGACY], 'readwrite');
  t.objectStore(META).delete(id); t.objectStore(LEGACY).delete(id); t.objectStore(AUDIO).delete(range(id));
  await done(t);
  onDisk.delete(id);
}

export async function loadProject(id) {
  const db = await open();
  const t = db.transaction([META, AUDIO, LEGACY]);
  const meta = await req2p(t.objectStore(META).get(id));
  if (!meta) return (await req2p(t.objectStore(LEGACY).get(id))) || null;   // an older session; it is re-saved in parts on its next change
  const store = t.objectStore(AUDIO);
  const [keys, vals] = await Promise.all([req2p(store.getAllKeys(range(id))), req2p(store.getAll(range(id)))]);
  const data = new Map(keys.map((k, i) => [k, vals[i]]));
  const p = { ...meta };
  delete p.summary;
  if (p.beat) {
    const ch = p.beat.channels.map((c) => data.get(c.key));
    p.beat = ch.every(Boolean) ? { ...p.beat, channels: ch } : null;
  }
  // a take whose audio is missing is left out rather than breaking the whole session
  p.takes = (p.takes || []).map((x) => ({ ...x, audio: data.get(x.audio.key) })).filter((x) => x.audio);
  if (p.cover && p.cover.bytes && p.cover.bytes.key) { const b = data.get(p.cover.bytes.key); p.cover = b ? { ...p.cover, bytes: b } : null; }
  onDisk.set(id, new Set(keys));
  return p;
}

// The list reads only the small records. Older sessions are described once, one at a time, and remembered.
export async function listProjects() {
  const db = await open();
  const metas = await req2p(db.transaction(META).objectStore(META).getAll());
  const out = metas.map((m) => ({ id: m.id, name: m.name, updated: m.updated, created: m.created, ...(m.summary || { takes: (m.takes || []).length, seconds: 0, beatName: null }) }));
  const seen = new Set(out.map((m) => m.id));
  const oldKeys = (await req2p(db.transaction(LEGACY).objectStore(LEGACY).getAllKeys())).filter((k) => !seen.has(k));
  for (const k of oldKeys) {
    const p = await req2p(db.transaction(LEGACY).objectStore(LEGACY).get(k));
    if (!p) continue;
    try { await saveProject(p); onDisk.delete(p.id); } catch (err) { console.warn('Could not convert an older session', err); }
    out.push({ id: p.id, name: p.name, updated: p.updated, created: p.created, ...describe(p) });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  return { usage, quota };
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
