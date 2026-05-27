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
function newTabUrl() {
  const dark = document.documentElement.dataset.theme === "dark";
  const bg = dark ? "#1a2030" : "#ffffff";
  const fg = dark ? "#566072" : "#9aa3b0";
  const html =
    '<!doctype html><meta charset="utf-8"><style>html,body{height:100%;margin:0}' +
    "body{display:flex;align-items:center;justify-content:center;background:" + bg + ";color:" + fg + ";" +
    "font:13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;letter-spacing:.4px}</style><body>new tab</body>";
  return "data:text/html;charset=utf-8," + encodeURIComponent(html);
}
const isNewTabUrl = (u) => !!u && u.startsWith("data:text/html");
const dlog = (scope, msg) => window.api?.log?.(scope, msg); // -> monica-debug.log

// Inline icon markup for buttons that live inside a pane chrome (we don't load
// Iconoir at runtime — these are copied from node_modules/iconoir/icons/regular).
const ICON_TICK =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="2">' +
  '<path d="M5 12L10 17L19 7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_PIN =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.5">' +
  '<path d="M9.5 14.5L3 21" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M5.00007 9.48528L14.1925 18.6777L15.8895 16.9806L15.4974 13.1944L21.0065 8.5211L15.1568 2.67141L10.4834 8.18034L6.69713 7.78823L5.00007 9.48528Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_SNAP =
  '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke-width="1.5">' +
  '<path d="M10 21.4V14.3937C10 14.0623 10.2686 13.7937 10.6 13.7937H11.7728C11.9768 13.7937 12.1667 13.6901 12.2772 13.5186L13.7228 11.275C13.8333 11.1036 14.0232 11 14.2272 11H17.7728C17.9768 11 18.1667 11.1036 18.2772 11.275L19.7228 13.5186C19.8333 13.6901 20.0232 13.7937 20.2272 13.7937H21.4C21.7314 13.7937 22 14.0623 22 14.3937V21.4C22 21.7314 21.7314 22 21.4 22H10.6C10.2686 22 10 21.7314 10 21.4Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M16 19C17.1046 19 18 18.1046 18 17C18 15.8954 17.1046 15 16 15C14.8954 15 14 15.8954 14 17C14 18.1046 14.8954 19 16 19Z" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3 18V21H5.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3 9.5L3 14.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M3 6V3H6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M9.5 3L14.5 3" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M18 3H21V5.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>' +
  '<path d="M21 10V8.5" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let paneSeq = 0; // pane ids (also the "leafId" the proxy uses)
let panes = []; // [{ id, name, kind:"user"|"conn", url, session, connectionId }]
let selectedId = null;
let viewMode = "tabs";

