# monica

An embedded multi-browser cockpit. Open many browsers inside a single desktop
app, tile them like a security-camera wall, drive any one by hand — and, because
every pane is a live **Chrome DevTools Protocol (CDP) target**, point external
automation (Playwright, Puppeteer, [agent-browser](https://github.com/vercel-labs/agent-browser),
chrome-devtools-mcp) at it and watch it drive in real time.

No more launching headless Chrome from a shell, juggling `--remote-debugging-port`
flags, and forwarding ports. monica is the launcher, supervisor, and viewer in one —
and a remote `puppeteer.connect(...)` + `browser.newPage()` "just works" against it.

## Features

- **Tabs of tiling panes.** Each tab owns an independent pane tree (à la
  tmux/iTerm2); each leaf is a live browser.
- **Split & resize.** ⌘D splits the selected pane side-by-side, ⌘⇧D stacks it;
  drag the gutters to resize. Panes auto-tile when created by automation.
- **Drive by hand or remotely.** Click a pane to select it and use the omnibox,
  or attach over CDP. Both at once is fine.
- **One CDP endpoint, live-rebindable.** Local (`127.0.0.1`) ↔ LAN (`0.0.0.0`)
  toggle rebinds without a restart; click the badge to copy the endpoint URL.
- **Per-connection tabs.** Each external client gets its own labelled tab
  (`‹host›:#n`); the pages it opens tile inside it and are torn down on disconnect.
- **Internal start page.** New panes open monica's own blank page (no `example.com`).

## Remote control

monica's proxy makes a plain CDP client work without monica-specific code:

```js
import puppeteer from "puppeteer-core";

// Local, or http://<lan-ip>:9222 in LAN mode (badge shows the address).
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  defaultViewport: null, // optional; monica ignores viewport overrides anyway
});

const page = await browser.newPage();          // creates a pane in this client's tab
await page.goto("https://example.org/");        // watch it load in the grid
// ...drive it...
await browser.disconnect();                      // NOT browser.close() — that kills monica
```

You can also **attach to panes that already exist** (e.g. ones you opened by hand).
They are `webview`-type targets, so enumerate and pick:

```js
const browser = await puppeteer.connect({
  browserURL: "http://127.0.0.1:9222",
  targetFilter: (t) => t.type !== "browser", // required to see webview panes
});
const target = browser.targets().find((t) => t.type() === "webview");
const page = await target.page();
```

Good to know:

- **`newPage()` works**, even though monica is an Electron host. The proxy
  translates `Target.createTarget` into a real pane (plain Electron would hang).
- **Panes render at their on-screen size.** monica ignores client viewport
  emulation so content fills the pane and reflows as you tile/resize it.
- **Page titles are untouched.** The pane's slug label lives in monica's UI
  header only — `page.title()` returns the real title.
- **No tunnel needed for cross-machine use:** flip to LAN mode and connect to
  `http://<lan-ip>:9222`. (An SSH tunnel still works and adds auth/encryption.)

## Architecture

- **Shell:** Electron. Panes are `<webview>` elements in the DOM, so tiling,
  drag-resize, selection, and z-order are plain CSS/HTML. (The pane is a swappable
  abstraction — it can migrate to `WebContentsView` later if needed.)
- **CDP proxy:** real Chromium DevTools runs internal-only on `127.0.0.1:9223`;
  monica's proxy owns the public `:9222`. It's a transparent WebSocket relay
  except it intercepts `Target.createTarget` (→ create a pane), `Target.closeTarget`
  (→ remove a pane), and viewport-emulation calls (→ swallowed). The Local/LAN
  toggle just rebinds the proxy's listener.
- **Isolation:** each pane has its own persistent session partition
  (`persist:pane-<id>`) — separate cookies, storage, and cache.

## Run

Requires Node and [Yarn](https://yarnpkg.com/).

```bash
yarn install
node node_modules/electron/install.js   # fetch the Electron binary (Yarn 4 doesn't auto-run this)
yarn start
```

Confirm panes are CDP-attachable:

```bash
curl http://localhost:9222/json | jq '.[] | {title, type, url}'
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| ⌘T | New tab |
| ⌘⇧W | Close tab |
| ⌘D | Split pane side-by-side |
| ⌘⇧D | Split pane stacked |
| ⌘R | Reload selected pane |
| ⌘W | Close selected pane (collapse split) |
| ⌘⇧R | Reload the monica app |

Double-click a tab to rename it (the slug feeds the pane labels).

## Limitations

- **Incognito contexts** (`createBrowserContext`) aren't supported — Electron
  doesn't implement them. `newPage()` on the default context is what's enabled.
- LAN mode + allow-all origins means anyone on your network can drive your
  browsers. Use it only on a trusted network (a shared-secret token is a planned
  follow-up).

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
