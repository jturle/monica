// monica — tabs of tiling browser panes.
//
// A TAB owns an independent pane tree (root may be null = empty tab) and its own
// selection. A pane tree is a binary tree: a leaf is one browser (<webview>); a
// split node arranges two children side-by-side (dir:"row") or stacked
// (dir:"col"), with sizes[0] = the first child's fraction of the node's area.
//
// User tabs (⌘T) start with one example.com pane. Connection tabs (created when an
// external CDP client connects) start EMPTY and fill as the client calls newPage()
// — those panes auto-tile by splitting the largest pane along its long axis.
//
// Every pane is absolutely positioned in #stage; only the active tab's panes show.
// Re-layout only updates styles, so a <webview> is never reparented (which reloads).

const stage = document.getElementById("stage");
const omnibox = document.getElementById("omnibox");
const tabsBar = document.getElementById("tabs");

const GUTTER = 6;
const START_URL = new URL("newtab.html", location.href).href; // monica's internal new-pane page
const isBlank = (u) => !u || u === START_URL || u === "about:blank";

let tabSeq = 0;
let leafSeq = 0;

const makeLeaf = (tab, url = START_URL) => ({ type: "leaf", id: ++leafSeq, n: ++tab.n, url });

function makeTab(name) {
  const t = { id: ++tabSeq, name: name || "tab-" + tabSeq, root: null, selectedId: null, n: 0 };
  const leaf = makeLeaf(t);
  t.root = leaf;
  t.selectedId = leaf.id;
  return t;
}
function makeEmptyTab(name) {
  return { id: ++tabSeq, name: name || "tab-" + tabSeq, root: null, selectedId: null, n: 0 };
}

let tabs = [makeTab("main")];
let active = tabs[0];

const paneEls = new Map(); // leaf id -> .pane element (across all tabs)
let dividerEls = []; // parallel to computeRects(active).dividers order
const connTabs = new Map(); // connectionId -> tab

// ---- naming ----------------------------------------------------------------

function slug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "tab";
}
// Pane label is monica-internal (shown in the pane header only). We deliberately
// do NOT write it into the guest's document.title — that would pollute what an
// attached client's page.title() reads.
const labelFor = (tab, leaf) => slug(tab.name) + "-" + leaf.n;

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

// Pixel rects for leaves/dividers of a given tab, using the stage size as canvas.
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
    ptitle.textContent = e.title || leaf.url;
  });
  const setUrl = (u) => { leaf.url = u; if (leaf.id === active.selectedId) omnibox.value = isBlank(u) ? "" : u; };
  wv.addEventListener("did-navigate", (e) => setUrl(e.url));
  wv.addEventListener("did-navigate-in-page", (e) => setUrl(e.url));

  paneEls.set(leaf.id, el);
  return el;
}

function setRect(el, r) {
  el.style.left = r.x + "px"; el.style.top = r.y + "px";
  el.style.width = r.w + "px"; el.style.height = r.h + "px";
}

function positionAll() {
  if (!active.root) return;
  const { leaves, dividers } = rectsOf(active.root);
  leaves.forEach(({ id, rect }) => { const el = paneEls.get(id); if (el) setRect(el, rect); });
  dividers.forEach((d, i) => { if (dividerEls[i]) setRect(dividerEls[i], d.rect); });
}

function layout() {
  for (const [, el] of paneEls) {
    el.style.display = el.dataset.tab === String(active.id) ? "" : "none";
  }
  dividerEls.forEach((d) => d.remove());
  dividerEls = [];
  if (!active.root) return;
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
  active.selectedId = id;
  for (const [, el] of paneEls) {
    if (el.dataset.tab === String(active.id)) el.classList.toggle("selected", el.dataset.id === String(id));
  }
  const lf = leafIn(active.root, id);
  omnibox.value = lf && !isBlank(lf.url) ? lf.url : "";
}

