// HSW365studio AI Song service (Supabase Edge Function, Deno).
//
// The studio is a static site, so the music model's API key cannot live in it. This function holds the key,
// checks the caller's HSW365studio plan key (the same signed S365- key the site already uses), counts songs
// per member per month, and passes the request on to the music model.
//
// Secrets (Supabase > Edge Functions > Secrets):
//   ELEVENLABS_API_KEY      the music model key. If unset, the key in the database vault is used. Never put it in the site.
//   AI_MIN_PLAN             optional. Lowest plan that gets AI Song: starter | plus | pro. Default pro.
//   AI_SONGS_PER_MONTH      optional. Songs a member can make each calendar month. Default 10.
//   AI_STEMS_PER_MONTH      optional. Vocal / music splits each month. Default same as songs.
//   AI_MAX_SECONDS          optional. Longest song. Default 240.
//   AI_OWNER_EMAILS         optional. Comma list of emails with no limits.
//   AI_ALLOWED_ORIGINS      optional. Comma list of sites allowed to call this.
//   ELEVEN_MUSIC_MODEL      optional. Default music_v1.
//   LICENSE_PUBLIC_JWK      optional. JSON of the public key that signs plan keys, if it ever changes.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const env = (k: string, d = "") => Deno.env.get(k) ?? d;

const ELEVEN = env("ELEVEN_BASE", "https://api.elevenlabs.io");
const MODEL = env("ELEVEN_MUSIC_MODEL", "music_v1");
const MIN_PLAN = env("AI_MIN_PLAN", "pro");
const SONGS = Math.max(0, Number(env("AI_SONGS_PER_MONTH", "10")) || 10);
const STEMS = Math.max(0, Number(env("AI_STEMS_PER_MONTH", String(SONGS))) || SONGS);
const MAX_SECONDS = Math.min(600, Math.max(15, Number(env("AI_MAX_SECONDS", "240")) || 240));
const OWNERS = env("AI_OWNER_EMAILS", "hsw365media@gmail.com,hoodstarent365@gmail.com")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = env("AI_ALLOWED_ORIGINS", "https://hsw365.github.io,https://studio365.onrender.com,http://localhost:8080,http://127.0.0.1:8080")
  .split(",").map((s) => s.trim()).filter(Boolean);
const PUBLIC_JWK = JSON.parse(env("LICENSE_PUBLIC_JWK", JSON.stringify({
  kty: "EC", crv: "P-256",
  x: "LNUFFgy7bIbCJrx34ez5EjVq0SgmFM7Jwv4SSKYRVjU",
  y: "iKtrkat8OLkjCsViZKfnFIl3uxHMO0VV0W6qjKBj6v8",
})));
const RANK: Record<string, number> = { starter: 1, plus: 2, pro: 3 };
const DAY = 86400000;

// ---------------------------------------------------------------- http helpers
function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0],
    "Access-Control-Allow-Headers": "content-type, x-s365-key, authorization, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-songs-left, x-songs-limit, x-stems-left",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
