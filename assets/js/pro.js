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

// Three plans, each one including the one before it. A key says which plan it is for.
export const PLANS = cfg.PLANS || [
  { id: 'starter', name: 'Starter', price: 15, blurb: 'Unlimited projects. Record, tune, mix, master, export.' },
  { id: 'plus', name: 'Plus', price: 20, blurb: 'Adds Tune Pro, vocal stacks and harmonies, six more presets.' },
  { id: 'pro', name: 'Pro', price: 25, blurb: 'Adds the A&R365 record check, release packs and session backups.' },
];
const RANK = { starter: 1, plus: 2, pro: 3 };
export const FREE_PROJECTS = Number(cfg.FREE_PROJECTS) || 3;
export const isMember = () => !!state.pro;                       // any paid plan
export const planId = () => (state.pro ? state.plan || 'pro' : null);
export const planName = () => { const pl = PLANS.find((x) => x.id === planId()); return pl ? pl.name : null; };
export const hasPlan = (need = 'plus') => !!state.pro && RANK[state.plan || 'pro'] >= (RANK[need] || 2);
export const isPro = () => hasPlan('plus');                      // the creative extras: Tune Pro, stacks, presets
export const proStatus = () => state;
export const prices = { monthly: PRICE, first: FIRST, cashtag: CASHTAG };
export const cashLink = (amt) => `https://cash.app/${encodeURIComponent(CASHTAG).replace('%24', '$')}/${amt}`;
export const buyLink = (pl) => (pl.variant ? `https://hsw365.co/cart/${pl.variant}:1` : cfg.SHOP_PRODUCT_URL || 'https://hsw365.co');

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

// need: the lowest plan that includes the feature.
export function requirePro(feature, need = 'plus') {
  if (hasPlan(need)) return true;
  openPro(feature, need);
  return false;
}

// ------------------------------------------------------------------ dialog
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

function build() {
  dlg = h(`
  <dialog class="pro-sheet" aria-labelledby="proTitle">
    <form method="dialog" class="pro-head">
      <div>
        <p class="pro-eyebrow" id="proEyebrow">STUDIO365 plans</p>
        <h2 id="proTitle">Pick a plan</h2>
      </div>
      <button class="pro-x" aria-label="Close" value="close">✕</button>
    </form>

    <div class="pro-body" id="proBuy">
      <p class="pro-lede" id="proLede"></p>
      <div class="pro-plans" id="proPlans">
        ${PLANS.map((pl) => `<a class="pro-plan" data-plan="${pl.id}" href="${buyLink(pl)}" target="_blank" rel="noopener">
          <b>${pl.name}</b><strong>$${pl.price}<small>a month</small></strong><span>${pl.blurb}</span><i>Get ${pl.name}</i>
        </a>`).join('')}
      </div>
      <p class="pro-msg" id="proMsg" role="status" aria-live="polite"></p>
    </div>

    <div class="pro-body pro-active" id="proActive" hidden>
      <p class="pro-badge-lg" id="proBadge">Your plan is on</p>
      <p class="pro-lede" id="proActiveText"></p>
      <div class="pro-row">
        <button type="button" class="btn primary" id="proRenew">Add a month or change plan</button>
        <button type="button" class="btn ghost" id="proRemove">Remove key from this device</button>
      </div>
    </div>

    <div class="pro-key">
      <label for="proKeyInput" id="proKeyLabel">Already have a key?</label>
      <div class="pro-row">
        <input id="proKeyInput" type="text" placeholder="S365-…" autocomplete="off" spellcheck="false">
        <button type="button" class="btn ghost" id="proActivate">Turn it on</button>
      </div>
      <p class="pro-msg" id="proKeyMsg" role="status" aria-live="polite"></p>
    </div>
  </dialog>`);
  document.body.append(dlg);
  const $ = (id) => dlg.querySelector('#' + id);

  let checking = false;
  const tryKey = async () => {
    if (checking) return;
    const msg = $('proKeyMsg');
    const typed = $('proKeyInput').value.trim();
    // Pro already on and nothing new typed: say so instead of complaining about an empty box.
    if (!typed && state.pro) { msg.className = 'pro-msg ok'; msg.textContent = `${planName()} is on until ${License.fmtDate(state.expires)}. You're all set.`; return; }
    checking = true; msg.className = 'pro-msg';
    try {
      const r = await License.activate(typed);
      if (!r.ok) {
        msg.textContent = /@/.test(typed) && !/S365-/.test(typed) ? 'That is an email address. Paste the key or the unlock link you were sent. It starts with S365-.' : r.reason;
        msg.classList.add('err'); return;
      }
      $('proKeyInput').value = '';
      await refresh();
      msg.textContent = `${planName() || 'Your plan'} is on until ${License.fmtDate(r.expires)}. You're all set.`; msg.classList.add('ok');
    } finally { checking = false; }
  };
  $('proActivate').addEventListener('click', tryKey);
  $('proKeyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); tryKey(); } });
  $('proKeyInput').addEventListener('paste', () => setTimeout(tryKey, 0));

  $('proRenew').addEventListener('click', () => { showBuy(true); });
  $('proRemove').addEventListener('click', async () => {
    if (!confirm('Remove your key from this browser? You can paste it again any time before it runs out.')) return;
    License.clearKey(); await refresh();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

let forceBuy = false;
function showBuy(v) { forceBuy = v; paint(); }

function paint() {
  if (!dlg) return;
  const $ = (id) => dlg.querySelector('#' + id);
  const active = state.pro && !forceBuy;
  $('proBuy').hidden = active;
  $('proActive').hidden = !active;
  $('proKeyLabel').textContent = state.pro ? 'Got a new key? Paste it to extend or change plan.' : 'Already have a key?';
  dlg.querySelectorAll('.pro-plan').forEach((a) => a.classList.toggle('current', state.pro && a.dataset.plan === planId()));
  if (state.pro) {
    $('proTitle').textContent = forceBuy ? 'Add a month or change plan' : `You are on ${planName()}`;
    $('proBadge').textContent = `${planName()} is on`;
    $('proActiveText').textContent = `${state.email ? state.email + ' · ' : ''}Good until ${License.fmtDate(state.expires)} (${state.daysLeft} day${state.daysLeft === 1 ? '' : 's'} left). Nothing bills on its own. Add a month whenever you like and the new key picks up from there.`;
  }
}

// feature: what the person just reached for. need: the lowest plan that includes it.
export function openPro(feature, need = null) {
  if (!dlg) build();
  if (feature && !need) need = 'plus';
  const $ = (id) => dlg.querySelector('#' + id);
  forceBuy = !!(state.pro && need && !hasPlan(need));
  const pl = PLANS.find((x) => x.id === need);
  $('proTitle').textContent = feature ? (pl ? `${feature}: ${pl.name} and up` : feature) : 'Pick a plan';
  $('proLede').textContent = `Your first ${FREE_PROJECTS} projects are free. After that, pick a plan. Each purchase is one month and nothing bills on its own.`;
  dlg.querySelectorAll('.pro-plan').forEach((a) => a.classList.toggle('dim', !!need && RANK[a.dataset.plan] < RANK[need]));
  $('proMsg').className = 'pro-msg';
  $('proMsg').textContent = `Checkout is on hsw365.co. Your key is emailed to the address on your order, usually the same day. Tap the link in that email and your plan turns on here. Questions: ${CONTACT}`;
  $('proKeyMsg').textContent = '';
  paint();
  if (feature && (!state.pro || forceBuy)) $('proTitle').textContent = pl ? `${feature}: ${pl.name} and up` : feature;
  if (!dlg.open) dlg.showModal();
}
