// monica — a wall of browser panes.
//
// A PANE is one browser (<webview>) and shows up as one pill in the top bar.
// There is a single flat list of panes; no splitting, no per-tab trees. The same
// list renders two ways (the view mode):
//
//   tabs  — only the selected pane is shown, full-bleed; pills switch between them.
//   grid  — every pane is shown at once, auto-tiled. The grid dimensions follow
//           the pane count and the window's aspect ratio: ceil(sqrt(n)) cells along
//           the long axis, so 1, 2, 4, 6, 9… panes give 1x1, 2x1, 2x2, 3x2, 3x3…
//           (transposed when the window is portrait). Recomputed on every resize.
//
// With NO panes the stage shows the backdrop (shell UI, not a webview, so not a
// CDP target). User panes (⌘T) start blank (about:blank). Connection panes (an
// external CDP client calling newPage()) are created on demand and named after
// the client's ?session=.
//
// Every pane is absolutely positioned in #stage; layout only updates styles, so a
// <webview> is never reparented.

const stage = document.getElementById("stage");
const omnibox = document.getElementById("omnibox");
const tabsBar = document.getElementById("tabs");
const backdrop = document.getElementById("backdrop");
const viewToggle = document.getElementById("view-toggle");

const GUTTER = 6; // gap between grid cells
const OUTER = 8; // grid margin to the stage edge
const BLANK = "about:blank";
const isBlank = (u) => !u || u === BLANK;
// A calm, theme-matched placeholder shown for blank panes so opening a tab doesn't
// flash stark white. The pane's *logical* url stays BLANK (see setUrl), so the
// omnibox and labels still treat it as empty; this is only what the webview renders.
const NEWTAB =
  "data:text/html;charset=utf-8," +
  encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><style>' +
      "html,body{height:100%;margin:0}" +
      "body{display:flex;align-items:center;justify-content:center;background:#1c2128;" +
      "color:#566072;font:13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.4px}" +
      "</style><body>new tab</body>"
  );
const isNewTabUrl = (u) => !!u && u.startsWith("data:text/html");
const dlog = (scope, msg) => window.api?.log?.(scope, msg); // -> monica-debug.log

let paneSeq = 0; // pane ids (also the "leafId" the proxy uses)
let panes = []; // [{ id, name, kind:"user"|"conn", url, session, connectionId }]
let selectedId = null;
let viewMode = "tabs";

const paneEls = new Map(); // pane id -> .pane element
const connSessions = new Map(); // connectionId -> session label
const sessionCounts = new Map(); // session label -> panes created (stable naming)

const paneById = (id) => panes.find((p) => p.id === id) || null;

// ---- naming ----------------------------------------------------------------

function slug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "pane";
}
// nth page of a session: first uses the bare session name, rest get a suffix.
function sessionPaneName(session) {
  const c = (sessionCounts.get(session) || 0) + 1;
  sessionCounts.set(session, c);
  return c === 1 ? session : session + " " + c;
}
// Auto-label for a user tab: the page hostname (www. stripped), or "New Tab" blank.
function hostLabel(u) {
  if (isBlank(u)) return "New Tab";
  try { return new URL(u).hostname.replace(/^www\./, "") || "New Tab"; } catch { return "New Tab"; }
}

// ---- url normalization -----------------------------------------------------

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (/^(https?|about|chrome|file|data|view-source|blob|devtools):/i.test(u)) return u;
  const looksLikeHost = /^localhost(:\d+)?(\/|$)/i.test(u) || /^[^\s.]+\.[^\s]/.test(u);
  return looksLikeHost ? "https://" + u : "https://www.google.com/search?q=" + encodeURIComponent(u);
}

// ---- DOM: panes ------------------------------------------------------------

