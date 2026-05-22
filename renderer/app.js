// monica — tiling browser panes.
//
// Layout model: a binary tree. A leaf is one browser (<webview>). A split node
// arranges two children either side-by-side (dir:"row") or stacked (dir:"col"),
// with sizes[0] = the first child's fraction of the node's area.
//
// Rendering model: every pane is absolutely positioned inside #stage. We compute
// pixel rects from the tree and apply them — so re-layout never reparents a
// <webview> (reparenting a webview reloads it), and resize is just style updates.

const stage = document.getElementById("stage");
const omnibox = document.getElementById("omnibox");
const tabTitle = document.getElementById("tab-title");

const GUTTER = 6;
const START_URL = "https://example.com";

let seq = 0;
const makeLeaf = (url = START_URL) => ({ type: "leaf", id: ++seq, url });

let root = makeLeaf();
let selectedId = root.id;

const paneEls = new Map(); // leaf id -> .pane element
let dividerEls = []; // parallel to computeRects().dividers order

// ---- tree helpers ----------------------------------------------------------

function leafById(id) {
  let found = null;
  (function walk(n) {
    if (n.type === "leaf") { if (n.id === id) found = n; }
    else n.children.forEach(walk);
  })(root);
  return found;
}

function firstLeaf(n) {
  return n.type === "leaf" ? n : firstLeaf(n.children[0]);
}

// Compute pixel rects for every leaf and divider given the current stage size.
// Traversal order is deterministic, so dividerEls can be indexed positionally.
function computeRects() {
  const leaves = [];
  const dividers = [];
  (function walk(n, x, y, w, h) {
    if (n.type === "leaf") { leaves.push({ id: n.id, rect: { x, y, w, h } }); return; }
    const s = n.sizes[0];
    if (n.dir === "row") {
      const wa = (w - GUTTER) * s;
      const wb = (w - GUTTER) * (1 - s);
      walk(n.children[0], x, y, wa, h);
      dividers.push({ node: n, dir: "row", rect: { x: x + wa, y, w: GUTTER, h } });
      walk(n.children[1], x + wa + GUTTER, y, wb, h);
    } else {
      const ha = (h - GUTTER) * s;
      const hb = (h - GUTTER) * (1 - s);
      walk(n.children[0], x, y, w, ha);
      dividers.push({ node: n, dir: "col", rect: { x, y: y + ha, w, h: GUTTER } });
      walk(n.children[1], x, y + ha + GUTTER, w, hb);
    }
  })(root, 0, 0, stage.clientWidth, stage.clientHeight);
  return { leaves, dividers };
}

// Pixel rect allocated to a given split node (used while dragging its divider).
function nodeArea(target) {
  let res = null;
  (function walk(n, x, y, w, h) {
    if (n === target) { res = { x, y, w, h }; return; }
    if (n.type !== "split") return;
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
  })(root, 0, 0, stage.clientWidth, stage.clientHeight);
  return res || { x: 0, y: 0, w: stage.clientWidth, h: stage.clientHeight };
}

// ---- DOM: panes ------------------------------------------------------------

function createPane(leaf) {
  const el = document.createElement("div");
  el.className = "pane";
  el.dataset.id = String(leaf.id);

  const chrome = document.createElement("div");
  chrome.className = "pane-chrome";
  chrome.innerHTML =
    '<span class="dot"></span>' +
    '<span class="ptitle">pane ' + leaf.id + "</span>" +
    '<span class="purl"></span>' +
    '<button class="pclose" title="Close pane">×</button>';

  const wv = document.createElement("webview");
  wv.setAttribute("partition", "persist:pane-" + leaf.id); // isolated profile per pane
  wv.setAttribute("allowpopups", "");
  wv.setAttribute("src", leaf.url);

  el.appendChild(chrome);
  el.appendChild(wv);
  stage.appendChild(el);

  chrome.addEventListener("mousedown", () => select(leaf.id));
  chrome.querySelector(".pclose").addEventListener("click", (e) => {
    e.stopPropagation();
    closePane(leaf.id);
  });

  wv.addEventListener("focus", () => select(leaf.id));
  wv.addEventListener("page-title-updated", (e) => {
    chrome.querySelector(".ptitle").textContent = e.title || leaf.url;
    if (leaf.id === selectedId) tabTitle.textContent = e.title || "Tab 1";
  });
  const setUrl = (u) => {
    leaf.url = u;
    chrome.querySelector(".purl").textContent = shortUrl(u);
    if (leaf.id === selectedId) omnibox.value = u;
  };
  wv.addEventListener("did-navigate", (e) => setUrl(e.url));
  wv.addEventListener("did-navigate-in-page", (e) => setUrl(e.url));

  paneEls.set(leaf.id, el);
  return el;
}

