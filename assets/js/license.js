// STUDIO365 Pro keys. A key is a small signed note: who it is for and when it runs out.
// The site only holds the PUBLIC key, so it can check a key but nobody can forge one from the page source.
// Format: S365-<base64url(JSON payload)>.<base64url(ECDSA P-256 / SHA-256 signature)>
const cfg = (typeof window !== 'undefined' && window.STUDIO365_CONFIG) || {};
const STORE_KEY = 'studio365:pro-key';
const DAY = 86400000;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

const enc = new TextEncoder(), dec = new TextDecoder();
export function b64u(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

// Pull the key out of whatever the person pasted: the bare key, a sentence around it, or an unlock link.
export function extractKey(text) {
  // Whitespace is dropped first because email apps wrap long keys. The signature is always 86 characters,
  // which is how the end of the key is found even when words follow it.
  const m = String(text || '').replace(/\s+/g, '').match(/S365-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}/);
  return m ? m[0] : null;
}

// Returns { ok, email, expires (ms), issued (ms), reason }
export async function verifyKey(text, publicJwk = cfg.LICENSE_PUBLIC_KEY, now = Date.now()) {
  const key = extractKey(text);
  if (!key) return { ok: false, reason: "That doesn't look like a STUDIO365 key. Paste the whole key, starting with S365-." };
  if (!publicJwk || !publicJwk.x) return { ok: false, reason: 'Pro keys are not set up on this site yet.' };
  if (!globalThis.crypto?.subtle) return { ok: false, reason: 'This page needs a secure (https) connection to check your key.' };
  try {
    const [body, sig] = key.slice(5).split('.');
    const pub = await crypto.subtle.importKey('jwk', { ...publicJwk, ext: true }, ALG, false, ['verify']);
    const good = await crypto.subtle.verify(SIG, pub, unb64u(sig), enc.encode(body));
    if (!good) return { ok: false, reason: "That key isn't valid. Copy it again from your email and paste the whole thing." };
    const p = JSON.parse(dec.decode(unb64u(body)));
    const expires = p.x * DAY, issued = (p.i || 0) * DAY;
    if (!p.x || now >= expires) return { ok: false, expired: true, email: p.e, expires, reason: `That key ran out on ${fmtDate(expires)}. Renew to keep Pro.` };
    return { ok: true, key, email: p.e || '', expires, issued, plan: p.p || 'pro' };
  } catch {
    return { ok: false, reason: "That key couldn't be read. Copy it again from your email and paste the whole thing." };
  }
}

export const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });

function read() { try { return localStorage.getItem(STORE_KEY); } catch { return null; } }
export function clearKey() { try { localStorage.removeItem(STORE_KEY); } catch { /* private mode */ } }

// Check a pasted key and remember it on this device if it is good.
export async function activate(text) {
  const r = await verifyKey(text);
  if (r.ok) { try { localStorage.setItem(STORE_KEY, r.key); } catch { /* private mode: Pro lasts for this visit */ } }
  return r;
}

// Current standing on this device: { pro, email, expires, daysLeft, expired }
export async function status() {
  const saved = read();
  if (!saved) return { pro: false };
  const r = await verifyKey(saved);
  if (r.ok) return { pro: true, email: r.email, expires: r.expires, daysLeft: Math.ceil((r.expires - Date.now()) / DAY) };
  return { pro: false, expired: !!r.expired, email: r.email, expires: r.expires };
}

// ---- owner side (used only by the key maker page) ------------------------------------
// months counts from `from` (ms). Day granularity keeps keys short.
export async function signKey(privateJwk, { email, months = 1, from = Date.now() }) {
  const priv = await crypto.subtle.importKey('jwk', { ...privateJwk, ext: true }, ALG, false, ['sign']);
  const start = new Date(from);
  const end = new Date(start); end.setMonth(end.getMonth() + months);
  const payload = { e: String(email).trim().toLowerCase(), p: 'pro', i: Math.floor(start.getTime() / DAY), x: Math.ceil(end.getTime() / DAY) + 1 };
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(SIG, priv, enc.encode(body));
  return { key: `S365-${body}.${b64u(sig)}`, expires: payload.x * DAY, email: payload.e };
}

export async function makeKeyPair() {
  const k = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', k.publicKey), priv = await crypto.subtle.exportKey('jwk', k.privateKey);
  const slim = ({ kty, crv, x, y, d }) => (d ? { kty, crv, x, y, d } : { kty, crv, x, y });
  return { publicKey: slim(pub), privateKey: slim(priv) };
}
