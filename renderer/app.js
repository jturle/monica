// monica — tabs of tiling browser panes.
//
// A TAB owns an independent pane tree (root may be null = empty) and its own
// selection. A pane tree is a binary tree: a leaf is one browser (<webview>); a
// split node arranges two children side-by-side (dir:"row") or stacked
// (dir:"col"), with sizes[0] = the first child's fraction of the node's area.
//
// There may be NO tabs at all — then `active` is null and the stage shows the
// backdrop (shell UI, not a webview, so not a CDP target). User tabs (⌘T) start
// with one blank (about:blank) pane. Connection tabs (an external CDP client
// connecting) start EMPTY and fill as the client calls newPage().
//
// Every pane is absolutely positioned in #stage; only the active tab's panes
// show. Re-layout only updates styles, so a <webview> is never reparented.

const stage = document.getElementById("stage");
const omnibox = document.getElementById("omnibox");
const tabsBar = document.getElementById("tabs");
const backdrop = document.getElementById("backdrop");
const backdropGo = document.getElementById("backdrop-go");

const GUTTER = 6;
const BLANK = "about:blank";
const isBlank = (u) => !u || u === BLANK;
const dlog = (scope, msg) => window.api?.log?.(scope, msg); // -> monica-debug.log

let tabSeq = 0;
let leafSeq = 0;

const makeLeaf = (tab, url = BLANK) => ({ type: "leaf", id: ++leafSeq, n: ++tab.n, url });

function makeTab(name, url) {
  const t = { id: ++tabSeq, name: name || "tab-" + tabSeq, root: null, selectedId: null, n: 0, kind: "user" };
  const leaf = makeLeaf(t, url || BLANK);
  t.root = leaf;
  t.selectedId = leaf.id;
  return t;
}
function makeEmptyTab(name) {
  return { id: ++tabSeq, name: name || "tab-" + tabSeq, root: null, selectedId: null, n: 0, kind: "conn" };
}

let tabs = [];
let active = null;

const paneEls = new Map(); // leaf id -> .pane element (across all tabs)
let dividerEls = []; // parallel to rectsOf(active.root).dividers order
const connTabs = new Map(); // connectionId -> tab

// ---- naming ----------------------------------------------------------------

function slug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tab";
}
const labelFor = (tab, leaf) => slug(tab.name) + "-" + leaf.n;

// ---- url normalization -----------------------------------------------------

function normalizeUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (/^(https?|about|chrome|file|data|view-source|blob|devtools):/i.test(u)) return u;
  const looksLikeHost = /^localhost(:\d+)?(\/|$)/i.test(u) || /^[^\s.]+\.[^\s]/.test(u);
  return looksLikeHost ? "https://" + u : "https://www.google.com/search?q=" + encodeURIComponent(u);
}

// ---- tree helpers ----------------------------------------------------------

function walkLeaves(node, cb) {
  if (!node) return;
  if (node.type === "leaf") cb(node);
  else node.children.forEach((c) => walkLeaves(c, cb));
}
function leafIn(node, id) {
  let found = null;
  walkLeaves(node, (l) => { if (l.id === id) found = l; });
  return found;
}
function firstLeaf(n) {
  return n.type === "leaf" ? n : firstLeaf(n.children[0]);
}
function tabOf(leafId) {
  return tabs.find((t) => leafIn(t.root, leafId)) || null;
}

// Pixel rects for leaves/dividers of a node, using the stage size as canvas.
function rectsOf(node) {
  const W = stage.clientWidth || 1280;
  const H = stage.clientHeight || 800;
  const leaves = [];
  const dividers = [];
  (function walk(n, x, y, w, h) {
    if (!n) return;
    if (n.type === "leaf") { leaves.push({ id: n.id, leaf: n, rect: { x, y, w, h } }); return; }
    const s = n.sizes[0];
    if (n.dir === "row") {
      const wa = (w - GUTTER) * s, wb = (w - GUTTER) * (1 - s);
      walk(n.children[0], x, y, wa, h);
      dividers.push({ node: n, dir: "row", rect: { x: x + wa, y, w: GUTTER, h } });
      walk(n.children[1], x + wa + GUTTER, y, wb, h);
    } else {
      const ha = (h - GUTTER) * s, hb = (h - GUTTER) * (1 - s);
      walk(n.children[0], x, y, w, ha);
      dividers.push({ node: n, dir: "col", rect: { x, y: y + ha, w, h: GUTTER } });
      walk(n.children[1], x, y + ha + GUTTER, w, hb);
    }
  })(node, 0, 0, W, H);
  return { leaves, dividers };
}