const paneEls = new Map(); // pane id -> .pane element
const connSessions = new Map(); // connectionId -> session label
const sessionCounts = new Map(); // session label -> panes created (stable naming)
const lastActivity = new Map(); // pane id -> Date.now() of last CDP/nav activity
const pinnedPanes = new Set(); // pane ids the user has pinned (skip auto-close)

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
    '<span class="dot"></span>' +
    '<span class="pname"></span>' +
    '<span class="ptitle"></span>' +
    '<span class="ppill" hidden>you</span>' +
    '<span class="page"></span>' +
    '<button class="pchrome-btn ppin" title="Pin pane (skip auto-close)">' + ICON_PIN + '</button>' +
    '<button class="pchrome-btn psnap" title="Snapshot pane to ~/Downloads">' + ICON_SNAP + '</button>' +
    '<button class="pclose" title="Close pane">×</button>';
  chrome.querySelector(".pname").textContent = p.name;
  chrome.querySelector(".ptitle").textContent = isBlank(p.url) ? "new tab" : "";

  const wv = document.createElement("webview");
  wv.setAttribute("partition", "persist:pane-" + p.id); // stable isolation, independent of name
  wv.setAttribute("allowpopups", "");
  wv.setAttribute("src", isBlank(p.url) ? newTabUrl() : p.url);

  el.appendChild(chrome);
  el.appendChild(wv);
  stage.appendChild(el);

  chrome.addEventListener("mousedown", () => select(p.id));
  chrome.querySelector(".pclose").addEventListener("click", (e) => { e.stopPropagation(); closePane(p.id); });
  chrome.querySelector(".ppin").addEventListener("click", (e) => { e.stopPropagation(); togglePinned(p.id); });
  chrome.querySelector(".psnap").addEventListener("click", (e) => { e.stopPropagation(); snapshotPaneEl(p, wv); });

  // The "you" take-over pill — shown while a HUMAN focuses a pane that an agent is
  // currently driving (kind:"conn"), so it's clear who's at the wheel.
  wv.addEventListener("focus", () => {
    select(p.id);
    if (p.kind === "conn") chrome.querySelector(".ppill").hidden = false;
  });
  wv.addEventListener("blur", () => { chrome.querySelector(".ppill").hidden = true; });

  wv.addEventListener("page-title-updated", (e) => {
    chrome.querySelector(".pname").textContent = p.name;
    chrome.querySelector(".ptitle").textContent = e.title || (isBlank(p.url) ? "new tab" : p.url);
    bumpLocalActivity(p.id);
  });
  const setUrl = (u) => {
    if (isNewTabUrl(u)) return; // the placeholder loaded; keep the pane logically blank
    p.url = u;
    if (p.autoName) {
      const label = hostLabel(u);
      if (label !== p.name) { p.name = label; chrome.querySelector(".pname").textContent = label; renderTabs(); }
    }
    if (p.id === selectedId) omnibox.value = isBlank(u) ? "" : u;
    bumpLocalActivity(p.id);
  };
  wv.addEventListener("did-navigate", (e) => setUrl(e.url));
  wv.addEventListener("did-navigate-in-page", (e) => setUrl(e.url));

  // Reflect the initial pinned state if this pane is being re-created somehow.
  if (pinnedPanes.has(p.id)) el.classList.add("pinned");
  lastActivity.set(p.id, Date.now());

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
  if (viewToggle) {
    viewToggle.dataset.view = viewMode; // CSS shows the destination icon (opposite of current)
    viewToggle.title = "Switch to " + (viewMode === "grid" ? "tabs" : "grid") + " (⌘G)";
  }
  layout();
}
function setView(mode) { // user action: apply + persist (alongside cdpMode in monica-settings.json)
  applyView(mode);
  window.api?.setViewPref?.(viewMode);
}
function toggleView() {
  setView(viewMode === "grid" ? "tabs" : "grid");
}

// ---- activity / pin / snapshot --------------------------------------------

function pulseDot(paneId) {
  const dot = paneEls.get(paneId)?.querySelector(".dot");
  if (!dot) return;
  dot.classList.remove("pulse");
  void dot.offsetWidth; // restart the animation
  dot.classList.add("pulse");
}

function bumpLocalActivity(paneId) {
  lastActivity.set(paneId, Date.now());
  pulseDot(paneId);
}

// Human-friendly "how long ago" suffix shown in the chrome bar.
function ago(ms) {
  if (ms < 5000) return "just now";
  if (ms < 60000) return Math.floor(ms / 1000) + "s";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  return Math.floor(ms / 3600000) + "h";
}

function tickPaneAges() {
  const now = Date.now();
  for (const p of panes) {
    const el = paneEls.get(p.id);
    if (!el) continue;
    const age = el.querySelector(".page");
    if (!age) continue;
    const last = lastActivity.get(p.id);
    age.textContent = last ? ago(now - last) : "";
  }
}

function togglePinned(paneId) {
  const p = paneById(paneId);
  if (!p) return;
  const nowPinned = !pinnedPanes.has(paneId);
  if (nowPinned) pinnedPanes.add(paneId); else pinnedPanes.delete(paneId);
  paneEls.get(paneId)?.classList.toggle("pinned", nowPinned);
  window.api?.setPinned?.(paneId, nowPinned);
}

async function snapshotPaneEl(p, wv) {
  if (!wv?.getWebContentsId) return;
  try {
    const wcId = wv.getWebContentsId();
    const res = await window.api?.snapshotPane?.(p.id, p.name, wcId);
    dlog("snap", "pane=" + p.id + " " + (res?.file || res?.error || ""));
    if (res && res.file) flashSnapOK(p.id); // brief tick over the camera glyph
  } catch (e) { dlog("snap", "error " + (e?.message || e)); }
}