function createPaneEl(p) {
  if (paneEls.has(p.id)) return paneEls.get(p.id);
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.id = String(p.id);

  const chrome = document.createElement("div");
  chrome.className = "pane-chrome";
  chrome.innerHTML =
    '<span class="dot"></span><span class="pname"></span><span class="ptitle"></span><button class="pclose" title="Close pane">×</button>';
  chrome.querySelector(".pname").textContent = p.name;
  chrome.querySelector(".ptitle").textContent = isBlank(p.url) ? "new tab" : "";

  const wv = document.createElement("webview");
  wv.setAttribute("partition", "persist:pane-" + p.id); // stable isolation, independent of name
  wv.setAttribute("allowpopups", "");
  wv.setAttribute("src", isBlank(p.url) ? NEWTAB : p.url);

  el.appendChild(chrome);
  el.appendChild(wv);
  stage.appendChild(el);

  chrome.addEventListener("mousedown", () => select(p.id));
  chrome.querySelector(".pclose").addEventListener("click", (e) => { e.stopPropagation(); closePane(p.id); });

  wv.addEventListener("focus", () => select(p.id));
  wv.addEventListener("page-title-updated", (e) => {
    chrome.querySelector(".pname").textContent = p.name;
    chrome.querySelector(".ptitle").textContent = e.title || (isBlank(p.url) ? "new tab" : p.url);
  });
  const setUrl = (u) => {
    if (isNewTabUrl(u)) return; // the placeholder loaded; keep the pane logically blank
    p.url = u;
    if (p.autoName) {
      const label = hostLabel(u);
      if (label !== p.name) { p.name = label; chrome.querySelector(".pname").textContent = label; renderTabs(); }
    }
    if (p.id === selectedId) omnibox.value = isBlank(u) ? "" : u;
  };
  wv.addEventListener("did-navigate", (e) => setUrl(e.url));
  wv.addEventListener("did-navigate-in-page", (e) => setUrl(e.url));

  paneEls.set(p.id, el);
  dlog("pane", "create id=" + p.id + " name=" + p.name + " url=" + p.url);
  return el;
}

function makePane({ name, url = BLANK, kind = "user", session = null, connectionId = null, autoName = false }) {
  // autoName: keep the label in sync with the page hostname until the user renames it.
  const p = { id: ++paneSeq, name, kind, url, session, connectionId, autoName };
  panes.push(p);
  createPaneEl(p);
  return p;
}

function setRect(el, r) {
  el.style.left = r.x + "px"; el.style.top = r.y + "px";
  el.style.width = r.w + "px"; el.style.height = r.h + "px";
}

// ---- layout ----------------------------------------------------------------

// cols x rows for n panes given the stage aspect ratio. ceil(sqrt(n)) cells run
// along the long axis; the short axis gets just enough rows to fit.
function gridDims(n, W, H) {
  const primary = Math.max(1, Math.ceil(Math.sqrt(n)));
  const secondary = Math.ceil(n / primary);
  return W >= H ? { cols: primary, rows: secondary } : { cols: secondary, rows: primary };
}

function positionPanes() {
  const W = stage.clientWidth || 1280;
  const H = stage.clientHeight || 800;

  if (viewMode === "tabs") {
    for (const p of panes) {
      const el = paneEls.get(p.id);
      if (!el) continue;
      if (p.id === selectedId) { el.style.display = ""; setRect(el, { x: 0, y: 0, w: W, h: H }); }
      else el.style.display = "none";
    }
    return;
  }

  const n = panes.length;
  if (!n) return;
  const { cols, rows } = gridDims(n, W, H);
  const cellW = (W - OUTER * 2 - GUTTER * (cols - 1)) / cols;
  const cellH = (H - OUTER * 2 - GUTTER * (rows - 1)) / rows;
  panes.forEach((p, i) => {
    const el = paneEls.get(p.id);
    if (!el) return;
    el.style.display = "";
    const r = Math.floor(i / cols);
    const c = i % cols;
    setRect(el, {
      x: OUTER + c * (cellW + GUTTER), // keep column positions; a short last row stays left-aligned
      y: OUTER + r * (cellH + GUTTER),
      w: cellW,
      h: cellH,
    });
  });
}

