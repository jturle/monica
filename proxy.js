// monica CDP proxy.
//
// Chromium's real DevTools endpoint runs on an INTERNAL port (127.0.0.1:9223).
// This proxy owns the PUBLIC port (9222) that tunnels/clients connect to. It is a
// transparent WebSocket relay, except it special-cases two browser-level methods:
//
//   Target.createTarget  (what puppeteer.newPage() sends) — Electron can't honor
//     it, so instead we ask monica to create a PANE, wait for that webview's CDP
//     target to appear, and return its targetId. Puppeteer then attaches to the
//     real target normally; the rest of newPage() flows through untouched.
//
//   Target.closeTarget   (page.close()) — we remove the corresponding pane.
//
// Each browser-endpoint connection becomes a named monica tab; the panes it
// creates tile within that tab.

const http = require("http");
const dnsp = require("dns").promises;
const { WebSocketServer, WebSocket } = require("ws");

const INTERNAL_HTTP = "http://127.0.0.1:9223";
const INTERNAL_WS = "ws://127.0.0.1:9223";
const PUBLIC_PORT = 9222;

let httpServer = null;
let wss = null;
let bindAddr = "127.0.0.1";
let hooks = {};
let logFn = () => {};

let connSeq = 0;
const hostCounters = new Map(); // host -> count
const targetToPane = new Map(); // CDP targetId -> { connectionId, leafId, scopeKey, lastActivity }
// targetId -> Set<sessionId> attached to it (via flatten auto-attach). Used to
// synthesize Target.detachedFromTarget events when we fake a close (pinned pane).
const sessionsByTarget = new Map();
// Reverse lookup: sessionId -> targetId. Used to route Page.printToPDF (and any
// future per-target hooks) from the wire sessionId back to a pane.
const targetBySession = new Map();
let createChain = Promise.resolve(); // serialize createTarget handling for clean correlation

// Runtime-tunable behaviour driven by monica-settings.json (main pushes via setSettings).
let cfg = { closeOnDisconnect: "close", closeDelaySeconds: 10, slowMo: 0 };
// Pending close timers keyed by session name (for closeOnDisconnect = "delay").
const pendingCloseBySession = new Map();

// Per-pane activity throttling: only fire onActivity at most once per 500ms per pane,
// otherwise the renderer's ticker is enough and we don't spam IPC.
const ACTIVITY_THROTTLE_MS = 500;
const lastActivityEmit = new Map(); // leafId -> ts
function bumpActivity(leafId) {
  const now = Date.now();
  for (const e of targetToPane.values()) if (e.leafId === leafId) e.lastActivity = now;
  const last = lastActivityEmit.get(leafId) || 0;
  if (now - last >= ACTIVITY_THROTTLE_MS) { lastActivityEmit.set(leafId, now); hooks.onActivity?.(leafId); }
}
function bumpFromMessage(ctx, msg) {
  // Per-target message → bump just that pane. Otherwise bump every pane on this
  // connection (browser-level chatter still means "the agent is doing something here").
  const sid = msg && msg.sessionId;
  if (sid && targetToPane.has(sid)) { bumpActivity(targetToPane.get(sid).leafId); return; }
  if (ctx.connectionId == null) return;
  for (const e of targetToPane.values()) if (e.connectionId === ctx.connectionId) bumpActivity(e.leafId);
}

// Methods we slow on the client→backend path when slowMo > 0. Limited to user-facing
// actions so plumbing (Page.enable / Runtime.enable / Target.* / Network.enable …)
// isn't delayed and clients don't desync during attach.
const SLOW_METHODS = new Set([
  "Page.navigate", "Page.reload", "Page.captureScreenshot",
  "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchTouchEvent",
  "Input.insertText", "Input.dispatchDragEvent",
  "Runtime.evaluate", "Runtime.callFunctionOn",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  const r = await fetch(INTERNAL_HTTP + path);
  return r.json();
}

async function waitForInternal(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try { return await fetchJson("/json/version"); } catch { await sleep(200); }
  }
  throw new Error("monica proxy: internal CDP (9223) never came up");
}

async function listWebviewIds() {
  try {
    return (await fetchJson("/json/list")).filter((t) => t.type === "webview").map((t) => t.id);
  } catch { return []; }
}

async function waitForNewWebview(before, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const now = await listWebviewIds();
    const fresh = now.find((id) => !before.has(id));
    if (fresh) return fresh;
    await sleep(80);
  }
  return null;
}

async function reverseDns(ip, ms) {
  try {
    const names = await Promise.race([
      dnsp.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error("dns timeout")), ms)),
    ]);
    return names && names[0];
  } catch { return null; }
}

