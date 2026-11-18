/*! HSW365 Owner Login — PIN only. Drop-in: <script src="owner-login.js" defer></script>
 *  Adds an "Owner login" tab. Owner enters PIN (no email). PIN is checked server-side.
 *  On success: html.hsw-owner, window.HSW_OWNER=true, localStorage hsw_owner, event "hsw-owner".
 *  Apps can: if (window.HSW_OWNER) unlock(); addEventListener("hsw-owner", unlock);
 */
(function () {
  if (window.__hswOwnerLoaded) return; window.__hswOwnerLoaded = true;
  var API = "https://lsxdlmrjrcivxwgfkpop.supabase.co/functions/v1/owner-pin";
  var KEY = "hsw_owner";
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
             set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
             del: function (k) { try { localStorage.removeItem(k); } catch (e) {} } };
  function call(body) {
    return fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { ok: false, error: "Try again." }; }); })
      .catch(function () { return { ok: false, error: "No connection." }; });
  }
  function setOwner(on, token) {
    window.HSW_OWNER = !!on;
    document.documentElement.classList.toggle("hsw-owner", !!on);
    if (on) { if (token) ls.set(KEY, token); } else ls.del(KEY);
    refreshBtns();
    try { window.dispatchEvent(new CustomEvent("hsw-owner", { detail: { owner: !!on } })); } catch (e) {}
  }

  var css = document.createElement("style");
  css.textContent =
    ".hswo-tab{position:fixed;top:12px;right:12px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;height:38px;padding:0 16px;border:1px solid rgba(255,255,255,.14);border-radius:999px;background:rgba(14,14,20,.82);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);color:#fff;font:700 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.04em;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:.18s}" +
    ".hswo-tab:hover{border-color:#e11d2e;background:#e11d2e}" +
    ".hswo-tab svg{width:15px;height:15px}" +
    "html.hsw-owner .hswo-tab{border-color:#22c55e;background:rgba(22,163,74,.9)}" +
    ".hswo-ov{position:fixed;inset:0;z-index:2147483001;display:none;align-items:center;justify-content:center;padding:18px;background:rgba(5,5,9,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}" +
    ".hswo-ov.open{display:flex}" +
    ".hswo-box{width:100%;max-width:360px;padding:30px 26px 24px;border-radius:20px;background:linear-gradient(180deg,#171722,#0d0d14);border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px rgba(0,0,0,.6);color:#fff;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;position:relative}" +
    ".hswo-box h3{margin:10px 0 4px;font:800 22px/1.1 system-ui,sans-serif;letter-spacing:.01em}" +
    ".hswo-box p{margin:0 0 16px;color:#9a9aae;font-size:13.5px}" +
    ".hswo-ic{width:46px;height:46px;margin:0 auto;border-radius:14px;display:grid;place-items:center;background:#e11d2e;box-shadow:0 8px 24px rgba(225,29,46,.45)}" +
    ".hswo-ic svg{width:22px;height:22px}" +
    ".hswo-in{width:100%;height:52px;margin:0 0 10px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:#0a0a10;color:#fff;font:700 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.5em;text-align:center;outline:none}" +
    ".hswo-in.code{letter-spacing:.2em;font-size:18px;text-transform:uppercase}" +
    ".hswo-in:focus{border-color:#e11d2e;box-shadow:0 0 0 3px rgba(225,29,46,.25)}" +
    ".hswo-go{width:100%;height:50px;border:0;border-radius:12px;background:#e11d2e;color:#fff;font:800 15px/1 system-ui,sans-serif;letter-spacing:.05em;cursor:pointer}" +
    ".hswo-go:disabled{opacity:.6}" +
    ".hswo-msg{min-height:20px;margin:10px 0 0;font-size:13px;color:#ff6b78}" +
    ".hswo-lnk{margin-top:6px;background:none;border:0;color:#8a8aa0;font-size:12.5px;cursor:pointer;text-decoration:underline}" +
    ".hswo-x{position:absolute;top:10px;right:14px;background:none;border:0;color:#8a8aa0;font-size:24px;cursor:pointer;line-height:1}";
  document.head.appendChild(css);

  var LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  var ov = document.createElement("div");
  ov.className = "hswo-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true");
  ov.innerHTML = '<div class="hswo-box"><button class="hswo-x" aria-label="Close">&times;</button><div class="hswo-ic">' + LOCK + '</div><h3></h3><p></p>' +
    '<form autocomplete="off"><input class="hswo-in code" name="code" placeholder="SETUP CODE" style="display:none" autocomplete="off">' +
    '<input class="hswo-in" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="10" placeholder="••••••" autocomplete="one-time-code">' +
    '<button class="hswo-go" type="submit"></button></form><div class="hswo-msg" role="alert"></div><button class="hswo-lnk" type="button" style="display:none"></button></div>';
  document.body.appendChild(ov);
  var $ = function (s) { return ov.querySelector(s); };
  var form = $("form"), pin = $("[name=pin]"), code = $("[name=code]"), go = $(".hswo-go"), msg = $(".hswo-msg"), lnk = $(".hswo-lnk"), h = $("h3"), p = $("p");
  var mode = "login";

  function setMode(m) {
    mode = m; msg.textContent = ""; pin.value = ""; code.value = "";
    code.style.display = m === "setup" ? "" : "none";
    if (m === "setup") { h.textContent = "Create your PIN"; p.textContent = "One time. Enter your setup code and choose 6 to 10 digits."; go.textContent = "SAVE PIN"; lnk.style.display = "none"; }
    else { h.textContent = "Owner login"; p.textContent = "Enter your PIN."; go.textContent = "ENTER"; lnk.textContent = "Forgot PIN"; lnk.style.display = ""; }
  }
  function open() {
    if (window.HSW_OWNER) { if (confirm("Sign out of owner mode?")) setOwner(false); return; }
    ov.classList.add("open");
    call({ a: "status" }).then(function (s) { setMode(s && s.set === false ? "setup" : "login"); setTimeout(function () { (mode === "setup" ? code : pin).focus(); }, 30); });
    setMode("login");
  }
  function close() { ov.classList.remove("open"); }
  $(".hswo-x").onclick = close;
  ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  lnk.onclick = function () { setMode("setup"); code.focus(); };
  pin.addEventListener("input", function () { pin.value = pin.value.replace(/\D/g, ""); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!/^\d{6,10}$/.test(pin.value)) { msg.textContent = "PIN is 6 to 10 digits."; return; }
    go.disabled = true; msg.textContent = "";
    call(mode === "setup" ? { a: "setup", code: code.value, pin: pin.value } : { a: "login", pin: pin.value }).then(function (r) {
      go.disabled = false;
      if (r && r.ok && r.token) { setOwner(true, r.token); close(); }
      else if (r && r.needSetup) { setMode("setup"); msg.textContent = r.error; }
      else { msg.textContent = (r && r.error) || "Try again."; pin.value = ""; }
    });
  });

  // buttons: hook the app's own owner link if it has one, else add the floating tab
  var btns = [];
  function refreshBtns() { btns.forEach(function (b) { if (b.dataset.hswoOwn) b.querySelector(".hswo-lbl") && (b.querySelector(".hswo-lbl").textContent = window.HSW_OWNER ? "Owner ✓" : "Owner login"); }); }
  var existing = document.querySelectorAll("[data-owner],a.owner-btn,.owner-login");
  if (existing.length) {
    Array.prototype.forEach.call(existing, function (el) { el.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open(); }, true); });
  } else {
    var t = document.createElement("button");
    t.type = "button"; t.className = "hswo-tab"; t.dataset.hswoOwn = "1";
    t.innerHTML = LOCK + '<span class="hswo-lbl">Owner login</span>';
    t.onclick = open; document.body.appendChild(t); btns.push(t);
  }
  window.HSW_OWNER_OPEN = open;

  // restore session
  var tok = ls.get(KEY);
  if (tok) call({ a: "verify", token: tok }).then(function (r) { if (r && r.ok) setOwner(true); else ls.del(KEY); });
})();
