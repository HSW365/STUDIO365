// HSW365studio app shell: the bottom dock (mixer / takes) on desktop, and the view switcher on phones.
// Layout only. The engine and every control stay in studio.js; this file never touches audio.

const DOCK_KEY = 'studio365:dock', DOCK_H_KEY = 'studio365:dock-h', VIEW_KEY = 'studio365:view';
const body = document.body;
const phone = matchMedia('(max-width: 820px)');
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Canvases size themselves on window resize; a panel that just appeared needs the same nudge.
let nudge = 0;
function relayout() {
  cancelAnimationFrame(nudge);
  nudge = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

// ---------------------------------------------------------------- bottom dock (desktop)
const tabs = [...document.querySelectorAll('.dock-tab')];
const toggle = document.getElementById('dockToggle');

function setDock(name, open = true) {
  body.dataset.dock = name;
  body.dataset.dockOpen = String(open);
  tabs.forEach((b) => b.setAttribute('aria-selected', String(b.dataset.dock === name)));
  toggle.setAttribute('aria-expanded', String(open));
  store.set(DOCK_KEY, `${name}:${open ? 1 : 0}`);
  relayout();
}
tabs.forEach((b) => b.addEventListener('click', () => {
  const same = body.dataset.dock === b.dataset.dock;
  setDock(b.dataset.dock, same ? body.dataset.dockOpen !== 'true' : true);
}));
toggle.addEventListener('click', () => setDock(body.dataset.dock || 'mixer', body.dataset.dockOpen !== 'true'));

const [savedDock, savedOpen] = store.get(DOCK_KEY, 'mixer:1').split(':');
setDock(savedDock === 'takes' ? 'takes' : 'mixer', savedOpen !== '0');

// Drag the grip to make the dock taller or shorter. Double-click resets it.
const DOCK_MIN = 180, DOCK_DEFAULT = 360;
function setDockH(px) {
  const max = Math.max(DOCK_MIN, window.innerHeight - 320);
  const h = Math.round(Math.max(DOCK_MIN, Math.min(max, px)));
  body.style.setProperty('--dock-h', `${h}px`);
  return h;
}
setDockH(Number(store.get(DOCK_H_KEY, DOCK_DEFAULT)) || DOCK_DEFAULT);
const grip = document.getElementById('dockGrip');
grip.addEventListener('pointerdown', (e) => {
  if (phone.matches) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const y0 = e.clientY, h0 = parseFloat(getComputedStyle(body).getPropertyValue('--dock-h')) || DOCK_DEFAULT;
  if (body.dataset.dockOpen !== 'true') setDock(body.dataset.dock, true);
  body.classList.add('resizing');
  const move = (ev) => { setDockH(h0 + (y0 - ev.clientY)); relayout(); };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    body.classList.remove('resizing');
    store.set(DOCK_H_KEY, String(parseFloat(getComputedStyle(body).getPropertyValue('--dock-h'))));
    relayout();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});
grip.addEventListener('dblclick', () => { store.set(DOCK_H_KEY, String(setDockH(DOCK_DEFAULT))); relayout(); });
grip.addEventListener('keydown', (e) => {
  const cur = parseFloat(getComputedStyle(body).getPropertyValue('--dock-h')) || DOCK_DEFAULT;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    store.set(DOCK_H_KEY, String(setDockH(cur + (e.key === 'ArrowUp' ? 24 : -24))));
    relayout();
  }
});
window.addEventListener('resize', () => { const cur = parseFloat(getComputedStyle(body).getPropertyValue('--dock-h')); if (cur) setDockH(cur); });

// M shows or hides the mixer, like a console window toggle.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'm' && e.key !== 'M') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
  if (document.querySelector('dialog[open]')) return;
  if (phone.matches) { setView(body.dataset.view === 'mixer' ? 'tracks' : 'mixer'); return; }
  setDock('mixer', !(body.dataset.dock === 'mixer' && body.dataset.dockOpen === 'true'));
});

// ---------------------------------------------------------------- views (phones)
const viewBtns = [...document.querySelectorAll('#viewNav [data-view]')];
function setView(name) {
  body.dataset.view = name;
  viewBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
  store.set(VIEW_KEY, name);
  const main = document.querySelector('.workspace');
  if (main) main.scrollTop = 0;
  relayout();
}
viewBtns.forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
setView(['tracks', 'mixer', 'takes', 'rack'].includes(store.get(VIEW_KEY, 'tracks')) ? store.get(VIEW_KEY, 'tracks') : 'tracks');
phone.addEventListener('change', relayout);

// Recording always happens on the tracks view, so the take is in sight as it goes down.
document.getElementById('btnRecord')?.addEventListener('click', () => { if (phone.matches && body.dataset.view !== 'tracks') setView('tracks'); });

// ---------------------------------------------------------------- take count on the dock tab and phone nav
const list = document.getElementById('takeList');
const count = document.getElementById('dockTakeCount');
function paintCount() {
  const n = list ? list.children.length : 0;
  count.textContent = n ? String(n) : '';
  const navBtn = viewBtns.find((b) => b.dataset.view === 'takes');
  if (navBtn) navBtn.dataset.count = n ? String(n) : '';
}
if (list) new MutationObserver(paintCount).observe(list, { childList: true });
paintCount();

// The studio is a full-screen app: keep iOS from bouncing the whole page when a panel is scrolled to its end.
body.classList.add('shell');
