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
// Each browser-endpoint connection becomes a labelled monica tab; the panes it
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

let connSeq = 0;
const hostCounters = new Map(); // host -> count
const targetToPane = new Map(); // CDP targetId -> { connectionId, leafId }
let createChain = Promise.resolve(); // serialize createTarget handling for clean correlation

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
function filterBackendToClient(text) {
  if (!(text.includes("targetInfo") || text.includes("targetInfos"))) return text;
  let msg;
  try { msg = JSON.parse(text); } catch { return text; }
  if ((msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") &&
      msg.params && isHiddenInfo(msg.params.targetInfo)) {
    return null;
  }
  if (msg.result && Array.isArray(msg.result.targetInfos)) {
    const before = msg.result.targetInfos.length;
    msg.result.targetInfos = msg.result.targetInfos.filter((t) => !isHiddenInfo(t));
    if (msg.result.targetInfos.length !== before) return JSON.stringify(msg);
  }
  return text;
}

// ---- HTTP: discovery endpoints, with ws URLs pointed back at this proxy -----

async function handleHttp(req, res) {
  const host = req.headers.host || bindAddr + ":" + PUBLIC_PORT;
  const path = (req.url || "/").split("?")[0];
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
  const ctx = { client, backend: null, isBrowser, connectionId: null, backendOpen: false, pending: [] };

  const backend = new WebSocket(INTERNAL_WS + path, { perMessageDeflate: false });
  ctx.backend = backend;
  backend.on("open", () => {
    ctx.backendOpen = true;
    for (const m of ctx.pending) backend.send(m);
    ctx.pending = [];
  });
  backend.on("message", (d) => {
    const out = filterBackendToClient(typeof d === "string" ? d : d.toString());
    if (out !== null && client.readyState === WebSocket.OPEN) client.send(out);
  });
  backend.on("close", () => { try { client.close(); } catch {} });
  backend.on("error", () => { try { client.close(); } catch {} });

  client.on("message", (d) => handleClientMessage(ctx, d));
  client.on("close", () => {
    try { backend.close(); } catch {}
    // Retain panes on disconnect (CDP semantics: disconnect = detach, not close).
    // Keep the targetToPane mappings so panes stay closable-by-target if a client
    // reconnects and attaches to them.
    if (ctx.connectionId != null) hooks.onConnectionClose?.(ctx.connectionId);
  });
  client.on("error", () => { try { backend.close(); } catch {} });

  if (isBrowser) {
    ctx.connectionId = ++connSeq;
    assignLabel(ctx, fullUrl, req);
  }
}

async function assignLabel(ctx, fullUrl, req) {
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  let explicit = null;
  const qi = fullUrl.indexOf("?");
  if (qi >= 0) {
    try { explicit = new URLSearchParams(fullUrl.slice(qi + 1)).get("label"); } catch {}
  }
  let label;
  if (explicit) {
    label = explicit;
  } else {
    const host = !ip || ip === "127.0.0.1" || ip === "::1" ? "localhost" : (await reverseDns(ip, 1000)) || ip;
    const n = (hostCounters.get(host) || 0) + 1;
    hostCounters.set(host, n);
    label = host + ":#" + n;
  }
  hooks.onConnectionOpen?.(ctx.connectionId, label);
}

function forward(ctx, text) {
  if (ctx.backendOpen) ctx.backend.send(text);
  else ctx.pending.push(text);
}

function handleClientMessage(ctx, data) {
  const text = typeof data === "string" ? data : data.toString();
  let msg;
  try { msg = JSON.parse(text); } catch { return forward(ctx, text); }

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
      const { leafId } = targetToPane.get(tid);
      targetToPane.delete(tid);
      Promise.resolve(hooks.closePane?.(leafId)).finally(() => reply(ctx.client, { id: msg.id, result: { success: true } }));
      return;
    }
  }
  forward(ctx, text);
}

async function doCreate(ctx, msg) {
  const url = (msg.params && msg.params.url) || "about:blank";
  const before = new Set(await listWebviewIds());
  const { leafId } = (await hooks.createPane(ctx.connectionId, url)) || {};
  const targetId = await waitForNewWebview(before, 10000);
  if (!targetId) throw new Error("monica: new pane did not register a CDP target");
  targetToPane.set(targetId, { connectionId: ctx.connectionId, leafId });
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
  await waitForInternal();
  await listen(bindAddr);
}

async function setBind(addr) {
  bindAddr = addr;
  await closeServers();
  await listen(addr);
}

module.exports = { start, setBind, PUBLIC_PORT };