function nodeArea(root, target) {
  let res = null;
  const W = stage.clientWidth || 1280, H = stage.clientHeight || 800;
  (function walk(n, x, y, w, h) {
    if (n === target) { res = { x, y, w, h }; return; }
    if (!n || n.type !== "split") return;
    const s = n.sizes[0];
    if (n.dir === "row") {
      const wa = (w - GUTTER) * s;
      walk(n.children[0], x, y, wa, h);
      walk(n.children[1], x + wa + GUTTER, y, (w - GUTTER) * (1 - s), h);
    } else {
      const ha = (h - GUTTER) * s;
      walk(n.children[0], x, y, w, ha);
      walk(n.children[1], x, y + ha + GUTTER, w, (h - GUTTER) * (1 - s));
    }
  })(root, 0, 0, W, H);
  return res || { x: 0, y: 0, w: W, h: H };
}

// ---- DOM: panes ------------------------------------------------------------

function createPane(tab, leaf) {
  if (paneEls.has(leaf.id)) return paneEls.get(leaf.id);
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.id = String(leaf.id);
  el.dataset.tab = String(tab.id);

  const chrome = document.createElement("div");
  chrome.className = "pane-chrome";
  chrome.innerHTML =
    '<span class="dot"></span><span class="pname"></span><span class="ptitle"></span><button class="pclose" title="Close pane">×</button>';
  const pname = chrome.querySelector(".pname");
  const ptitle = chrome.querySelector(".ptitle");
  pname.textContent = labelFor(tab, leaf);
  ptitle.textContent = isBlank(leaf.url) ? "new tab" : "";

  const wv = document.createElement("webview");
  wv.setAttribute("partition", "persist:pane-" + leaf.id); // stable isolation, independent of name
  wv.setAttribute("allowpopups", "");
  wv.setAttribute("src", leaf.url);

  el.appendChild(chrome);
  el.appendChild(wv);
  stage.appendChild(el);

  chrome.addEventListener("mousedown", () => select(leaf.id));
  chrome.querySelector(".pclose").addEventListener("click", (e) => { e.stopPropagation(); closeLeafAnywhere(leaf.id); });

  wv.addEventListener("focus", () => select(leaf.id));
  wv.addEventListener("page-title-updated", (e) => {
    pname.textContent = labelFor(tabOf(leaf.id) || tab, leaf);
    ptitle.textContent = e.title || (isBlank(leaf.url) ? "new tab" : leaf.url);
  });
  const setUrl = (u) => { leaf.url = u; if (active && leaf.id === active.selectedId) omnibox.value = isBlank(u) ? "" : u; };
  wv.addEventListener("did-navigate", (e) => setUrl(e.url));
  wv.addEventListener("did-navigate-in-page", (e) => setUrl(e.url));

  paneEls.set(leaf.id, el);
  dlog("pane", "create leaf=" + leaf.id + " tab=" + tab.name + " url=" + leaf.url);
  return el;
}

function setRect(el, r) {
  el.style.left = r.x + "px"; el.style.top = r.y + "px";
  el.style.width = r.w + "px"; el.style.height = r.h + "px";
}

function positionAll() {
  if (!active || !active.root) return;
  const { leaves, dividers } = rectsOf(active.root);
  leaves.forEach(({ id, rect }) => { const el = paneEls.get(id); if (el) setRect(el, rect); });
  dividers.forEach((d, i) => { if (dividerEls[i]) setRect(dividerEls[i], d.rect); });
}

function updateBackdrop() {
  backdrop.classList.toggle("hidden", !!(active && active.root));
}