function flashSnapOK(paneId) {
  const btn = paneEls.get(paneId)?.querySelector(".psnap");
  if (!btn) return;
  const prev = btn.innerHTML;
  btn.innerHTML = ICON_TICK;
  btn.classList.add("ok");
  btn.title = "Saved to ~/Downloads";
  setTimeout(() => {
    btn.innerHTML = prev;
    btn.classList.remove("ok");
    btn.title = "Snapshot pane to ~/Downloads";
  }, 1200);
}

// ---- theme -----------------------------------------------------------------
// pref is system | light | dark (persisted); "system" follows the OS and tracks
// live changes. The toggle button flips to an explicit light/dark.
let themePref = "system";
const osDark = () => !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
const resolvedTheme = () => (themePref === "system" ? (osDark() ? "dark" : "light") : themePref);
function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  const btn = document.getElementById("theme-toggle");
  if (btn) {
    btn.dataset.theme = t; // CSS shows the destination icon
    btn.title = "Switch to " + (t === "dark" ? "light" : "dark") + " theme";
  }
  // recolor any open blank panes so their placeholder matches the new theme
  for (const p of panes) {
    if (!isBlank(p.url)) continue;
    const wv = paneEls.get(p.id)?.querySelector("webview");
    if (wv) wv.src = newTabUrl();
  }
}
function setTheme(pref) {
  themePref = pref;
  applyTheme();
  window.api?.setThemePref?.(pref);
}
function toggleTheme() {
  setTheme(resolvedTheme() === "dark" ? "light" : "dark");
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

// Page.printToPDF — proxy routed it here because Chromium gates the CDP command
// to --headless. Electron's <webview>.printToPDF works fine; translate the CDP
// options to Electron's shape and ship the bytes back as base64.
// Translate CDP Page.printToPDF params → Electron webContents.printToPDF options,
// applying CDP's documented defaults (which match Chrome's "Save as PDF" UI) for
// any field the caller didn't specify. Without these explicit defaults, the call
// falls through to Electron's defaults which subtly differ — e.g. background
// colours can leak into the PDF and the page can pick up a default header/footer.
function cdpToElectronPDFOptions(p) {
  p = p && typeof p === "object" ? p : {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const o = {
    landscape: bool(p.landscape, false),
    displayHeaderFooter: bool(p.displayHeaderFooter, false), // no auto header/footer
    printBackground: bool(p.printBackground, false),         // no background fills/images
    scale: num(p.scale, 1),
    preferCSSPageSize: bool(p.preferCSSPageSize, false),
    pageRanges: typeof p.pageRanges === "string" ? p.pageRanges : "",
    pageSize: {
      // CDP is inches; Electron's pageSize object is microns (1in = 25400µm).
      width: Math.round(num(p.paperWidth, 8.5) * 25400),
      height: Math.round(num(p.paperHeight, 11) * 25400),
    },
    // Both CDP and Electron express margins in inches. CDP default is 0.4" all sides.
    margins: {
      top: num(p.marginTop, 0.4),
      bottom: num(p.marginBottom, 0.4),
      left: num(p.marginLeft, 0.4),
      right: num(p.marginRight, 0.4),
    },
  };
  if (typeof p.headerTemplate === "string") o.headerTemplate = p.headerTemplate;
  if (typeof p.footerTemplate === "string") o.footerTemplate = p.footerTemplate;
  return o;
}
function bytesToBase64(u8) {
  let bin = "";
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 0x8000, u8.length)));
  }
  return btoa(bin);
}
window.api?.onProxyPrintToPDF?.(async ({ reqId, leafId, options }) => {
  try {
    const wv = paneEls.get(leafId)?.querySelector("webview");
    if (!wv?.printToPDF) {
      window.api.replyPrintToPDF(reqId, null, "webview.printToPDF unavailable");
      return;
    }
    const data = await wv.printToPDF(cdpToElectronPDFOptions(options));
    window.api.replyPrintToPDF(reqId, bytesToBase64(new Uint8Array(data)), null);
    dlog("pdf", "pane=" + leafId + " " + data.length + " bytes");
  } catch (e) {
    window.api.replyPrintToPDF(reqId, null, String(e?.message || e));
    dlog("pdf", "pane=" + leafId + " error " + (e?.message || e));
  }
});

// Proxy fires this (throttled per-pane) every time a CDP message touches a pane.
// Bump the timestamp + pulse the chrome dot.
window.api?.onProxyActivity?.((leafId) => {
  lastActivity.set(leafId, Date.now());
  pulseDot(leafId);
});

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