const rewriteWsHost = (u, host) => (u || "").replace(/^ws:\/\/[^/]+/, "ws://" + host);
function sendJson(res, obj) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function reply(client, obj) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj));
}

const ROOT_PAGE =
  '<!doctype html><meta charset="utf-8"><title>monica</title>' +
  '<body style="font-family:-apple-system,system-ui,sans-serif;background:#0b0e14;color:#c7d0df;padding:40px">' +
  '<h1 style="color:#38e1c4;margin:0 0 8px">monica CDP proxy</h1>' +
  '<p>Enumerate targets at <a style="color:#38e1c4" href="/json">/json</a> · connect a CDP client to this origin.</p></body>';

// Hide monica's own shell (and DevTools windows) from a client's target
// DISCOVERY only: strip them from Target.getTargets results and drop
// targetCreated/targetInfoChanged for them. We deliberately do NOT touch
// Target.attachedToTarget — dropping that desyncs flatten auto-attach
// (puppeteer) and hangs connect. agent-browser picks its page from getTargets
// and creates one when none remain, so this makes it open a real pane instead
// of taking over monica's UI.
function isHiddenInfo(t) {
  const url = (t && t.url) || "";
  if (url.startsWith("devtools://")) return true;
  if (t && t.type === "page" && url.startsWith("file://") && url.includes("/renderer/index.html")) return true;
  return false;
}
function ownerScope(targetId) {
  const e = targetToPane.get(targetId);
  return e ? e.scopeKey : undefined;
}
// A target is visible to a connection if it isn't monica's shell AND it belongs
// to that connection's scope (its ?session=, or a per-connection key). This gives
// each session its own panes — agent-browser's getTargets comes back with only
// this session's pages, so it creates its own instead of trampling another's.
function visibleTo(ctx, t) {
  if (isHiddenInfo(t)) return false;
  if (!ctx.scopeKey) return true; // unscoped (e.g. a direct page socket)
  return ownerScope(t && t.targetId) === ctx.scopeKey;
}
function filterBackendToClient(ctx, text) {
  // Fast-path: only parse messages that could carry the fields we care about.
  if (!(text.includes("targetInfo") || text.includes("targetInfos") ||
        text.includes("attachedToTarget") || text.includes("detachedFromTarget"))) return text;
  let msg;
  try { msg = JSON.parse(text); } catch { return text; }
  // Track which sessions are attached to which targets (flatten auto-attach), so
  // we can emit clean detach events when faking a close for a pinned pane.
  if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId && msg.params?.targetInfo?.targetId) {
    const tid = msg.params.targetInfo.targetId;
    if (!sessionsByTarget.has(tid)) sessionsByTarget.set(tid, new Set());
    sessionsByTarget.get(tid).add(msg.params.sessionId);
    targetBySession.set(msg.params.sessionId, tid);
  } else if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId && msg.params?.targetId) {
    sessionsByTarget.get(msg.params.targetId)?.delete(msg.params.sessionId);
    targetBySession.delete(msg.params.sessionId);
  }
  if ((msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") &&
      msg.params && !visibleTo(ctx, msg.params.targetInfo)) {
    return null;
  }
  if (msg.result && Array.isArray(msg.result.targetInfos)) {
    const before = msg.result.targetInfos.length;
    msg.result.targetInfos = msg.result.targetInfos.filter((t) => visibleTo(ctx, t));
    if (msg.result.targetInfos.length !== before) {
      logFn("proxy", "getTargets scope=" + (ctx.scopeKey || "-"), "->", msg.result.targetInfos.length + "/" + before);
      return JSON.stringify(msg);
    }
  }
  return text;
}

// ---- HTTP: discovery endpoints, with ws URLs pointed back at this proxy -----

async function handleHttp(req, res) {
  const host = req.headers.host || bindAddr + ":" + PUBLIC_PORT;
  // Strip a trailing slash so clients that append it (Playwright's connectOverCDP
  // requests /json/version/) still hit the right route.
  let path = (req.url || "/").split("?")[0];
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  logFn("http", req.method, path);
  try {
    if (path === "/json/version") {
      const v = await fetchJson("/json/version");
      v.webSocketDebuggerUrl = rewriteWsHost(v.webSocketDebuggerUrl, host);
      return sendJson(res, v);
    }
    if (path === "/json" || path === "/json/" || path === "/json/list") {
      const list = (await fetchJson("/json/list")).filter((t) => !isHiddenInfo(t));
      for (const t of list) {
        if (t.webSocketDebuggerUrl) t.webSocketDebuggerUrl = rewriteWsHost(t.webSocketDebuggerUrl, host);
        delete t.devtoolsFrontendUrl; // would point clients at the internal :9223 endpoint
        delete t.devtoolsFrontendUrlCompat;
      }
      return sendJson(res, list);
    }
    if (path === "/json/protocol") {
      const r = await fetch(INTERNAL_HTTP + "/json/protocol");
      res.writeHead(r.status, { "content-type": "application/json" });
      return res.end(await r.text());
    }
    if (path === "/" || path === "") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(ROOT_PAGE);
    }
    // Don't proxy Chromium's root listing / DevTools frontend / /json/new — they
    // leak the internal endpoint and bypass the proxy.
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("monica proxy: not found");
  } catch (e) {
    res.writeHead(502);
    res.end("monica proxy error: " + e.message);
  }
}