function setRect(el, r) {
  el.style.left = r.x + "px";
  el.style.top = r.y + "px";
  el.style.width = r.w + "px";
  el.style.height = r.h + "px";
}

// Reposition existing elements without creating/removing any (safe mid-drag).
function positionAll() {
  const { leaves, dividers } = computeRects();
  leaves.forEach(({ id, rect }) => {
    const el = paneEls.get(id);
    if (el) setRect(el, rect);
  });
  dividers.forEach((d, i) => {
    if (dividerEls[i]) setRect(dividerEls[i], d.rect);
  });
}

// Full layout: ensure panes exist, rebuild dividers, then position everything.
function layout() {
  const { leaves, dividers } = computeRects();
  leaves.forEach(({ id }) => {
    if (!paneEls.has(id)) createPane(leafById(id));
  });
  dividerEls.forEach((d) => d.remove());
  dividerEls = dividers.map((d) => makeDivider(d));
  positionAll();
}

// ---- DOM: dividers ---------------------------------------------------------

function makeDivider(d) {
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
      const area = nodeArea(d.node);
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

// ---- operations ------------------------------------------------------------

function select(id) {
  selectedId = id;
  for (const [pid, el] of paneEls) el.classList.toggle("selected", pid === id);
  const lf = leafById(id);
  if (lf) omnibox.value = lf.url;
}

function splitSelected(dir) {
  let newId = null;
  root = (function replace(n) {
    if (n.type === "leaf") {
      if (n.id !== selectedId) return n;
      const nl = makeLeaf();
      newId = nl.id;
      return { type: "split", dir, sizes: [0.5, 0.5], children: [n, nl] };
    }
    n.children = n.children.map(replace);
    return n;
  })(root);
  if (newId !== null) {
    layout();
    select(newId);
  }
}

function closePane(id) {
  if (root.type === "leaf") return; // never close the last pane

  // Collapse the parent split into the surviving sibling.
  root = (function remove(n) {
    if (n.type === "leaf") return n;
    const [a, b] = n.children;
    if (a.type === "leaf" && a.id === id) return b;
    if (b.type === "leaf" && b.id === id) return a;
    n.children = [remove(a), remove(b)];
    return n;
  })(root);

  const el = paneEls.get(id);
  if (el) { el.remove(); paneEls.delete(id); }

  if (!leafById(selectedId)) selectedId = firstLeaf(root).id;
  layout();
  select(selectedId);
}

// ---- omnibox ---------------------------------------------------------------

omnibox.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const lf = leafById(selectedId);
  if (!lf) return;
  let u = omnibox.value.trim();
  if (!u) return;
  if (!/^https?:\/\//i.test(u)) {
    u = /\.\w/.test(u) ? "https://" + u : "https://www.google.com/search?q=" + encodeURIComponent(u);
  }
  const wv = paneEls.get(lf.id)?.querySelector("webview");
  if (wv) wv.src = u;
});

function shortUrl(u) {
  return u.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// ---- boot ------------------------------------------------------------------

window.api?.onSplit((dir) => splitSelected(dir));
window.api?.onClosePane(() => closePane(selectedId));
window.addEventListener("resize", () => positionAll());

layout();
select(selectedId);
