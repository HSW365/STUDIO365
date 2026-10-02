// STUDIO365 Pro: Cash App checkout and key activation. Shared by the landing page and the studio.
import * as License from './license.js';

const cfg = window.STUDIO365_CONFIG || {};
const CASHTAG = cfg.CASHTAG || '$hsw365';
const PRICE = Number(cfg.PRO_PRICE) || 23;
const FIRST = Number(cfg.PRO_FIRST_MONTH) || PRICE;
const CONTACT = cfg.CONTACT_EMAIL || 'hsw365media@gmail.com';
const hasSupabase = cfg.SUPABASE_URL && !/REPLACE/.test(cfg.SUPABASE_URL) && cfg.SUPABASE_ANON_KEY && !/REPLACE/.test(cfg.SUPABASE_ANON_KEY);
const EMAIL_KEY = 'studio365:pro-email';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let state = { pro: false };
let listeners = [];
let dlg = null;
let amount = FIRST;

export const isPro = () => !!state.pro;
export const proStatus = () => state;
export const prices = { monthly: PRICE, first: FIRST, cashtag: CASHTAG };
export const cashLink = (amt) => `https://cash.app/${encodeURIComponent(CASHTAG).replace('%24', '$')}/${amt}`;

async function refresh() {
  state = await License.status();
  listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } });
  paint();
  return state;
}

// Unlock links look like …/studio.html#key=S365-…
async function takeLinkKey() {
  const m = location.hash.match(/key=([^&]+)/);
  if (!m) return null;
  const r = await License.activate(decodeURIComponent(m[1]));
  history.replaceState(null, '', location.pathname + location.search);
  return r;
}

// Call once per page. Picks up an unlock link and any key saved on this device.
// onLink fires when a link key is used while the page is already open.
export async function initPro({ onChange, onLink } = {}) {
  if (onChange) listeners.push(onChange);
  const fromLink = await takeLinkKey();
  await refresh();
  window.addEventListener('hashchange', async () => {
    const r = await takeLinkKey();
    if (r) { await refresh(); if (onLink) onLink(r); }
  });
  return { status: state, fromLink };
}

export function requirePro(feature) {
  if (state.pro) return true;
  openPro(feature);
  return false;
}