function updateBackdrop() {
  backdrop.classList.toggle("hidden", panes.length > 0);
}

function layout() {
  if (panes.length && !paneById(selectedId)) selectedId = panes[0].id;
  if (!panes.length) selectedId = null;
  updateBackdrop();
  positionPanes();
  for (const [, el] of paneEls) el.classList.toggle("selected", el.dataset.id === String(selectedId));
}

// ---- selection -------------------------------------------------------------

function select(id) {
  if (!paneById(id)) return;
  selectedId = id;
  for (const [, el] of paneEls) el.classList.toggle("selected", el.dataset.id === String(id));
  if (viewMode === "tabs") positionPanes(); // show the newly selected pane
  syncOmnibox();
  renderTabs();
}

function syncOmnibox() {
  const p = paneById(selectedId);
  omnibox.value = p && !isBlank(p.url) ? p.url : "";
}

// ---- pane operations -------------------------------------------------------

function newUserPane(url = BLANK) {
  const p = makePane({ name: hostLabel(url), url, kind: "user", autoName: true });
  selectedId = p.id;
  layout();
  select(p.id);
  return p;
}

function addPane() {
  newUserPane(BLANK);
  omnibox.focus();
  omnibox.select();
}

function closePane(id) {
  const p = paneById(id);
  if (!p) return;
  dlog("pane", "close id=" + id + " name=" + p.name);
  const el = paneEls.get(id);
  if (el) { el.remove(); paneEls.delete(id); }
  const idx = panes.indexOf(p);
  panes.splice(idx, 1);
  if (selectedId === id) selectedId = panes[Math.min(idx, panes.length - 1)]?.id ?? null;
  layout();
  renderTabs();
  syncOmnibox();
}

function selectedWebview() {
  return paneEls.get(selectedId)?.querySelector("webview") || null;
}
function editingText() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}
function reloadSelected() {
  selectedWebview()?.reload();
}
function navBack() {
  if (editingText()) return; // don't hijack ⌘← while typing in the omnibox
  const wv = selectedWebview();
  if (wv && wv.canGoBack()) wv.goBack();
}
function navForward() {
  if (editingText()) return;
  const wv = selectedWebview();
  if (wv && wv.canGoForward()) wv.goForward();
}

// ---- top-bar pills ---------------------------------------------------------

function renderTabs() {
  tabsBar.innerHTML = "";
  panes.forEach((p) => {
    const pill = document.createElement("div");
    pill.className = "tab" + (p.id === selectedId ? " active" : "");
    pill.title = "Double-click to rename";

    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = p.name;

    const close = document.createElement("button");
    close.className = "tclose";
    close.textContent = "×";
    close.title = "Close pane";

    pill.append(name, close);
    tabsBar.appendChild(pill);

    pill.addEventListener("mousedown", (e) => { if (e.target !== close) select(p.id); });
    pill.addEventListener("dblclick", (e) => { if (e.target !== close) beginRename(p, pill, name); });
    close.addEventListener("click", (e) => { e.stopPropagation(); closePane(p.id); });
  });
}

function beginRename(p, pill, nameEl) {
  const input = document.createElement("input");
  input.className = "tedit";
  input.value = p.name;
  pill.replaceChild(input, nameEl);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) { p.name = v; p.autoName = false; } // explicit rename wins; stop tracking the host
    const el = paneEls.get(p.id);
    if (el) el.querySelector(".pname").textContent = p.name;
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") renderTabs();
  });
  input.addEventListener("blur", commit);
}

// ---- view mode -------------------------------------------------------------

function applyView(mode) {
  viewMode = mode === "grid" ? "grid" : "tabs";
  stage.dataset.view = viewMode;
  viewToggle?.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.view === viewMode));
  layout();
}
function setView(mode) { // user action: apply + persist (alongside cdpMode in monica-settings.json)
  applyView(mode);
  window.api?.setViewPref?.(viewMode);
}
function toggleView() {
  setView(viewMode === "grid" ? "tabs" : "grid");
}