// ---- WebSocket relay -------------------------------------------------------

function onConnection(client, req) {
  const fullUrl = req.url || "/";
  const path = fullUrl.split("?")[0];
  const isBrowser = path.startsWith("/devtools/browser/");
  logFn("conn", "ws connect", isBrowser ? "browser" : "page", path, "from", req.socket.remoteAddress || "?");
  const ctx = { client, backend: null, isBrowser, connectionId: null, backendOpen: false, pending: [] };

  const backend = new WebSocket(INTERNAL_WS + path, { perMessageDeflate: false });
  ctx.backend = backend;
  backend.on("open", () => {
    ctx.backendOpen = true;
    for (const m of ctx.pending) backend.send(m);
    ctx.pending = [];
  });
  backend.on("message", (d) => {
    const text = typeof d === "string" ? d : d.toString();
    const out = filterBackendToClient(ctx, text);
    if (out !== null && client.readyState === WebSocket.OPEN) client.send(out);
    // Bump activity for whatever pane this message concerns (events + responses).
    if (ctx.connectionId != null) {
      try { bumpFromMessage(ctx, JSON.parse(text)); } catch {}
    }
  });
  backend.on("close", () => { try { client.close(); } catch {} });
  backend.on("error", () => { try { client.close(); } catch {} });

  client.on("message", (d) => handleClientMessage(ctx, d));
  client.on("close", () => {
    try { backend.close(); } catch {}
    logFn("conn", "ws close", ctx.connectionId != null ? "#" + ctx.connectionId : path);
    if (ctx.connectionId == null) return;
    // A NAMED ?session= owns its panes for the life of its connection. agent-browser
    // keeps one connection per session and only drops it on `close` (session end), so
    // a disconnect means "discard this session" — close its panes. This is the
    // last-mile the agent-browser CDP `close` can't do itself (it only detaches, and
    // its binary won't close a session's final tab over CDP).
    //
    // An ANONYMOUS connection (e.g. puppeteer.disconnect()) is a mere detach: retain
    // its panes, matching real Chrome, so a human can take over after the agent leaves.
    if (ctx.named) {
      const closeNow = () => {
        for (const [tid, e] of targetToPane) {
          if (e.connectionId !== ctx.connectionId) continue;
          if (hooks.isPinned?.(e.leafId)) {
            logFn("proxy", "skip close (pinned) leaf=" + e.leafId);
            continue;
          }
          targetToPane.delete(tid);
          logFn("proxy", "session end #" + ctx.connectionId, "-> close pane leaf=" + e.leafId);
          hooks.closePane?.(e.leafId);
        }
      };
      const mode = cfg.closeOnDisconnect;
      if (mode === "retain") {
        logFn("conn", "session disconnect #" + ctx.connectionId + " — retain (per setting)");
      } else if (mode === "delay") {
        const ms = Math.max(0, (cfg.closeDelaySeconds | 0)) * 1000;
        logFn("conn", "session disconnect #" + ctx.connectionId + " — delay close " + ms + "ms");
        const t = setTimeout(() => { pendingCloseBySession.delete(ctx.session || ""); closeNow(); }, ms);
        if (ctx.session) pendingCloseBySession.set(ctx.session, t);
      } else {
        closeNow();
      }
    }
    hooks.onConnectionClose?.(ctx.connectionId);
  });
  client.on("error", () => { try { backend.close(); } catch {} });

  if (isBrowser) {
    ctx.connectionId = ++connSeq;
    openConnection(ctx, fullUrl, req);
  }
}