// ------------------------------------------------------------------ dialog
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function build() {
  dlg = h(`
  <dialog class="pro-sheet" aria-labelledby="proTitle">
    <form method="dialog" class="pro-head">
      <div>
        <p class="pro-eyebrow" id="proEyebrow">STUDIO365 Pro</p>
        <h2 id="proTitle">Go Pro</h2>
      </div>
      <button class="pro-x" aria-label="Close" value="close">✕</button>
    </form>

    <div class="pro-body" id="proBuy">
      <p class="pro-lede" id="proLede"></p>

      <fieldset class="pro-amounts" id="proAmounts">
        <legend class="sr-only">What you are paying for</legend>
        <label><input type="radio" name="proAmt" value="${FIRST}" checked><span><b>$${FIRST}</b><em>First month</em></span></label>
        <label><input type="radio" name="proAmt" value="${PRICE}"><span><b>$${PRICE}</b><em>Renew a month</em></span></label>
      </fieldset>

      <ol class="pro-steps">
        <li>
          <h3>Where should your key go?</h3>
          <label class="sr-only" for="proEmail">Email address</label>
          <input id="proEmail" type="email" autocomplete="email" inputmode="email" placeholder="you@email.com" spellcheck="false">
        </li>
        <li>
          <h3>Pay <span id="proAmtText">$${FIRST}</span> to <span class="pro-tag">${CASHTAG}</span></h3>
          <div class="pro-pay">
            <div class="pro-qr" id="proQr" aria-hidden="true"></div>
            <div class="pro-pay-copy">
              <a class="btn pro-cash" id="proCash" target="_blank" rel="noopener">
                <i class="pro-cash-mark" aria-hidden="true">$</i>
                <span id="proCashText">Pay $${FIRST} in Cash App</span>
              </a>
              <p>On a computer? Point your phone camera at the code. <b>Put your email in the Cash App note</b> so your payment gets matched to you.</p>
            </div>
          </div>
        </li>
        <li>
          <h3>Tell us you paid</h3>
          <div class="pro-row">
            <label class="sr-only" for="proCashtag">Your $cashtag</label>
            <input id="proCashtag" type="text" placeholder="Your $cashtag" autocomplete="off" spellcheck="false" maxlength="24">
            <button type="button" class="btn primary" id="proPaid">I paid. Send my key</button>
          </div>
          <p class="pro-msg" id="proMsg" role="status" aria-live="polite">Your key is emailed once the payment shows up. No auto-billing, ever. Renew when you want.</p>
        </li>
      </ol>
    </div>

    <div class="pro-body pro-active" id="proActive" hidden>
      <p class="pro-badge-lg">Pro is on</p>
      <p class="pro-lede" id="proActiveText"></p>
      <div class="pro-row">
        <button type="button" class="btn primary" id="proRenew">Add another month</button>
        <button type="button" class="btn ghost" id="proRemove">Remove key from this device</button>
      </div>
    </div>

    <div class="pro-key">
      <label for="proKeyInput" id="proKeyLabel">Already have a key?</label>
      <div class="pro-row">
        <input id="proKeyInput" type="text" placeholder="S365-…" autocomplete="off" spellcheck="false">
        <button type="button" class="btn ghost" id="proActivate">Turn on Pro</button>
      </div>
      <p class="pro-msg" id="proKeyMsg" role="status" aria-live="polite"></p>
    </div>
  </dialog>`);
  document.body.append(dlg);
  const $ = (id) => dlg.querySelector('#' + id);

  dlg.querySelectorAll('input[name="proAmt"]').forEach((r) => r.addEventListener('change', () => setAmount(Number(r.value))));
  try { $('proEmail').value = localStorage.getItem(EMAIL_KEY) || ''; } catch { /* private mode */ }

  $('proPaid').addEventListener('click', async () => {
    const email = $('proEmail').value.trim().toLowerCase(), tag = $('proCashtag').value.trim();
    const msg = $('proMsg'); msg.className = 'pro-msg';
    if (!EMAIL_RE.test(email)) { msg.textContent = 'Enter the email address your key should go to, like you@email.com.'; msg.classList.add('err'); $('proEmail').focus(); return; }
    try { localStorage.setItem(EMAIL_KEY, email); } catch { /* private mode */ }
    const btn = $('proPaid'); btn.disabled = true;
    try {
      let logged = false;
      if (hasSupabase) {
        const r = await fetch(`${cfg.SUPABASE_URL}/rest/v1/studio365_pro_requests`, {
          method: 'POST',
          headers: { apikey: cfg.SUPABASE_ANON_KEY, Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ email, cashtag: tag.slice(0, 24), amount }),
        });
        logged = r.ok;
      }
      if (!logged) {
        const body = `I paid for STUDIO365 Pro.\n\nKey goes to: ${email}\nMy $cashtag: ${tag || '(not given)'}\nAmount: $${amount} to ${CASHTAG}\n`;
        window.location.href = `mailto:${CONTACT}?subject=${encodeURIComponent('STUDIO365 Pro payment')}&body=${encodeURIComponent(body)}`;
      }
      msg.innerHTML = '';
      msg.append(logged ? 'Got it. ' : 'Your email app opened with the details. Hit send. ',
        `Your key goes to ${email} once the $${amount} payment to ${CASHTAG} shows up. Paste it below to switch Pro on. Nothing opened? Email `,
        Object.assign(document.createElement('a'), { href: `mailto:${CONTACT}`, textContent: CONTACT }), '.');
      msg.classList.add('ok');
      $('proKeyInput').focus();
    } catch {
      msg.textContent = `That didn't go through. Email ${CONTACT} with your $cashtag and you'll get your key.`;
      msg.classList.add('err');
    } finally { btn.disabled = false; }
  });

  const tryKey = async () => {
    const msg = $('proKeyMsg'); msg.className = 'pro-msg';
    const r = await License.activate($('proKeyInput').value);
    if (!r.ok) { msg.textContent = r.reason; msg.classList.add('err'); return; }
    $('proKeyInput').value = '';
    await refresh();
    msg.textContent = `Pro is on until ${License.fmtDate(r.expires)}.`; msg.classList.add('ok');
  };
  $('proActivate').addEventListener('click', tryKey);
  $('proKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryKey(); } });
  $('proKeyInput').addEventListener('paste', () => setTimeout(tryKey, 0));

  $('proRenew').addEventListener('click', () => { setAmount(PRICE); showBuy(true); });
  $('proRemove').addEventListener('click', async () => {
    if (!confirm('Remove your Pro key from this browser? You can paste it again any time before it runs out.')) return;
    License.clearKey(); await refresh();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

function setAmount(v) {
  amount = v;
  const $ = (id) => dlg.querySelector('#' + id);
  dlg.querySelectorAll('input[name="proAmt"]').forEach((r) => { r.checked = Number(r.value) === v; });
  $('proAmtText').textContent = `$${v}`;
  $('proCashText').textContent = `Pay $${v} in Cash App`;
  $('proCash').href = cashLink(v);
  drawQr(cashLink(v));
}

let forceBuy = false;
function showBuy(v) { forceBuy = v; paint(); }

function paint() {
  if (!dlg) return;
  const $ = (id) => dlg.querySelector('#' + id);
  const active = state.pro && !forceBuy;
  $('proBuy').hidden = active;
  $('proActive').hidden = !active;
  $('proAmounts').hidden = FIRST === PRICE;
  $('proKeyLabel').textContent = state.pro ? 'Got a new key? Paste it to extend.' : 'Already have a key?';
  if (state.pro) {
    $('proTitle').textContent = forceBuy ? 'Add a month' : 'You are Pro';
    $('proActiveText').textContent = `${state.email ? state.email + ' · ' : ''}Good until ${License.fmtDate(state.expires)} (${state.daysLeft} day${state.daysLeft === 1 ? '' : 's'} left). Pro never bills you on its own. Add a month whenever you like and the new key picks up from there.`;
  }
}

function drawQr(text) {
  const box = dlg.querySelector('#proQr');
  const render = () => {
    try {
      const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      box.hidden = false;
    } catch { box.hidden = true; }
  };
  if (window.qrcode) return render();
  box.hidden = true;
  if (drawQr.loading) { drawQr.loading.then(render, () => {}); return; }
  drawQr.loading = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    s.onload = res; s.onerror = rej; document.head.append(s);
  });
  drawQr.loading.then(render, () => {});
}

// feature: optional name of the Pro feature the person just reached for.
export function openPro(feature) {
  if (!dlg) build();
  const $ = (id) => dlg.querySelector('#' + id);
  forceBuy = false;
  $('proTitle').textContent = feature ? `${feature} is a Pro feature` : 'Go Pro';
  $('proLede').textContent = `Vocal stacks and harmonies, pro presets, the A&R365 record check, release packs and session backups. $${FIRST === PRICE ? PRICE : FIRST + ' your first month, then $' + PRICE} a month, paid with Cash App.`;
  $('proMsg').className = 'pro-msg';
  $('proMsg').textContent = 'Your key is emailed once the payment shows up. No auto-billing, ever. Renew when you want.';
  $('proKeyMsg').textContent = '';
  setAmount(state.expired || state.pro ? PRICE : FIRST);
  paint();
  if (!dlg.open) dlg.showModal();
}