function layout() {
  for (const [, el] of paneEls) {
    el.style.display = active && el.dataset.tab === String(active.id) ? "" : "none";
  }
  dividerEls.forEach((d) => d.remove());
  dividerEls = [];
  updateBackdrop();
  if (!active || !active.root) return;
  const { leaves, dividers } = rectsOf(active.root);
  leaves.forEach(({ id, leaf }) => { if (!paneEls.has(id)) createPane(active, leaf); });
  dividerEls = dividers.map((d) => makeDivider(active.root, d));
  positionAll();
}

// ---- DOM: dividers ---------------------------------------------------------

function makeDivider(root, d) {
  const el = document.createElement("div");
  el.className = "divider " + d.dir;
  stage.appendChild(el);

  el.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    const horiz = d.dir === "row";
    const stageBox = stage.getBoundingClientRect();
    document.body.classList.add("dragging");
    el.setPointerCapture(ev.pointerId);
    const onMove = (e) => {
      const area = nodeArea(root, d.node);
      const ratio = horiz
        ? (e.clientX - stageBox.left - area.x) / area.w
        : (e.clientY - stageBox.top - area.y) / area.h;
      d.node.sizes[0] = Math.min(0.9, Math.max(0.1, ratio));
      positionAll();
    };
    const onUp = () => {
      document.body.classList.remove("dragging");
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });
  return el;
}

// ---- pane operations -------------------------------------------------------

function select(id) {
  if (!active) return;
  active.selectedId = id;
  for (const [, el] of paneEls) {
    if (el.dataset.tab === String(active.id)) el.classList.toggle("selected", el.dataset.id === String(id));
  }
  const lf = leafIn(active.root, id);
  omnibox.value = lf && !isBlank(lf.url) ? lf.url : "";
}

// Add a pane to a tab (auto-tiles by splitting the largest pane along its long
// axis). Returns the new leaf.
function addPaneToTab(tab, url = BLANK) {
  let leaf;
  if (!tab.root) {
    leaf = makeLeaf(tab, url);
    tab.root = leaf;
  } else {
    const { leaves } = rectsOf(tab.root);
    leaves.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    const target = leaves[0];
    const dir = target.rect.w >= target.rect.h ? "row" : "col";
    tab.root = (function rep(n) {
      if (n.type === "leaf") {
        if (n.id !== target.id) return n;
        leaf = makeLeaf(tab, url);
        return { type: "split", dir, sizes: [0.5, 0.5], children: [n, leaf] };
      }
      n.children = n.children.map(rep);
      return n;
    })(tab.root);
  }
  tab.selectedId = leaf.id;
  createPane(tab, leaf); // ensure the webview exists now so its CDP target registers
  if (active === tab) { layout(); select(leaf.id); }
  return leaf;
}

function splitSelected(dir) {
  if (!active) return;
  if (!active.root) { addPaneToTab(active); return; }
  let newId = null;
  active.root = (function replace(n) {
    if (n.type === "leaf") {
      if (n.id !== active.selectedId) return n;
      const nl = makeLeaf(active);
      newId = nl.id;
      return { type: "split", dir, sizes: [0.5, 0.5], children: [n, nl] };
    }
    n.children = n.children.map(replace);
    return n;
  })(active.root);
  if (newId !== null) { layout(); select(newId); }
}

function closeLeafInTab(tab, id) {
  if (!tab.root) return;
  dlog("pane", "close leaf=" + id + " tab=" + tab.name);
  if (tab.root.type === "leaf" && tab.root.id === id) {
    if (tab.kind === "user") { closeTab(tab); return; } // last pane of a user tab → drop the tab
    const el = paneEls.get(id);
    if (el) { el.remove(); paneEls.delete(id); }
    tab.root = null;
    tab.selectedId = null;
    if (active === tab) layout(); // connection tab: keep it (empty) for the next newPage()
    return;
  }
  tab.root = (function remove(n) {
    if (n.type === "leaf") return n;
    const [a, b] = n.children;
    if (a.type === "leaf" && a.id === id) return b;
    if (b.type === "leaf" && b.id === id) return a;
    n.children = [remove(a), remove(b)];
    return n;
  })(tab.root);
  const el = paneEls.get(id);
  if (el) { el.remove(); paneEls.delete(id); }
  if (!leafIn(tab.root, tab.selectedId)) tab.selectedId = firstLeaf(tab.root).id;
  if (active === tab) { layout(); select(tab.selectedId); }
}