// ---- omnibox + backdrop entry ----------------------------------------------

omnibox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const u = normalizeUrl(omnibox.value);
  if (!u) return;
  const p = paneById(selectedId);
  if (!p) { newUserPane(u); return; } // no panes → open one navigated to the entry
  const wv = paneEls.get(p.id)?.querySelector("webview");
  if (wv) wv.src = u;
});

// ---- proxy-driven panes (external CDP clients) -----------------------------

window.api?.onProxyConnectionOpen?.(({ connectionId, label }) => {
  dlog("conn", "open #" + connectionId + " " + label);
  connSessions.set(connectionId, label);
  // Adopt any still-live panes of this session (e.g. a second concurrent client on
  // the same ?session=). Named-session panes are discarded when their connection
  // drops (see proxy.js), so a reconnect after close finds none — by design.
  const adopted = panes.filter((p) => p.session === label);
  adopted.forEach((p) => { p.kind = "conn"; p.connectionId = connectionId; });
  if (adopted.length) {
    dlog("conn", "adopt " + label + " (" + adopted.length + " panes)");
    selectedId = adopted[0].id;
    layout();
    select(adopted[0].id);
  }
});

window.api?.onProxyConnectionLabel?.((connectionId, label) => {
  const old = connSessions.get(connectionId);
  connSessions.set(connectionId, label);
  if (!old || old === label) return;
  panes
    .filter((p) => p.connectionId === connectionId && (p.name === old || p.name.startsWith(old + " ")))
    .forEach((p) => {
      p.name = label + p.name.slice(old.length);
      p.session = label;
      const el = paneEls.get(p.id);
      if (el) el.querySelector(".pname").textContent = p.name;
    });
  renderTabs();
});

window.api?.onProxyConnectionClose?.((connectionId) => {
  // Retain on disconnect (CDP: disconnect = detach, not close). The panes stay
  // live and re-attachable; only page.close() removes one. Detach them from the
  // dead connection so they behave like normal panes.
  panes.filter((p) => p.connectionId === connectionId).forEach((p) => { p.kind = "user"; p.connectionId = null; });
  connSessions.delete(connectionId);
  renderTabs();
});

window.api?.onProxyCreatePane?.(({ connectionId, url, reqId }) => {
  const session = connSessions.get(connectionId) || "agent";
  if (!connSessions.has(connectionId)) connSessions.set(connectionId, session);
  dlog("conn", "create-pane #" + connectionId + " session=" + session + " url=" + (url || BLANK));
  const p = makePane({ name: sessionPaneName(session), url: url || BLANK, kind: "conn", session, connectionId });
  selectedId = p.id;
  layout(); // size the webview before we hand its id back, so its CDP target isn't 0x0
  select(p.id);
  window.api.replyCreatePane(reqId, p.id);
});

window.api?.onProxyClosePane?.((leafId) => closePane(leafId));

// ---- CDP bind toggle + copy ------------------------------------------------

const cdpBadge = document.getElementById("cdp-badge");
const cdpToggle = document.getElementById("cdp-toggle");
let cdpLabel = "CDP :9222";
let cdpEndpoint = "http://127.0.0.1:9222";
let copyTimer = null;