let cdpMode = "local";
function applyCdpState({ mode, port, lanIp }) {
  cdpMode = mode === "lan" ? "lan" : "local";
  const lan = cdpMode === "lan";
  const host = lan ? lanIp : "127.0.0.1";
  cdpEndpoint = "http://" + host + ":" + port;
  cdpLabel = lan ? "CDP " + host + ":" + port : "CDP :" + port;
  cdpBadge.title = "Click to copy " + cdpEndpoint;
  cdpBadge.textContent = cdpLabel;
  cdpBadge.classList.toggle("lan", lan);
  cdpToggle.classList.toggle("active", lan);
  cdpToggle.title = lan
    ? "CDP exposed on LAN — click to switch back to local-only"
    : "Local-only — click to expose CDP on your LAN";
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

cdpToggle.addEventListener("click", async () => {
  if (!window.api?.setCdpMode) return;
  applyCdpState(await window.api.setCdpMode(cdpMode === "lan" ? "local" : "lan"));
});

viewToggle?.addEventListener("click", () => toggleView());

document.getElementById("theme-toggle")?.addEventListener("click", toggleTheme);
window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
  if (themePref === "system") applyTheme(); // follow the OS while no explicit choice is set
});

// ---- settings popover ------------------------------------------------------

const settingsToggle = document.getElementById("settings-toggle");
const settingsPopover = document.getElementById("settings-popover");
const setCloseOnDisconnect = document.getElementById("set-closeOnDisconnect");
const setCloseDelaySeconds = document.getElementById("set-closeDelaySeconds");
const setAutoCloseStaleMinutes = document.getElementById("set-autoCloseStaleMinutes");
const setSlowMo = document.getElementById("set-slowMo");
const rowCloseDelay = document.getElementById("row-closeDelay");

function refreshCloseDelayRowVisibility() {
  if (rowCloseDelay) rowCloseDelay.hidden = setCloseOnDisconnect?.value !== "delay";
}
function applySettingsToForm(s) {
  if (!s) return;
  if (setCloseOnDisconnect) setCloseOnDisconnect.value = s.closeOnDisconnect;
  if (setCloseDelaySeconds) setCloseDelaySeconds.value = s.closeDelaySeconds;
  if (setAutoCloseStaleMinutes) setAutoCloseStaleMinutes.value = String(s.autoCloseStaleMinutes);
  if (setSlowMo) setSlowMo.value = String(s.slowMo);
  refreshCloseDelayRowVisibility();
}
function patch(key, val) { window.api?.patchSettings?.({ [key]: val }); }

settingsToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  settingsPopover.hidden = !settingsPopover.hidden;
});
// Click-outside / Escape close
document.addEventListener("mousedown", (e) => {
  if (settingsPopover.hidden) return;
  if (settingsPopover.contains(e.target) || settingsToggle.contains(e.target)) return;
  settingsPopover.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !settingsPopover.hidden) settingsPopover.hidden = true;
});
setCloseOnDisconnect?.addEventListener("change", () => {
  patch("closeOnDisconnect", setCloseOnDisconnect.value);
  refreshCloseDelayRowVisibility();
});
setCloseDelaySeconds?.addEventListener("change", () => {
  patch("closeDelaySeconds", Math.max(0, parseInt(setCloseDelaySeconds.value, 10) || 0));
});
setAutoCloseStaleMinutes?.addEventListener("change", () => {
  patch("autoCloseStaleMinutes", parseInt(setAutoCloseStaleMinutes.value, 10) || 0);
});
setSlowMo?.addEventListener("change", () => {
  patch("slowMo", parseInt(setSlowMo.value, 10) || 0);
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

applyTheme(); // resolve "system" synchronously so there's no flash for OS-default users
applyView("grid"); // default until the stored pref loads (avoids persisting before we read it)
renderTabs();
layout(); // no panes yet → shows the backdrop
renderWelcome();
initCdpToggle();
window.api?.getViewPref?.().then((v) => { if (v) applyView(v); }); // restore last view
window.api?.getThemePref?.().then((p) => { if (p) { themePref = p; applyTheme(); } }); // restore theme
window.api?.getSettings?.().then(applySettingsToForm); // populate the popover form

// "x s ago" timer in pane chromes; 1s cadence is plenty.
setInterval(tickPaneAges, 1000);