function closeLeafAnywhere(id) {
  const t = tabOf(id);
  if (t) closeLeafInTab(t, id);
}

function selectedWebview() {
  return active ? paneEls.get(active.selectedId)?.querySelector("webview") : null;
}
function editingText() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
}
function reloadSelected() {
  const wv = selectedWebview();
  if (wv) wv.reload();
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

// ---- tab operations --------------------------------------------------------

function renderTabs() {
  tabsBar.innerHTML = "";
  tabs.forEach((t) => {
    const pill = document.createElement("div");
    pill.className = "tab" + (t === active ? " active" : "");
    pill.title = "Double-click to rename";

    const name = document.createElement("span");
    name.className = "tname";
    name.textContent = t.name;

    const close = document.createElement("button");
    close.className = "tclose";
    close.textContent = "×";
    close.title = "Close tab";

    pill.append(name, close);
    tabsBar.appendChild(pill);

    pill.addEventListener("mousedown", (e) => { if (e.target !== close) setActive(t); });
    pill.addEventListener("dblclick", (e) => { if (e.target !== close) beginRename(t, pill, name); });
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t); });
  });
}

function beginRename(tab, pill, nameEl) {
  const input = document.createElement("input");
  input.className = "tedit";
  input.value = tab.name;
  pill.replaceChild(input, nameEl);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) tab.name = v;
    refreshTabNaming(tab);
    renderTabs();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") renderTabs();
  });
  input.addEventListener("blur", commit);
}

function refreshTabNaming(tab) {
  document.querySelectorAll('.pane[data-tab="' + tab.id + '"]').forEach((el) => {
    const leaf = leafIn(tab.root, +el.dataset.id);
    if (!leaf) return;
    el.querySelector(".pname").textContent = labelFor(tab, leaf);
  });
}

function setActive(tab) {
  if (tab === active) return;
  active = tab;
  layout();
  if (active && active.selectedId) select(active.selectedId);
  else omnibox.value = "";
  renderTabs();
}

function addTab() {
  const t = makeTab(); // user tab with one blank pane
  tabs.push(t);
  setActive(t);
  renderTabs();
  omnibox.focus(); // ready to type a URL immediately
  omnibox.select();
}

function closeTab(tab) {
  dlog("tab", "close " + tab.name);
  walkLeaves(tab.root, (l) => { const el = paneEls.get(l.id); if (el) { el.remove(); paneEls.delete(l.id); } });
  const idx = tabs.indexOf(tab);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  for (const [cid, t] of connTabs) if (t === tab) connTabs.delete(cid);
  if (active === tab) {
    active = tabs[Math.min(idx, tabs.length - 1)] || null; // may be null → backdrop
    layout();
    if (active && active.selectedId) select(active.selectedId);
    else omnibox.value = "";
  }
  renderTabs();
}

// ---- omnibox + backdrop entry ----------------------------------------------

omnibox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const u = normalizeUrl(omnibox.value);
  if (!u) return;
  if (!active) {
    // no tabs open → create one navigated to the entry
    const t = makeTab(undefined, u);
    tabs.push(t);
    setActive(t);
    renderTabs();
    return;
  }
  const lf = leafIn(active.root, active.selectedId);
  if (!lf) { addPaneToTab(active, u); renderTabs(); return; } // empty tab → add a pane
  const wv = paneEls.get(lf.id)?.querySelector("webview");
  if (wv) wv.src = u;
});

backdropGo.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const u = normalizeUrl(backdropGo.value);
  if (!u) return;
  const t = makeTab(undefined, u); // open a new tab navigated to the entry
  tabs.push(t);
  setActive(t);
  renderTabs();
  backdropGo.value = "";
});

// ---- proxy-driven panes (external CDP clients) -----------------------------

window.api?.onProxyConnectionOpen?.(({ connectionId, label }) => {
  dlog("conn", "open #" + connectionId + " " + label);
  const t = makeEmptyTab(label);
  tabs.push(t);
  connTabs.set(connectionId, t);
  setActive(t);
  renderTabs();
});