// Open the connection's tab SYNCHRONOUSLY (before any createTarget can arrive, so
// the pane lands in the right tab and we don't spawn a duplicate). Label with an
// immediate IP-based name, then refine to a reverse-DNS hostname asynchronously.
function openConnection(ctx, fullUrl, req) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  let session = null;
  const qi = fullUrl.indexOf("?");
  if (qi >= 0) {
    try { session = new URLSearchParams(fullUrl.slice(qi + 1)).get("session"); } catch {}
  }
  // Scope key isolates targets: a stable ?session= for named sessions, else a
  // per-connection key. Independent of the (async-refined) display name.
  ctx.scopeKey = session || "conn-" + ctx.connectionId;
  ctx.session = session || null;
  // A named ?session= owns its panes: when its connection drops we treat that as
  // the session ending and discard them (see the close handler). An anonymous
  // connection is a mere detach and its panes are retained.
  ctx.named = !!session;
  const baseHost = !ip || ip === "127.0.0.1" || ip === "::1" ? "localhost" : ip;
  const n = (hostCounters.get(baseHost) || 0) + 1;
  hostCounters.set(baseHost, n);
  const name = session || baseHost + ":#" + n;
  logFn("conn", "open #" + ctx.connectionId, "session=" + (session || "-"), "name=" + name, "scope=" + ctx.scopeKey);
  // Cancel any pending delayed close for this same session — a reconnect happened.
  if (session && pendingCloseBySession.has(session)) {
    clearTimeout(pendingCloseBySession.get(session));
    pendingCloseBySession.delete(session);
    logFn("conn", "cancel pending close for session=" + session);
  }
  // Third arg is the *named* session (or null) so the renderer can decide
  // whether to give panes a persistent per-session partition; the label arg
  // above is the human display name (may be a synthesized "host:#n").
  hooks.onConnectionOpen?.(ctx.connectionId, name, session || null);

  if (!session && baseHost !== "localhost") {
    reverseDns(ip, 1000).then((host) => {
      if (host && host !== baseHost) {
        const refined = host + ":#" + n;
        logFn("conn", "rename #" + ctx.connectionId, refined);
        hooks.onConnectionLabel?.(ctx.connectionId, refined);
      }
    });
  }
}

function forward(ctx, text) {
  if (ctx.backendOpen) ctx.backend.send(text);
  else ctx.pending.push(text);
}

function handleClientMessage(ctx, data) {
  const text = typeof data === "string" ? data : data.toString();
  let msg;
  try { msg = JSON.parse(text); } catch { return forward(ctx, text); }

  if (msg.method) {
    logFn("cdp", "→", msg.method, msg.id != null ? "#" + msg.id : "", msg.sessionId ? "@" + String(msg.sessionId).slice(0, 8) : "");
  }
  bumpFromMessage(ctx, msg);

  // monica panes render at their on-screen size. Neutralize client viewport
  // emulation (puppeteer.connect defaults to an 800x600 override) so the page
  // fills its pane and reflows as the pane is tiled/resized.
  if (msg.method === "Emulation.setDeviceMetricsOverride" || msg.method === "Emulation.setVisibleSize") {
    return reply(ctx.client, { id: msg.id, sessionId: msg.sessionId, result: {} });
  }

  if (ctx.isBrowser && msg.method === "Target.createTarget") {
    createChain = createChain
      .then(() => doCreate(ctx, msg))
      .catch((err) => reply(ctx.client, { id: msg.id, error: { code: -32000, message: String(err?.message || err) } }));
    return;
  }
  if (msg.method === "Target.closeTarget") {
    const tid = msg.params && msg.params.targetId;
    if (tid && targetToPane.has(tid)) {
      const e = targetToPane.get(tid);
      // Pin = "user-protected": ack the close to the client so it moves on, and
      // de-scope the target so the agent's next getTargets won't see it — but
      // keep the pane alive in monica.
      if (hooks.isPinned?.(e.leafId)) {
        targetToPane.delete(tid);
        logFn("proxy", "closeTarget", tid, "-> skipped (pinned) leaf=" + e.leafId);
        // We're not actually destroying the target — synthesize the full
        // close-time sequence Chromium would normally emit, so Playwright's
        // page.close() resolves: detach every attached session first, then
        // targetDestroyed, then ack the command.
        const sids = sessionsByTarget.get(tid);
        if (sids) {
          for (const sid of sids) {
            reply(ctx.client, { method: "Target.detachedFromTarget", params: { sessionId: sid, targetId: tid } });
          }
          sessionsByTarget.delete(tid);
        }
        reply(ctx.client, { method: "Target.targetDestroyed", params: { targetId: tid } });
        reply(ctx.client, { id: msg.id, result: { success: true } });
        return;
      }
      targetToPane.delete(tid);
      logFn("proxy", "closeTarget", tid, "-> close pane leaf=" + e.leafId);
      Promise.resolve(hooks.closePane?.(e.leafId)).finally(() => reply(ctx.client, { id: msg.id, result: { success: true } }));
      return;
    }
  }
  // Page.printToPDF: Chromium gates this to --headless mode, but Electron's
  // <webview>.printToPDF works fine. Route through main to the right pane,
  // generate locally, and reply with the same { data: <base64> } CDP would.
  if (msg.method === "Page.printToPDF") {
    const sid = msg.sessionId;
    const tid = sid ? targetBySession.get(sid) : null;
    const e = tid ? targetToPane.get(tid) : null;
    if (e && hooks.printToPDF) {
      logFn("proxy", "printToPDF leaf=" + e.leafId);
      Promise.resolve()
        .then(() => hooks.printToPDF(e.leafId, msg.params || {}))
        .then((data) => {
          logFn("proxy", "printToPDF reply leaf=" + e.leafId + " " + (data ? data.length : 0) + " base64-chars");
          reply(ctx.client, { id: msg.id, sessionId: sid, result: { data } });
        })
        .catch((err) => {
          logFn("proxy", "printToPDF error leaf=" + e.leafId + " " + String(err?.message || err));
          reply(ctx.client, { id: msg.id, sessionId: sid, error: { code: -32000, message: String(err?.message || err) } });
        });
      return;
    }
    // No mapping (browser-level call?) — let Chromium try, even though it'll fail
    // with the usual "only supported in headless" message.
  }

  // Slow-motion: delay user-facing commands by cfg.slowMo (puppeteer-style demo pacing).
  // We don't slow plumbing (Page.enable/Target.*/Network.enable …) so attach doesn't desync.
  if (cfg.slowMo > 0 && msg.method && SLOW_METHODS.has(msg.method)) {
    setTimeout(() => forward(ctx, text), cfg.slowMo);
    return;
  }
  forward(ctx, text);
}

