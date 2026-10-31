/* Bren & Gabo · capa de conexión
   Implementa la misma interfaz que usaba la app dentro de Claude
   (window.claude.use("db" | "assets" | "user" | "downloads"))
   pero sobre Supabase, con login, fotos privadas y notificaciones. */
(() => {
  "use strict";
  const CFG = self.APP_CONFIG || {};
  const sb = supabase.createClient(CFG.supabaseUrl, CFG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "byg-auth" }
  });
  let role = null, session = null, readyRes;
  const ready = new Promise(r => (readyRes = r));
  const $ = s => document.querySelector(s);

  /* ---------- errores ---------- */
  function wrapErr(e) {
    const m = String((e && (e.message || e.error_description)) || e || "");
    if (/sin_permiso/.test(m)) return { ui: "Eso solo lo puede cambiar Gabo 😉" };
    if (/not_found/.test(m)) return { code: "not_found", message: m };
    if (/Payload too large|exceeded the maximum/i.test(m)) return { code: "too_large" };
    if (/Failed to fetch|NetworkError|network/i.test(m)) return { ui: "Sin conexión. Probá de nuevo en un momento." };
    return { code: "error", message: m };
  }
  const chk = r => { if (r.error) throw wrapErr(r.error); return r.data; };

  /* ---------- service worker (fotos privadas, offline, push) ---------- */
  let swReg = null;
  async function sendToken() {
    if (!navigator.serviceWorker || !session) return;
    const msg = { type: "token", token: session.access_token };
    const c = navigator.serviceWorker.controller; if (c) c.postMessage(msg);
    if (swReg && swReg.active) swReg.active.postMessage(msg);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").then(r => { swReg = r; sendToken(); }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", async ev => {
      if (ev.data && ev.data.type === "need-token") {
        const { data } = await sb.auth.getSession(); session = data.session || session; sendToken();
      }
    });
    navigator.serviceWorker.addEventListener("controllerchange", sendToken);
  }

  /* ---------- login ---------- */
  const LOGIN_CSS = `
  #bygLogin{position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:24px;background:linear-gradient(135deg,#C2185B,#7E57C2);font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
  #bygLogin .card{width:min(380px,100%);background:#fff;color:#1d1922;border-radius:28px;padding:28px 22px;display:flex;flex-direction:column;gap:12px;box-shadow:0 30px 60px -25px rgba(0,0,0,.5)}
  #bygLogin img{width:72px;height:72px;border-radius:20px;align-self:center}
  #bygLogin h1{font-family:Georgia,serif;font-weight:400;font-size:1.9rem;text-align:center;margin:0}
  #bygLogin p{margin:0;text-align:center;color:#6b6472;font-size:.92rem}
  #bygLogin label{font-size:.75rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#6b6472}
  #bygLogin input{font:inherit;font-size:16px;padding:12px 14px;border-radius:14px;border:1px solid #e3dde6;background:#faf7fb;width:100%;box-sizing:border-box}
  #bygLogin button{font:inherit;font-weight:800;border:0;border-radius:999px;padding:13px;background:#C2185B;color:#fff;cursor:pointer}
  #bygLogin button:disabled{opacity:.6}
  #bygLogin .err{color:#c0392b;min-height:1.2em;font-size:.88rem;text-align:center}`;
  function showLogin(msg) {
    if (!$("#bygLoginCss")) { const st = document.createElement("style"); st.id = "bygLoginCss"; st.textContent = LOGIN_CSS; document.head.append(st); }
    let w = $("#bygLogin");
    if (!w) {
      w = document.createElement("div"); w.id = "bygLogin";
      w.innerHTML = `<form class="card" autocomplete="on">
        <img src="/icon-192.png" alt="">
        <h1>Bren &amp; Gabo</h1><p>Nuestro espacio. Entrá con tu mail y tu contraseña.</p>
        <div><label for="bygEmail">Mail</label><input id="bygEmail" type="email" autocomplete="username" required></div>
        <div><label for="bygPass">Contraseña</label><input id="bygPass" type="password" autocomplete="current-password" required></div>
        <button type="submit" id="bygGo">Entrar</button><div class="err" id="bygErr" role="alert"></div></form>`;
      document.body.append(w);
      w.querySelector("form").addEventListener("submit", async e => {
        e.preventDefault(); const b = $("#bygGo"); b.disabled = true; $("#bygErr").textContent = "";
        const r = await sb.auth.signInWithPassword({ email: $("#bygEmail").value.trim().toLowerCase(), password: $("#bygPass").value });
        b.disabled = false;
        if (r.error) { $("#bygErr").textContent = /Invalid login/i.test(r.error.message) ? "Mail o contraseña incorrectos." : "No se pudo entrar. Probá de nuevo."; return; }
        afterLogin(r.data.session);
      });
    }
    if (msg) $("#bygErr").textContent = msg;
    w.hidden = false; setTimeout(() => { const i = $("#bygEmail"); if (i) i.focus(); }, 50);
  }
  async function afterLogin(s) {
    session = s;
    const { data, error } = await sb.rpc("my_role");
    if (error || !data) { await sb.auth.signOut({ scope: "local" }); showLogin("Este mail no tiene acceso a la app."); return; }
    role = data; sendToken();
    const w = $("#bygLogin"); if (w) w.remove();
    readyRes();
  }
  sb.auth.onAuthStateChange((ev, s) => { if (s) { session = s; sendToken(); } });
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data.session) afterLogin(data.session);
    else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => showLogin());
    else showLogin();
  })();

  /* ---------- base de datos ---------- */
  const listeners = new Map(); // col -> Set<fn>
  const timers = new Map();
  function trigger(col) {
    const set = listeners.get(col); if (!set) return;
    clearTimeout(timers.get(col));
    timers.set(col, setTimeout(() => set.forEach(f => f()), 60));
  }
  function listen(col, fn) {
    if (!listeners.has(col)) listeners.set(col, new Set());
    listeners.get(col).add(fn);
    return () => listeners.get(col).delete(fn);
  }
  let channel = null;
  function startRealtime() {
    if (channel) return;
    channel = sb.channel("docs-all")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, p => trigger((p.new && p.new.col) || (p.old && p.old.col)))
      .subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) listeners.forEach((_, col) => trigger(col)); });

  const genId = () => { const a = new Uint8Array(15); crypto.getRandomValues(a); return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("").slice(0, 20); };
  const snapOf = rows => ({ docs: rows.map(r => ({ id: r.id, data: () => r.data })), size: rows.length, empty: !rows.length });

  class DocRef {
    constructor(col, id) { this.col = col; this.id = id; this.path = col + "/" + id; }
    async get() {
      const d = chk(await sb.from("docs").select("data").eq("col", this.col).eq("id", this.id).maybeSingle());
      return { exists: !!d, id: this.id, data: () => (d ? d.data : undefined) };
    }
    async set(data) {
      chk(await sb.from("docs").upsert({ col: this.col, id: this.id, data: data || {}, updated_at: new Date().toISOString() }));
      trigger(this.col);
    }
    async update(data) {
      const r = await sb.rpc("doc_update", { p_col: this.col, p_id: this.id, p_data: data || {} });
      if (r.error) throw wrapErr(r.error);
      trigger(this.col);
    }
    async delete() { chk(await sb.from("docs").delete().eq("col", this.col).eq("id", this.id)); trigger(this.col); }
    onSnapshot(fn, err) {
      startRealtime();
      const run = async () => { try { fn(await this.get()); } catch (e) { err && err(wrapErr(e)); } };
      const off = listen(this.col, run); run(); return off;
    }
  }
  class Query {
    constructor(col) { this.col = col; this.ord = null; this.lim = null; }
    doc(id) { return new DocRef(this.col, id || genId()); }
    orderBy(f, dir) { this.ord = [f, dir || "asc"]; return this; }
    limit(n) { this.lim = n; return this; }
    async rows() {
      let rows = chk(await sb.from("docs").select("id,data").eq("col", this.col).limit(5000));
      if (this.ord) { const [f, d] = this.ord, s = d === "desc" ? -1 : 1; rows.sort((a, b) => { const x = a.data[f], y = b.data[f]; return x === y ? 0 : (x === undefined ? 1 : y === undefined ? -1 : x < y ? -s : s); }); }
      if (this.lim) rows = rows.slice(0, this.lim);
      return rows;
    }
    async get() { return snapOf(await this.rows()); }
    onSnapshot(fn, err) {
      startRealtime();
      const run = async () => { try { fn(snapOf(await this.rows())); } catch (e) { err && err(wrapErr(e)); } };
      const off = listen(this.col, run); run(); return off;
    }
  }
  const db = {
    collection: col => new Query(col),
    doc: path => { const i = path.indexOf("/"); return new DocRef(path.slice(0, i), path.slice(i + 1)); }
  };

  /* ---------- fotos y videos ---------- */
  const hex32 = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, "0")).join(""); };
  const MEDIA_CACHE = "byg-media-v1";
  async function putCache(id, blob, type) {
    try { const c = await caches.open(MEDIA_CACHE); await c.put("/_blob/" + id, new Response(blob, { headers: { "Content-Type": type, "Content-Length": String(blob.size) } })); } catch (e) {}
  }
  const assets = {
    async upload(file, opts) {
      const type = (opts && opts.type) || file.type || "application/octet-stream";
      if (file.size > 50 * 1024 * 1024) throw { code: "too_large" };
      const id = (opts && opts.id) || hex32();
      const r = await sb.storage.from("media").upload(id, file, { contentType: type, cacheControl: "31536000", upsert: !!(opts && opts.id) });
      if (r.error) throw wrapErr(r.error);
      await putCache(id, file, type);
      return { id, url: "/_blob/" + id };
    },
    async delete(id) {
      await sb.storage.from("media").remove([id]);
      try { (await caches.open(MEDIA_CACHE)).delete("/_blob/" + id); } catch (e) {}
    }
  };

  /* ---------- usuario y descargas ---------- */
  const user = { isOwner: async () => role === "gabo", can: async () => true };
  const downloads = {
    async save({ filename, data }) {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
      const a = document.createElement("a"); a.href = url; a.download = filename || "archivo"; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: "saved" };
    }
  };

  window.claude = {
    use: async name => { await ready; return { db, assets, user, downloads }[name] || null; }
  };

  /* ---------- notificaciones push ---------- */
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const standalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const b64 = s => { const p = "=".repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, c => c.charCodeAt(0)); };
  async function pushState() {
    if (!pushSupported()) return isIOS && !standalone() ? "install" : "unsupported";
    if (Notification.permission === "denied") return "denied";
    const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription();
    return s ? "on" : "off";
  }
  async function enablePush() {
    const perm = await Notification.requestPermission(); if (perm !== "granted") return false;
    const reg = await navigator.serviceWorker.ready;
    let s = await reg.pushManager.getSubscription();
    if (!s) s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(CFG.vapidPublic) });
    const j = s.toJSON();
    chk(await sb.from("push_subs").upsert({ endpoint: j.endpoint, role, sub: j }));
    return true;
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.ready; const s = await reg.pushManager.getSubscription();
    if (s) { await sb.from("push_subs").delete().eq("endpoint", s.endpoint); await s.unsubscribe(); }
  }
  async function notify(body) {
    try {
      const { data } = await sb.auth.getSession(); if (!data.session) return 0;
      const r = await fetch("/api/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token }, body: JSON.stringify({ body: String(body || "").slice(0, 240) }) });
      if (!r.ok) return 0; const j = await r.json(); return j.sent || 0;
    } catch (e) { return 0; }
  }

  /* ---------- panel "Esta app" en Ajustes ---------- */
  const PANEL_CSS = `
  .byg-app .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .byg-app input[type=password]{font:inherit;font-size:16px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px;width:100%;box-sizing:border-box}
  .byg-app .st{font-size:.85rem;color:var(--muted)}
  .byg-banner{display:flex;gap:10px;align-items:center;background:var(--paper);border:1px solid var(--line);border-radius:18px;padding:10px 12px;font-size:.88rem}
  .byg-banner b{display:block}.byg-banner span{flex:1}.byg-banner button{flex:none}`;
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  async function renderPushRow(box) {
    box.replaceChildren();
    const st = await pushState(); const row = el("div", "row");
    if (st === "on") { row.append(el("span", "st", "✅ Activadas en este celu.")); const b = el("button", "ghost", "Desactivar"); b.type = "button"; b.onclick = async () => { await disablePush(); renderPushRow(box); }; row.append(b); }
    else if (st === "off") { row.append(el("span", "st", "Te avisa cuando hay algo nuevo, aunque la app esté cerrada.")); const b = el("button", "primary", "🔔 Activar notificaciones"); b.type = "button"; b.onclick = async () => { b.disabled = true; try { await enablePush(); } catch (e) { alertMsg("No se pudo activar. Probá de nuevo."); } renderPushRow(box); }; row.append(b); }
    else if (st === "install") row.append(el("span", "st", "En iPhone primero instalá la app: abrí esta página en Safari, tocá Compartir ⬆️ → «Agregar a inicio», y entrá desde ese ícono."));
    else if (st === "denied") row.append(el("span", "st", "Las notificaciones están bloqueadas. Habilitalas en Ajustes del celu → Notificaciones → Bren & Gabo."));
    else row.append(el("span", "st", "Este navegador no permite notificaciones."));
    box.append(row);
  }
  function alertMsg(t) { const tt = document.getElementById("toastTxt"); if (tt) { tt.textContent = t; const ts = document.getElementById("toast"); ts.hidden = false; setTimeout(() => (ts.hidden = true), 3000); } }
  async function injectPanel() {
    const view = document.getElementById("v-ajustes"); if (!view || document.getElementById("bygApp")) return;
    const st = document.createElement("style"); st.textContent = PANEL_CSS; document.head.append(st);
    const p = el("div", "panel byg-app"); p.id = "bygApp"; p.style.cssText = "padding:16px;display:flex;flex-direction:column;gap:12px";
    p.append(el("h3", null, "📱 Esta app"));
    p.append(el("span", "flabel", "Notificaciones")); const pr = el("div"); p.append(pr); renderPushRow(pr);
    const f = el("div", "field"); const lb = el("label", null, "Cambiar mi contraseña"); lb.htmlFor = "bygNewPass";
    const ip = el("input"); ip.type = "password"; ip.id = "bygNewPass"; ip.autocomplete = "new-password"; ip.placeholder = "Mínimo 8 caracteres";
    const pb = el("button", "ghost", "Guardar contraseña"); pb.type = "button";
    pb.onclick = async () => { if (ip.value.length < 8) { alertMsg("La contraseña tiene que tener al menos 8 caracteres."); return; } pb.disabled = true; const r = await sb.auth.updateUser({ password: ip.value }); pb.disabled = false; ip.value = ""; alertMsg(r.error ? "No se pudo cambiar." : "Contraseña cambiada ✓"); };
    f.append(lb, ip); p.append(f, pb);
    const out = el("button", "ghost", "Cerrar sesión"); out.type = "button"; out.style.alignSelf = "flex-start";
    out.onclick = async () => { try { await disablePush(); } catch (e) {} await sb.auth.signOut(); location.reload(); };
    p.append(out);
    if (role === "gabo") {
      p.append(el("span", "flabel", "Importar datos (solo vos)"));
      const ib = el("label", "ghost upl"); ib.style.cssText = "position:relative;align-self:flex-start"; ib.append(document.createTextNode("Elegir archivo de migración (.zip)"));
      const fi = el("input", "ovl"); fi.type = "file"; fi.accept = ".zip,application/zip"; ib.append(fi);
      const im = el("span", "st"); im.setAttribute("role", "status");
      fi.onchange = async () => { const file = fi.files[0]; if (file) await importZip(file, t => (im.textContent = t)); fi.value = ""; };
      p.append(ib, im);
    }
    const anchor = view.querySelector(".vbanner"); anchor ? anchor.after(p) : view.prepend(p);
  }
  async function homeBanner() {
    const st = await pushState(); let k = "byg-banner-" + st; try { if (localStorage.getItem(k)) return; } catch (e) {}
    if (st !== "off" && st !== "install") return;
    const home = document.getElementById("homeCards"); if (!home || !home.parentNode) return;
    const b = el("div", "byg-banner"); const t = el("span");
    if (st === "install") t.innerHTML = "<b>📲 Instalá la app</b>Tocá Compartir ⬆️ → «Agregar a inicio». Así se abre como una app y te llegan notificaciones.";
    else t.innerHTML = "<b>🔔 Activá las notificaciones</b>Para enterarte cuando hay algo nuevo.";
    b.append(t);
    if (st === "off") { const on = el("button", "primary", "Activar"); on.type = "button"; on.onclick = async () => { on.disabled = true; try { if (await enablePush()) b.remove(); } catch (e) { on.disabled = false; } }; b.append(on); }
    const x = el("button", "ghost", "✕"); x.type = "button"; x.setAttribute("aria-label", "Cerrar"); x.onclick = () => { try { localStorage.setItem(k, "1"); } catch (e) {} b.remove(); }; b.append(x);
    home.parentNode.insertBefore(b, home);
  }
  ready.then(() => setTimeout(() => { injectPanel(); homeBanner(); }, 400));

  /* ---------- importador (migración desde Claude) ---------- */
  async function importZip(file, say) {
    if (!window.JSZip) { say("Falta la herramienta de zip. Recargá."); return; }
    try {
      say("Leyendo archivo…"); const zip = await JSZip.loadAsync(file);
      const meta = JSON.parse(await zip.file("datos.json").async("string"));
      const media = Object.keys(zip.files).filter(n => n.startsWith("media/") && !zip.files[n].dir);
      let i = 0, fail = 0;
      for (const n of media) {
        i++; say(`Subiendo fotos ${i} de ${media.length}…`);
        const id = n.slice(6).split(".")[0]; const type = (meta.types && meta.types[id]) || "image/jpeg";
        try {
          const blob = await zip.file(n).async("blob");
          const r = await sb.storage.from("media").upload(id, new Blob([blob], { type }), { contentType: type, cacheControl: "31536000", upsert: true });
          if (r.error) fail++; else await putCache(id, blob, type);
        } catch (e) { fail++; }
      }
      say("Guardando recuerdos…");
      const rows = []; for (const [col, docs] of Object.entries(meta.docs)) for (const [id, data] of Object.entries(docs)) rows.push({ col, id, data, updated_at: new Date().toISOString() });
      for (let k = 0; k < rows.length; k += 200) chk(await sb.from("docs").upsert(rows.slice(k, k + 200)));
      listeners.forEach((_, col) => trigger(col));
      say(`Listo ✓ ${rows.length} datos y ${media.length - fail} fotos importadas${fail ? ` (${fail} con error, probá importar de nuevo)` : ""}.`);
    } catch (e) { say("No se pudo importar: " + ((e && e.message) || e)); }
  }

  window.BYG = { sb, notify, pushState, enablePush, get role() { return role; } };
})();