const json = (req: Request, body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json", ...extra } });
const fail = (req: Request, status: number, code: string, message: string, more: Record<string, unknown> = {}) =>
  json(req, { ok: false, code, message, ...more }, status);

// ---------------------------------------------------------------- plan key check
function unb64u(str: string): Uint8Array {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4));
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
let pubKey: CryptoKey | null = null;
async function member(raw: string | null) {
  const m = String(raw || "").replace(/\s+/g, "").match(/S365-[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}/);
  if (!m) return { ok: false as const, status: 401, code: "no_key", message: "AI Song needs a HSW365studio plan. Turn your key on in the studio first." };
  try {
    const [body, sig] = m[0].slice(5).split(".");
    pubKey ??= await crypto.subtle.importKey("jwk", { ...PUBLIC_JWK, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const good = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, unb64u(sig), new TextEncoder().encode(body));
    if (!good) return { ok: false as const, status: 401, code: "bad_key", message: "That plan key is not valid." };
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (!p.x || Date.now() >= p.x * DAY) return { ok: false as const, status: 402, code: "expired", message: "Your plan has run out. Add a month to keep making songs." };
    const email = String(p.e || "").trim().toLowerCase();
    if (!email) return { ok: false as const, status: 401, code: "bad_key", message: "That plan key has no email on it." };
    const plan = RANK[p.p] ? String(p.p) : "pro";
    const owner = OWNERS.includes(email);
    if (!owner && RANK[plan] < (RANK[MIN_PLAN] || 3)) {
      return { ok: false as const, status: 402, code: "plan_too_low", message: `AI Song comes with the ${MIN_PLAN[0].toUpperCase() + MIN_PLAN.slice(1)} plan.`, need: MIN_PLAN };
    }
    return { ok: true as const, email, plan, owner };
  } catch {
    return { ok: false as const, status: 401, code: "bad_key", message: "That plan key could not be read." };
  }
}

// ---------------------------------------------------------------- usage (one row per song or split)
const SB_URL = env("SUPABASE_URL"), SB_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const month = () => new Date().toISOString().slice(0, 7);
const sbHeaders = { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, "content-type": "application/json" };

async function used(email: string, kind: string): Promise<number> {
  const u = `${SB_URL}/rest/v1/studio365_ai_usage?select=id&email=eq.${encodeURIComponent(email)}&kind=eq.${kind}&month=eq.${month()}`;
  const r = await fetch(u, { method: "HEAD", headers: { ...sbHeaders, prefer: "count=exact" } });
  if (!r.ok) throw new Error(`usage table: ${r.status}`);
  return Number((r.headers.get("content-range") || "*/0").split("/")[1]) || 0;
}
async function log(email: string, kind: string, plan: string, seconds: number, title: string) {
  const r = await fetch(`${SB_URL}/rest/v1/studio365_ai_usage`, {
    method: "POST", headers: { ...sbHeaders, prefer: "return=minimal" },
    body: JSON.stringify({ email, kind, plan, month: month(), seconds: Math.round(seconds) || null, title: title.slice(0, 120) || null }),
  });
  if (!r.ok) throw new Error(`usage table: ${r.status}`);
}
async function standing(who: { email: string; owner: boolean; plan: string }) {
  if (who.owner) return { songsLeft: 9999, songsLimit: 9999, stemsLeft: 9999, unlimited: true };
  const [s, t] = await Promise.all([used(who.email, "song"), used(who.email, "stems")]);
  return { songsLeft: Math.max(0, SONGS - s), songsLimit: SONGS, stemsLeft: Math.max(0, STEMS - t), unlimited: false };
}

// ---------------------------------------------------------------- the song plan
const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").trim().slice(0, max);
const tags = (v: unknown, n = 12) => (Array.isArray(v) ? v : []).map((x) => str(x, 60)).filter(Boolean).slice(0, n);

// Keep only what the model accepts, inside its limits, whatever the page sent.
function cleanPlan(p: any) {
  const sections = (Array.isArray(p?.sections) ? p.sections : []).slice(0, 30).map((s: any, i: number) => ({
    section_name: str(s?.section_name, 100) || `Part ${i + 1}`,
    positive_local_styles: tags(s?.positive_local_styles, 10),
    negative_local_styles: tags(s?.negative_local_styles, 10),
    duration_ms: Math.min(120000, Math.max(3000, Math.round(Number(s?.duration_ms) || 15000))),
    lines: (Array.isArray(s?.lines) ? s.lines : []).map((l: unknown) => str(l, 200)).filter(Boolean).slice(0, 30),
  }));
  return { positive_global_styles: tags(p?.positive_global_styles, 16), negative_global_styles: tags(p?.negative_global_styles, 16), sections };
}
const planMs = (p: { sections: { duration_ms: number }[] }) => p.sections.reduce((a, s) => a + s.duration_ms, 0);

// The model's own error text, in words a customer can act on.
async function modelError(req: Request, r: Response) {
  let d: any = null;
  try { d = (await r.json())?.detail; } catch { /* not json */ }
  const status = d?.status || "";
  if (status === "bad_prompt" || status === "bad_composition_plan") {
    return fail(req, 422, "rejected", "The music model would not make that as written. It usually means a real artist, band or song was named. Describe the sound instead and try again.", {
      suggestion: d?.data?.prompt_suggestion || null, planSuggestion: d?.data?.composition_plan_suggestion || null,
    });
  }
  if (r.status === 429 || status === "quota_exceeded") return fail(req, 503, "busy", "AI Song is at capacity right now. Try again in a few minutes. This did not use one of your songs.");
  if (r.status === 401 || r.status === 403) return fail(req, 503, "service_key", "AI Song is not switched on yet. The studio owner has been told.");
  return fail(req, 502, "model_error", (typeof d?.message === "string" && d.message) || "The music model had a problem. Try again. This did not use one of your songs.");
}

// The music key: the ELEVENLABS_API_KEY secret if set, otherwise the one kept encrypted in the database vault
// (public.studio365_ai_key(), which only this service can call).
let musicKey = env("ELEVENLABS_API_KEY");
async function getKey(): Promise<string> {
  if (musicKey) return musicKey;
  try {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/studio365_ai_key`, { method: "POST", headers: sbHeaders, body: "{}" });
    if (r.ok) musicKey = String((await r.json()) || "");
  } catch { /* stays empty */ }
  return musicKey;
}
const eleven = async (path: string, init: RequestInit) =>
  fetch(ELEVEN + path, { ...init, headers: { "xi-api-key": await getKey(), ...(init.headers || {}) } });

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== "POST") return fail(req, 405, "method", "POST only.");
  const action = new URL(req.url).searchParams.get("action") || "status";

  const who = await member(req.headers.get("x-s365-key"));
  if (!who.ok) return fail(req, who.status, who.code, who.message, { need: (who as any).need || MIN_PLAN });
  if (!(await getKey())) return fail(req, 503, "service_key", "AI Song is not switched on yet. The studio owner has been told.");

  try {
    const st = await standing(who);
    const info = { ok: true, email: who.email, plan: who.plan, ...st, maxSeconds: MAX_SECONDS };
    if (action === "status") return json(req, info);

    // ---- write the plan: sections, styles and lyrics. Costs nothing, so it is not counted.
    if (action === "plan") {
      const b = await req.json().catch(() => ({}));
      const prompt = str(b.prompt, 2000);
      if (prompt.length < 4) return fail(req, 400, "empty", "Say what the song is about first.");
      const seconds = Math.min(MAX_SECONDS, Math.max(15, Number(b.seconds) || 120));
      const r = await eleven("/v1/music/plan", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, music_length_ms: Math.round(seconds * 1000), model_id: MODEL }),
      });
      if (!r.ok) return modelError(req, r);
      return json(req, { ...info, songPlan: cleanPlan(await r.json()) });
    }

    // ---- make the song. One song off the month once the model has accepted it.
    if (action === "compose") {
      if (st.songsLeft <= 0) return fail(req, 402, "out_of_songs", `You have made all ${SONGS} of this month's songs. More arrive on the 1st.`, st);
      const b = await req.json().catch(() => ({}));
      const body: Record<string, unknown> = { model_id: MODEL };
      let seconds = 0;
      if (b.songPlan) {
        const plan = cleanPlan(b.songPlan);
        if (!plan.sections.length) return fail(req, 400, "empty", "The song has no parts yet.");
        seconds = planMs(plan) / 1000;
        if (seconds > MAX_SECONDS + 1) return fail(req, 400, "too_long", `Songs can run up to ${Math.floor(MAX_SECONDS / 60)}:${String(MAX_SECONDS % 60).padStart(2, "0")}. Shorten or remove a part.`);
        body.composition_plan = plan;
        body.respect_sections_durations = true;
      } else {
        const prompt = str(b.prompt, 2000);
        if (prompt.length < 4) return fail(req, 400, "empty", "Say what the song is about first.");
        seconds = Math.min(MAX_SECONDS, Math.max(15, Number(b.seconds) || 120));
        body.prompt = prompt;
        body.music_length_ms = Math.round(seconds * 1000);
        if (b.instrumental) body.force_instrumental = true;
      }
      const r = await eleven("/v1/music/stream?output_format=mp3_44100_128", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (!r.ok || !r.body) return modelError(req, r);
      if (!who.owner) await log(who.email, "song", who.plan, seconds, str(b.title, 120));
      return new Response(r.body, {
        headers: {
          ...cors(req), "content-type": "audio/mpeg", "cache-control": "no-store",
          "x-songs-left": String(Math.max(0, st.songsLeft - 1)), "x-songs-limit": String(st.songsLimit),
        },
      });
    }

    // ---- split a song into vocal and music so each lands on its own track in the studio.
    if (action === "stems") {
      if (st.stemsLeft <= 0) return fail(req, 402, "out_of_stems", "You have used this month's vocal and music splits. More arrive on the 1st.", st);
      const audio = await req.arrayBuffer();
      if (audio.byteLength < 2000) return fail(req, 400, "empty", "There is no song to split.");
      if (audio.byteLength > 30 * 1024 * 1024) return fail(req, 413, "too_big", "That song is too large to split.");
      const form = new FormData();
      form.append("file", new Blob([audio], { type: "audio/mpeg" }), "song.mp3");
      form.append("stem_variation_id", "two_stems_v1");
      const r = await eleven("/v1/music/stem-separation?output_format=mp3_44100_192", { method: "POST", body: form });
      if (!r.ok || !r.body) return modelError(req, r);
      if (!who.owner) await log(who.email, "stems", who.plan, 0, "");
      return new Response(r.body, {
        headers: { ...cors(req), "content-type": "application/zip", "cache-control": "no-store", "x-stems-left": String(Math.max(0, st.stemsLeft - 1)) },
      });
    }

    return fail(req, 400, "action", "Unknown action.");
  } catch (e) {
    console.error("studio365-ai", action, e);
    return fail(req, 500, "server", "AI Song had a problem on our side. Try again. This did not use one of your songs.");
  }
});