// Copy-paste content shown on the welcome backdrop. __ENDPOINT__ is filled with
// the live CDP endpoint so they're correct in Local or LAN mode.
const PROMPTS = {
  mcpConfig:
    "{\n" +
    '  "mcpServers": {\n' +
    '    "agent-browser": {\n' +
    '      "command": "npx",\n' +
    '      "args": ["-y", "github:jturle/agent-browser-mcp"],\n' +
    '      "env": { "AGENT_BROWSER_CDP": "__ENDPOINT__" }\n' +
    "    }\n" +
    "  }\n" +
    "}",
  agentBrowser:
    "Use agent-browser for browser work in this task. It's connected to a browser I\n" +
    "can watch and take over. Try to complete everything yourself; only if you hit\n" +
    "something a human must clear — a captcha, sign-in, or 2FA — pause and ask me to\n" +
    "step in rather than working around it. Use a separate agent-browser session per\n" +
    "task, and close that session when you're done.",
  puppeteer:
    "Use the monica browser cockpit for browser work in this task. Connect with\n" +
    "puppeteer-core to the existing CDP endpoint — do not launch your own browser:\n\n" +
    "  const puppeteer = require('puppeteer-core');\n" +
    "  const browser = await puppeteer.connect({ browserURL: '__ENDPOINT__', defaultViewport: null });\n" +
    "  const page = await browser.newPage();   // opens a pane in monica\n" +
    "  // ...do the task...\n" +
    "  await browser.disconnect();             // disconnect() detaches; the pane stays\n\n" +
    "To reuse an open page: browser.targets(), filter t.type()==='webview', await target.page().",
};
const promptText = (key) => (PROMPTS[key] || "").replace(/__ENDPOINT__/g, cdpEndpoint);

function renderWelcome() {
  const ep = document.getElementById("ep-inline");
  if (ep) ep.textContent = cdpEndpoint;
  document.querySelectorAll("pre.prompt[data-prompt-text]").forEach((pre) => {
    pre.textContent = promptText(pre.dataset.promptText);
  });
}

function applyCdpState({ mode, port, lanIp }) {
  const lan = mode === "lan";
  const host = lan ? lanIp : "127.0.0.1";
  cdpEndpoint = "http://" + host + ":" + port;
  cdpLabel = lan ? "CDP " + host + ":" + port : "CDP :" + port;
  cdpBadge.title = "Click to copy " + cdpEndpoint;
  cdpBadge.textContent = cdpLabel;
  cdpBadge.classList.toggle("lan", lan);
  cdpToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  renderWelcome();
}

// Copy buttons on the welcome backdrop (endpoint + example prompts).
backdrop.addEventListener("click", (e) => {
  const btn = e.target.closest("button.lnk");
  if (!btn) return;
  const text = btn.dataset.copy === "endpoint" ? cdpEndpoint : btn.dataset.prompt ? promptText(btn.dataset.prompt) : null;
  if (text == null) return;
  window.api?.copy?.(text);
  const prev = btn.textContent;
  btn.textContent = "Copied ✓";
  setTimeout(() => (btn.textContent = prev), 1000);
});

async function initCdpToggle() {
  if (!window.api?.getCdpMode) return;
  applyCdpState(await window.api.getCdpMode());
}

cdpBadge.addEventListener("click", () => {
  window.api?.copy?.(cdpEndpoint);
  clearTimeout(copyTimer);
  cdpBadge.textContent = "Copied ✓";
  copyTimer = setTimeout(() => (cdpBadge.textContent = cdpLabel), 900);
});

cdpToggle.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (b && window.api?.setCdpMode) applyCdpState(await window.api.setCdpMode(b.dataset.mode));
});

viewToggle?.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) setView(b.dataset.view);
});

// ---- boot ------------------------------------------------------------------

window.api?.onToggleView?.(() => toggleView());
window.api?.onClosePane(() => {
  if (selectedId != null) closePane(selectedId);
  else window.api?.confirmQuit?.(); // no panes → offer to quit (confirmed via dialog in main)
});
window.api?.onReloadPane(() => reloadSelected());
window.api?.onNavBack?.(() => navBack());
window.api?.onNavForward?.(() => navForward());
window.api?.onNewTab(() => addPane());
window.api?.onCloseTab(() => { if (selectedId != null) closePane(selectedId); });
window.addEventListener("resize", () => positionPanes());

applyView("grid"); // default until the stored pref loads (avoids persisting before we read it)
renderTabs();
layout(); // no panes yet → shows the backdrop
renderWelcome();
initCdpToggle();
window.api?.getViewPref?.().then((v) => { if (v) applyView(v); }); // restore last view
