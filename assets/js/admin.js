// HSW365studio key maker. Runs entirely in the owner's browser: the owner key file never leaves this device.
import { signKey, verifyKey, makeKeyPair, fmtDate } from './license.js';

const cfg = window.STUDIO365_CONFIG || {};
const $ = (id) => document.getElementById(id);
const OWNER = 'studio365:owner-key', LOG = 'studio365:issued';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const studioUrl = new URL('studio.html', location.href).href.split('#')[0];

let owner = null;
let last = null;
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
let log = load(LOG, []);

let toastTimer;
function toast(msg, error = false) {
  const el = $('toast'); el.textContent = msg; el.classList.toggle('error', error); el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); }
  catch { toast('Copy was blocked. Select the text and copy it by hand.', true); }
}
function save(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------------------------------------------------------------- owner key
function paintOwner() {
  const st = $('ownerStatus'), pub = cfg.LICENSE_PUBLIC_KEY || {};
  $('btnForget').hidden = !owner;
  if (!owner) { st.className = 'status'; st.textContent = 'No owner key loaded'; $('btnMake').disabled = true; return; }
  const match = owner.publicKey && owner.publicKey.x === pub.x && owner.publicKey.y === pub.y;
  st.className = `status ${match ? 'ok' : 'bad'}`;
  st.textContent = match ? 'Owner key loaded and it matches this site' : "This owner key doesn't match the public key in config.js. Keys made with it will be rejected.";
  $('btnMake').disabled = !match;
}
$('btnLoadOwner').addEventListener('click', () => $('fileOwner').click());
$('fileOwner').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    if (!j.privateKey || !j.privateKey.d || !j.publicKey) throw new Error('missing');
    await signKey(j.privateKey, { email: 'check@example.com' }); // proves the file is usable
    owner = { privateKey: j.privateKey, publicKey: j.publicKey };
    localStorage.setItem(OWNER, JSON.stringify(owner));
    paintOwner();
  } catch { toast("That isn't a HSW365studio owner key file. Pick studio365-owner-key.json.", true); }
});
$('btnForget').addEventListener('click', () => {
  if (!confirm('Remove the owner key from this browser? You will need the file again to make keys here.')) return;
  localStorage.removeItem(OWNER); owner = null; paintOwner();
});

// ---------------------------------------------------------------- make a key
$('makeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('makeMsg'); msg.className = 'msg';
  const email = $('email').value.trim().toLowerCase(), months = Number($('months').value);
  if (!EMAIL_RE.test(email)) { msg.textContent = 'Enter the customer\'s full email address.'; msg.classList.add('err'); $('email').focus(); return; }
  // carry over unused time from this customer's current key
  let from = Date.now();
  if ($('extend').checked) {
    const current = log.filter((r) => r.email === email).map((r) => r.expires).sort((a, b) => b - a)[0];
    if (current && current > from) from = current;
  }
  try {
    const plan = $('plan').value;
    const k = await signKey(owner.privateKey, { email, months, from, plan });
    const check = await verifyKey(k.key);
    if (!check.ok) throw new Error(check.reason);
    const link = `${studioUrl}#key=${k.key}`;
    const until = fmtDate(k.expires);
    const text = [
      `Your ${cfg.PRODUCT_NAME || 'HSW365studio'} ${{ starter: 'Starter', plus: 'Plus', pro: 'Pro' }[plan]} plan is ready.`, '',
      'Tap this link on the device you record on and your plan turns on by itself:', link, '',
      `It is good until ${until}. Nothing bills on its own. When you want another month, buy it again at hsw365.co and you get a new link.`, '',
      'If the link gives you trouble, open the studio, press Plans and paste this key:', k.key, '',
      'Turn negative into positive.', 'HSW365 Media',
    ].join('\n');
    last = { link, text, email };
    $('message').value = text;
    $('btnEmail').href = `mailto:${email}?subject=${encodeURIComponent('Your HSW365studio key')}&body=${encodeURIComponent(text)}`;
    $('result').hidden = false;
    log.unshift({ email, months, plan, made: Date.now(), expires: k.expires, key: k.key });
    localStorage.setItem(LOG, JSON.stringify(log));
    paintLog();
    msg.textContent = `Key made for ${email}. Good until ${until}${from > Date.now() + 60000 ? ' (added on to the time they had left)' : ''}.`; msg.classList.add('ok');
  } catch (err) { msg.textContent = `Couldn't make the key: ${err.message}`; msg.classList.add('err'); }
});
$('btnCopyMsg').addEventListener('click', () => last && copy(last.text, 'Message'));
$('btnCopyLink').addEventListener('click', () => last && copy(last.link, 'Link'));

// ---------------------------------------------------------------- members
function paintLog() {
  const tb = $('log'); tb.textContent = '';
  $('logEmpty').hidden = log.length > 0;
  const now = Date.now();
  for (const r of log) {
    const tr = document.createElement('tr');
    const days = Math.ceil((r.expires - now) / 86400000);
    const cls = days <= 0 ? 'out' : days <= 5 ? 'soon' : 'live';
    const label = days <= 0 ? 'Ended' : days <= 5 ? `${days} day${days === 1 ? '' : 's'} left` : 'Active';
    const cell = (text, c) => { const td = document.createElement('td'); if (c) td.className = c; td.textContent = text; return td; };
    const tag = document.createElement('td'); const sp = document.createElement('span'); sp.className = `tag ${cls}`; sp.textContent = label; tag.append(sp);
    const act = document.createElement('td'); const b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small'; b.textContent = 'Copy link';
    b.addEventListener('click', () => copy(`${studioUrl}#key=${r.key}`, 'Link')); act.append(b);
    tr.append(cell(r.email), cell(fmtDate(r.made), 'mono'), cell(fmtDate(r.expires), 'mono'), tag, act);
    tb.append(tr);
  }
}
$('btnCsv').addEventListener('click', () => {
  if (!log.length) { toast('No keys made yet.'); return; }
  const rows = [['email', 'months', 'made', 'good_until', 'key'], ...log.map((r) => [r.email, r.months, new Date(r.made).toISOString().slice(0, 10), new Date(r.expires).toISOString().slice(0, 10), r.key])];
  save('studio365-members.csv', rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n'), 'text/csv');
});

// ---------------------------------------------------------------- new key pair
$('btnNewPair').addEventListener('click', async () => {
  if (!confirm('Make a new key pair? Old Pro keys stop working once the new public key is in config.js.')) return;
  const pair = await makeKeyPair();
  save('studio365-owner-key.json', JSON.stringify({ product: 'HSW365studio', note: 'PRIVATE. Signs Pro keys. Never upload or share this file.', created: new Date().toISOString(), ...pair }, null, 2), 'application/json');
  const p = pair.publicKey;
  $('pubOut').value = `LICENSE_PUBLIC_KEY: {\n    kty: "${p.kty}", crv: "${p.crv}",\n    x: "${p.x}",\n    y: "${p.y}"\n  },`;
  $('pubWrap').hidden = false;
  toast('New owner file downloaded. Load it above after you update config.js.');
});

owner = load(OWNER, null);
paintOwner();
paintLog();
