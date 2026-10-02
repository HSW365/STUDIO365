// File builders for STUDIO365: ZIP (stored, no compression), ID3 tags for MP3, cover art sizing,
// and the .studio365 session backup format. No dependencies.

// ---------------------------------------------------------------- CRC32 + ZIP
let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, bytes: Uint8Array }] -> Blob. Audio is already dense, so files are stored as-is.
export function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), size = f.bytes.length;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, crc, true);
    local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true); cd.setUint32(16, crc, true);
    cd.setUint32(20, size, true); cd.setUint32(24, size, true); cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------------------------------------------------------------- ID3v2.3
function synchsafe(n) { return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]; }
function utf16(str) {
  const out = new Uint8Array(2 + str.length * 2);
  out[0] = 0xff; out[1] = 0xfe;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); out[2 + i * 2] = c & 0xff; out[3 + i * 2] = c >> 8; }
  return out;
}
function frame(id, body) {
  const out = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, false);
  out.set(body, 10);
  return out;
}
const textFrame = (id, str) => { const t = utf16(str); const b = new Uint8Array(1 + t.length); b[0] = 1; b.set(t, 1); return frame(id, b); };

// tags: { title, artist, album, genre, year, bpm, key, coverJpeg: Uint8Array }
export function tagMp3(mp3, tags) {
  const frames = [];
  const put = (id, v) => { if (v != null && String(v).trim()) frames.push(textFrame(id, String(v).trim())); };
  put('TIT2', tags.title); put('TPE1', tags.artist); put('TALB', tags.album); put('TCON', tags.genre);
  put('TYER', tags.year); put('TBPM', tags.bpm); put('TKEY', tags.key); put('TSSE', 'STUDIO365');
  if (tags.coverJpeg) {
    const mime = new TextEncoder().encode('image/jpeg');
    const b = new Uint8Array(1 + mime.length + 1 + 1 + 1 + tags.coverJpeg.length);
    let o = 0; b[o++] = 0; b.set(mime, o); o += mime.length; b[o++] = 0; b[o++] = 3; b[o++] = 0; b.set(tags.coverJpeg, o);
    frames.push(frame('APIC', b));
  }
  const size = frames.reduce((a, f) => a + f.length, 0);
  const out = new Uint8Array(10 + size + mp3.length);
  out.set([0x49, 0x44, 0x33, 3, 0, 0, ...synchsafe(size)], 0);
  let o = 10; for (const f of frames) { out.set(f, o); o += f.length; }
  out.set(mp3, o);
  return out;
}

// ---------------------------------------------------------------- cover art
// Centre-crops any image to a square and returns a JPEG at `size` px, the format distributors ask for.
export async function squareCover(file, size = 3000) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("That image couldn't be opened. Use a JPG or PNG.")); i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const cv = document.createElement('canvas'); cv.width = size; cv.height = size;
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) throw new Error("The cover couldn't be prepared. Try a smaller image.");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), sourceSide: side, preview: cv.toDataURL('image/jpeg', 0.5) };
  } finally { URL.revokeObjectURL(url); }
}

// ---------------------------------------------------------------- session backup (.studio365)
// Layout: "S365SESSION1\n" | uint32 header length | header JSON | raw Float32 audio, back to back.
const MAGIC = 'S365SESSION1\n';

export function packSession(P) {
  const bufs = [];
  let offset = 0;
  const ref = (arr) => { const r = { o: offset, n: arr.length }; bufs.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)); offset += arr.byteLength; return r; };
  const head = {
    v: 1, app: 'STUDIO365', saved: Date.now(),
    project: {
      id: P.id, name: P.name, created: P.created, updated: P.updated, sr: P.sr, bpm: P.bpm, key: P.key,
      activeTake: P.activeTake, tune: P.tune, mix: P.mix, master: P.master, stack: P.stack, preset: P.preset || '', release: P.release || null,
      beat: P.beat ? { id: P.beat.id, name: P.beat.name, channels: P.beat.channels.map(ref) } : null,
      takes: P.takes.map((t) => ({ id: t.id, num: t.num, name: t.name, start: t.start, created: t.created, audio: ref(t.audio) })),
    },
  };
  const json = new TextEncoder().encode(JSON.stringify(head));
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, json.length, true);
  return new Blob([new TextEncoder().encode(MAGIC), len, json, ...bufs], { type: 'application/octet-stream' });
}

export async function unpackSession(file) {
  const buf = await file.arrayBuffer();
  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(MAGIC.length, buf.byteLength)));
  if (magic !== MAGIC) throw new Error("That isn't a STUDIO365 session file. Pick a file ending in .studio365.");
  const jsonLen = new DataView(buf).getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, jsonLen)));
  const base = start + jsonLen;
  const audio = (r) => new Float32Array(buf.slice(base + r.o, base + r.o + r.n * 4));
  const p = head.project;
  if (p.beat) p.beat.channels = p.beat.channels.map(audio);
  p.takes = p.takes.map((t) => ({ ...t, audio: audio(t.audio) }));
  p.tuned = null;
  return p;
}