async function doCreate(ctx, msg) {
  const url = (msg.params && msg.params.url) || "about:blank";
  const before = new Set(await listWebviewIds());
  const { leafId } = (await hooks.createPane(ctx.connectionId, url)) || {};
  const targetId = await waitForNewWebview(before, 10000);
  if (!targetId) throw new Error("monica: new pane did not register a CDP target");
  targetToPane.set(targetId, { connectionId: ctx.connectionId, leafId, scopeKey: ctx.scopeKey, lastActivity: Date.now() });
  logFn("proxy", "createTarget url=" + url, "scope=" + ctx.scopeKey, "-> pane leaf=" + leafId, "target=" + targetId);
  reply(ctx.client, { id: msg.id, result: { targetId } });
}

// ---- lifecycle -------------------------------------------------------------

function listen(addr) {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer(handleHttp);
    wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", onConnection);
    httpServer.once("error", reject);
    httpServer.listen(PUBLIC_PORT, addr, () => resolve());
  });
}

function closeServers() {
  return new Promise((resolve) => {
    try { wss?.close(); } catch {}
    if (httpServer) httpServer.close(() => resolve());
    else resolve();
  });
}

async function start(opts) {
  hooks = opts.hooks || {};
  bindAddr = opts.bindAddr || "127.0.0.1";
  if (opts.log) logFn = opts.log;
  if (opts.settings) setSettings(opts.settings);
  await waitForInternal();
  await listen(bindAddr);
}

async function setBind(addr) {
  bindAddr = addr;
  await closeServers();
  await listen(addr);
}

function setSettings(next) {
  if (!next || typeof next !== "object") return;
  if (typeof next.closeOnDisconnect === "string") cfg.closeOnDisconnect = next.closeOnDisconnect;
  if (Number.isFinite(next.closeDelaySeconds)) cfg.closeDelaySeconds = Math.max(0, next.closeDelaySeconds | 0);
  if (Number.isFinite(next.slowMo)) cfg.slowMo = Math.max(0, next.slowMo | 0);
  logFn("proxy", "settings", JSON.stringify(cfg));
}

// Auto-close-stale sweep: main calls this on a timer; we close any pane whose last
// CDP activity is older than `cutoff` and that isn't pinned.
function sweepStale(cutoff, isPinned) {
  for (const [tid, e] of targetToPane) {
    if ((e.lastActivity || 0) >= cutoff) continue;
    if (isPinned && isPinned(e.leafId)) continue;
    targetToPane.delete(tid);
    logFn("proxy", "stale close leaf=" + e.leafId);
    hooks.closePane?.(e.leafId);
  }
}

module.exports = { start, setBind, setSettings, sweepStale, PUBLIC_PORT };