window.api?.onProxyConnectionLabel?.((connectionId, label) => {
  const t = connTabs.get(connectionId);
  if (t) { t.name = label; refreshTabNaming(t); renderTabs(); }
});

window.api?.onProxyConnectionClose?.((connectionId) => {
  // Retain on disconnect (CDP: disconnect = detach, not close). Detach the tab
  // from the dead connection so it behaves like a normal tab; its panes stay live
  // and re-attachable, and close only via page.close() or manually.
  const t = connTabs.get(connectionId);
  if (!t) return;
  connTabs.delete(connectionId);
  t.kind = "user";
});

window.api?.onProxyCreatePane?.(({ connectionId, url, reqId }) => {
  dlog("conn", "create-pane #" + connectionId + " url=" + (url || BLANK));
  let t = connTabs.get(connectionId);
  if (!t) {
    // Connection tab missing (e.g. user closed it while the client stayed
    // connected). Make a fresh one and activate it so the pane actually lays out.
    t = makeEmptyTab("agent");
    tabs.push(t);
    connTabs.set(connectionId, t);
    setActive(t);
    renderTabs();
  }
  const leaf = addPaneToTab(t, url || BLANK);
  renderTabs();
  window.api.replyCreatePane(reqId, leaf.id);
});

window.api?.onProxyClosePane?.((leafId) => closeLeafAnywhere(leafId));

// ---- CDP bind toggle + copy ------------------------------------------------

const cdpBadge = document.getElementById("cdp-badge");
const cdpToggle = document.getElementById("cdp-toggle");
let cdpLabel = "CDP :9222";
let cdpEndpoint = "http://127.0.0.1:9222";
let copyTimer = null;

// Copy-paste prompts shown on the welcome backdrop. __ENDPOINT__ is filled with
// the live CDP endpoint so they're correct in Local or LAN mode.
const PROMPTS = {
  puppeteer:
    "Use the monica browser cockpit for browser work in this task. Connect with\n" +
    "puppeteer-core to the existing CDP endpoint — do not launch your own browser:\n\n" +
    "  const puppeteer = require('puppeteer-core');\n" +
    "  const browser = await puppeteer.connect({ browserURL: '__ENDPOINT__', defaultViewport: null });\n" +
    "  const page = await browser.newPage();   // opens a pane in monica\n" +
    "  // ...do the task...\n" +
    "  await browser.disconnect();             // use disconnect(), never close()\n\n" +
    "To reuse an open page: browser.targets(), filter t.type()==='webview', await target.page().",
  agentBrowser:
    "Use agent-browser for browser work, but attach it to monica's existing CDP\n" +
    "endpoint instead of launching a separate browser — connect it to __ENDPOINT__\n" +
    "(Chrome DevTools Protocol over HTTP). Pages open as panes in monica that I can\n" +
    "watch and take over. When finished, detach — don't close the browser.",
  generic:
    "For any browser task, attach to the running Chromium at __ENDPOINT__ (a Chrome\n" +
    "DevTools Protocol endpoint) — do not spawn your own browser. This is \"monica\":\n" +
    "pages you open show up as live panes I can see and drive. Create pages with\n" +
    "newPage(); to drive an existing pane, attach to a target of type \"webview\".",
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

// ---- boot ------------------------------------------------------------------

window.api?.onSplit((dir) => splitSelected(dir));
window.api?.onClosePane(() => {
  if (active && leafIn(active.root, active.selectedId)) { closeLeafAnywhere(active.selectedId); return; } // close selected pane
  if (active) { closeTab(active); return; } // empty tab → close it
  window.api?.confirmQuit?.(); // no tabs → offer to quit (confirmed via dialog in main)
});
window.api?.onReloadPane(() => reloadSelected());
window.api?.onNavBack?.(() => navBack());
window.api?.onNavForward?.(() => navForward());
window.api?.onNewTab(() => addTab());
window.api?.onCloseTab(() => { if (active) closeTab(active); });
window.addEventListener("resize", () => positionAll());

renderTabs();
layout(); // no tabs yet → shows the backdrop
renderWelcome();
initCdpToggle();
