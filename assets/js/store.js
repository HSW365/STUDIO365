// Project library in IndexedDB. Everything a user creates stays on their device, including audio.
const DB = 'studio365';
const STORE = 'projects';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('updated', 'updated');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(store)).then((v) => { out = v; });
    t.oncomplete = () => { db.close(); resolve(out); };
    t.onerror = () => { db.close(); reject(t.error); };
    t.onabort = () => { db.close(); reject(t.error || new Error('Storage aborted')); };
  });
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const saveProject = (p) => tx('readwrite', (s) => { s.put({ ...p, updated: Date.now() }); });
export const deleteProject = (id) => tx('readwrite', (s) => { s.delete(id); });
export const loadProject = async (id) => { const db = await open(); const r = await req2p(db.transaction(STORE).objectStore(STORE).get(id)); db.close(); return r; };

export async function listProjects() {
  const db = await open();
  const all = await req2p(db.transaction(STORE).objectStore(STORE).getAll());
  db.close();
  return all
    .map((p) => ({
      id: p.id, name: p.name, updated: p.updated, created: p.created,
      takes: (p.takes || []).length, beatName: p.beat?.name || null,
      seconds: Math.max(p.beat ? p.beat.channels[0].length : 0, ...(p.takes || []).map((t) => t.audio.length)) / (p.sr || 48000),
    }))
    .sort((a, b) => b.updated - a.updated);
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