// Split a specific leaf in a tab; returns the new leaf. Direction "auto" picks the
// long axis of the largest existing pane for a balanced grid.
function addPaneToTab(tab, url = "about:blank") {
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
  const el = paneEls.get(id);
  if (tab.root.type === "leaf" && tab.root.id === id) {
    if (el) { el.remove(); paneEls.delete(id); }
    tab.root = null;
    tab.selectedId = null;
    if (active === tab) layout();
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
  if (el) { el.remove(); paneEls.delete(id); }
  if (!leafIn(tab.root, tab.selectedId)) tab.selectedId = firstLeaf(tab.root).id;
  if (active === tab) { layout(); select(tab.selectedId); }
}

function closeLeafAnywhere(id) {
  const t = tabOf(id);
  if (t) closeLeafInTab(t, id);
}

function reloadSelected() {
  const wv = paneEls.get(active.selectedId)?.querySelector("webview");
  if (wv) wv.reload();
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
  if (active.selectedId) select(active.selectedId);
  else omnibox.value = "";
  renderTabs();
}

function addTab() {
  const t = makeTab();
  tabs.push(t);
  setActive(t);
  renderTabs();
}

function closeTab(tab) {
  if (tabs.length === 1) return; // keep at least one tab
  walkLeaves(tab.root, (l) => { const el = paneEls.get(l.id); if (el) { el.remove(); paneEls.delete(l.id); } });
  const idx = tabs.indexOf(tab);
  tabs.splice(idx, 1);
  for (const [cid, t] of connTabs) if (t === tab) connTabs.delete(cid);
  if (active === tab) {
    active = tabs[Math.max(0, idx - 1)];
    layout();
    if (active.selectedId) select(active.selectedId); else omnibox.value = "";
  }
  renderTabs();
}

// ---- omnibox ---------------------------------------------------------------

omnibox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const lf = leafIn(active.root, active.selectedId);
  if (!lf) return;
  let u = omnibox.value.trim();
  if (!u) return;
  const hasScheme = /^(https?|about|chrome|file|data|view-source|blob|devtools):/i.test(u);
  if (!hasScheme) {
    const looksLikeHost = /^localhost(:\d+)?(\/|$)/i.test(u) || /^[^\s.]+\.[^\s]/.test(u);
    u = looksLikeHost ? "https://" + u : "https://www.google.com/search?q=" + encodeURIComponent(u);
  }
  const wv = paneEls.get(lf.id)?.querySelector("webview");
  if (wv) wv.src = u;
});

// ---- proxy-driven panes (external CDP clients) -----------------------------

window.api?.onProxyConnectionOpen?.(({ connectionId, label }) => {
  const t = makeEmptyTab(label);
  tabs.push(t);
  connTabs.set(connectionId, t);
  setActive(t);
  renderTabs();
});

window.api?.onProxyConnectionClose?.((connectionId) => {
  const t = connTabs.get(connectionId);
  if (!t) return;
  // disconnect → tear the connection's tab + panes back down. If it's the only tab
  // left, drop in a fresh main tab first so we always land somewhere.
  if (tabs.length === 1) tabs.push(makeTab("main"));
  closeTab(t);
});

window.api?.onProxyCreatePane?.(({ connectionId, url, reqId }) => {
  let t = connTabs.get(connectionId);
  if (!t) { t = makeEmptyTab("agent"); tabs.push(t); connTabs.set(connectionId, t); renderTabs(); }
  const leaf = addPaneToTab(t, url || "about:blank");
  renderTabs();
  window.api.replyCreatePane(reqId, leaf.id);
});

window.api?.onProxyClosePane?.((leafId) => closeLeafAnywhere(leafId));

// ---- CDP bind toggle + copy ------------------------------------------------

const cdpBadge = document.getElementById("cdp-badge");
const cdpToggle = document.getElementById("cdp-toggle");
let cdpLabel = "CDP :9222";
let cdpEndpoint = "http://127.0.0.1:9222";
let cdpIsLan = false;
let copyTimer = null;

function applyCdpState({ mode, port, lanIp }) {
  cdpIsLan = mode === "lan";
  const host = cdpIsLan ? lanIp : "127.0.0.1";
  cdpEndpoint = "http://" + host + ":" + port;
  cdpLabel = cdpIsLan ? "CDP " + host + ":" + port : "CDP :" + port;
  cdpBadge.title = "Click to copy " + cdpEndpoint;
  cdpBadge.textContent = cdpLabel;
  cdpBadge.classList.toggle("lan", cdpIsLan);
  cdpToggle.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
}

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
window.api?.onClosePane(() => { if (active.selectedId) closeLeafAnywhere(active.selectedId); });
window.api?.onReloadPane(() => reloadSelected());
window.api?.onNewTab(() => addTab());
window.api?.onCloseTab(() => closeTab(active));
window.addEventListener("resize", () => positionAll());

renderTabs();
layout();
if (active.selectedId) select(active.selectedId);
initCdpToggle();
