# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What monica is

A desktop Electron app that hosts many embedded browsers as **panes** and exposes a single Chrome DevTools Protocol (CDP) endpoint at `:9222`. External agents (the `jturle` fork of `agent-browser-mcp`, Puppeteer, Playwright, anything that speaks CDP) attach to that endpoint, and every page they open shows up as a live, attachable pane the user can watch and take over.

## Commands

```bash
yarn install              # any package manager works (npm / pnpm too) — no packageManager pin
yarn start                # run in dev (electron .)
yarn package              # build local dist/monica-darwin-arm64/monica.app (unsigned)
yarn install:app          # build + drop monica.app into /Applications (scripts/install-app.sh)
```

There are no tests, lint, or typecheck steps — `node --check <file>` is the only static check used during development.

**Yarn-specific gotcha:** Yarn 4 may skip Electron's postinstall script. If `electron .` complains the binary isn't installed, run `node node_modules/electron/install.js` once.

## High-level architecture

Three processes communicate, with a CDP proxy in front of Chromium's real debugger:

```
External agents ── ws ──> :9222 (proxy.js)        ┐
                                                  │
                              ┌─── relay ────> 127.0.0.1:9223  (Chromium DevTools, internal-only)
                              │
                              └─── IPC ──────> main.js ──> renderer (app.js / index.html)
                                                            └─ panes are <webview> elements
```

**`proxy.js`** owns the public port. It's a transparent WebSocket relay with deliberate interventions:
- `Target.createTarget` → ask the renderer (via the `createPane` hook) to build a `<webview>` and return its leaf id; correlate the new Chromium target by polling `/json/list` for fresh webview ids (see `waitForNewWebview`).
- `Target.closeTarget` → remove the pane (via the `closePane` hook).
- `Emulation.setDeviceMetricsOverride` / `setVisibleSize` → swallow (monica sizes panes itself).
- **Target visibility filtering** — for `Target.getTargets` results and `Target.targetCreated`/`targetInfoChanged` events, drop targets that aren't in the caller's `?session=` scope and hide monica's own shell. **Never drop `Target.attachedToTarget`** — doing so desyncs puppeteer's flatten auto-attach and hangs `puppeteer.connect()`. There's a memory file about this; the corresponding tests in real use are the puppeteer + agent-browser flows.
- Per-target activity tracking with a 500ms-per-pane throttle (`bumpActivity`) → `hooks.onActivity(leafId)` drives the chrome bar's pulse + "x s ago" timer.
- Close-on-disconnect modes for **named** `?session=` connections: `close` (default) | `retain` | `delay` (cancelled if the same session reconnects within the delay). **Anonymous** disconnects (e.g. `puppeteer.disconnect()`) always retain — Chrome-correct detach semantics.
- Slow-motion delays only user-facing commands (`SLOW_METHODS`: Page.navigate, Page.reload, Input.*, Runtime.evaluate/callFunctionOn). Plumbing (Target.*, Page.enable, Network.enable, …) is never slowed — slowing it desyncs attach.

**`main.js`** is the Electron host. Responsibilities:
- Settings file at `app.getPath("userData")/monica-settings.json`. **`app.setName("monica")` MUST run before any `getPath()` call** so userData lands under `…/monica`.
- IPCs: `cdp:get/set`, `view:get/set`, `theme:get/set` (specific), and the generic `settings:get`/`settings:patch` (for the new toggles — see below). Proxy-affecting fields are forwarded live via `proxy.setSettings`.
- `pane:set-pinned` mirrors a `pinned` Set used by the proxy's `isPinned` hook. Pinned panes are user-protected: they skip auto-close-stale, skip close-on-disconnect, **and** ack an explicit `Target.closeTarget` with `success` while keeping the pane alive in monica (the target is also de-scoped so the agent's next `getTargets` won't see it).
- `pane:snapshot` (handle) receives PNG bytes from the renderer (`webview.capturePage().toPNG()`) and writes them to `~/Downloads/monica-<name>-<ts>.png`.
- 30s `setInterval` calls `proxy.sweepStale(cutoff, isPinned)` when `autoCloseStaleMinutes > 0`.
- All host renderer sends go through `safeSend(channel, payload)` (checks `isDestroyed()` and try/catches `Render frame was disposed`). Don't call `mainWindow.webContents.send` directly — the activity stream hits the disposed-frame window easily.

**`preload.js`** exposes a single `api` object on `window` (contextIsolation is on; the renderer can't touch `ipcRenderer` directly). Add new IPCs here whenever you add ones in `main.js`.

**`renderer/app.js`** owns the UI:
- `panes` is a flat array; each pane is one `<webview>` and one top-bar pill. There's no per-tab split tree.
- Two view modes (`viewMode`): **tabs** (selected pane fills the stage) and **grid** (`ceil(sqrt(n))` cells along the window's long axis, transposed in portrait, recomputed on resize). Layout positions absolutely; webviews are never reparented.
- Panes carry `kind: "user" | "conn"`, optional `session`/`connectionId`, and `autoName` (user-created panes auto-relabel to the page hostname until renamed).
- **Webview partition**: panes for a NAMED `?session=` connection use `persist:session-<encodeURIComponent(name)>` — cookies / localStorage / IndexedDB persist across reconnects and across monica restarts. Anonymous conn panes and user panes use `persist:pane-<id>` (id is monotonic per launch, so de-facto ephemeral). The named-vs-anonymous bit is plumbed via `proxy.onConnectionOpen(id, label, session)` → renderer's `namedSessionByConn` map → `makePane({namedSession})` → `p.namedSession` → partition selection in `createPaneEl`. Agents can self-clear via standard CDP (`Storage.clearDataForOrigin`, `Network.clearBrowserCookies`); the user clears via the "Persisted sessions" section of the settings popover.
- The "new tab" blank state is rendered via a **theme-aware data: URI** placeholder (`newTabUrl()`), not `about:blank`. **Keep `p.url` logically `BLANK`** by short-circuiting `setUrl` when it sees `isNewTabUrl(u)` — otherwise omnibox/labels leak the data URI.
- Activity events (`onProxyActivity`) bump `lastActivity` per pane and pulse the chrome `.dot` for 700ms.
- The settings popover (gear icon) reads from `getSettings()` and `patchSettings({key:value})` per change.
- Theme defaults to **system** (`prefers-color-scheme`), persisted in `monica-settings.json`. The toggle pins an explicit `light`/`dark`. CSS uses `:root[data-theme="light|dark"]` blocks; tokens drive every color including LAN amber, the danger red, and the "page-frame lift" shadow.

## Settings (`monica-settings.json`)

Stored under userData. Keys:
- `cdpMode`: `"local"` | `"lan"` — proxy bind address (toggled via the LAN globe button, confirmation dialog on switch).
- `view`: `"grid"` | `"tabs"`.
- `theme`: `"system"` | `"light"` | `"dark"`.
- `closeOnDisconnect`: `"close"` | `"retain"` | `"delay"` (named sessions only).
- `closeDelaySeconds`: integer (used when delay mode).
- `autoCloseStaleMinutes`: integer, `0` = off.
- `slowMo`: ms, `0` = off.
- `knownSessions`: array of named `?session=` strings we've seen — populated by `rememberSession()` in `main.js` on `proxy.onConnectionOpen`, so the settings popover can list / clear / forget sessions even when they aren't currently connected.

`SETTINGS_DEFAULTS` and `effectiveSettings()` in `main.js` are the source of truth for sanitisation. Add new keys there.

## Branding / icon

- Dev mode: dock icon, About panel, and menu items say "monica" (set via `app.setName`, `app.dock.setIcon`, `app.setAboutPanelOptions`). The **macOS menu-bar title** still reads "Electron" in dev — it's read from the prebuilt `Electron.app` bundle before any JS runs. Only `yarn package` fixes that.
- Icon source: `build/icon.svg`. **Render via headless Chrome** (`qlmanage` flattens SVG alpha to white). The build pipeline is documented in earlier commits; in short:
  ```
  Google Chrome --headless --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot=icon-raw.png file://…/icon.html
  # then sips → 10 iconset sizes → iconutil -c icns
  ```
- Iconoir (`devDependency` only) is the icon family — SVG markup is inlined wherever needed, not loaded at runtime.

## Debug log

`monica-debug.log` at the repo root is truncated on every launch. Pipes: HTTP hits, CDP requests, connection open/close, pane create/close, settings changes, snapshot writes, stale-close sweeps. The proxy log lines `getTargets scope=X -> N/M` are the quickest way to verify session isolation.

## Working in this repo via Claude Code

- **Don't try to launch Electron from a Bash tool.** macOS TCC blocks the dev binary launched out of `node_modules` by an agent process. Ask the user to run `yarn start` in their own terminal; observe results via `monica-debug.log` and CDP probes against `:9222`.
- **Driving the running app for verification** — agents typically connect to the live monica at `http://127.0.0.1:9222` via the agent-browser MCP (with a `?session=` per task) or any CDP client. Check `monica-debug.log` for `getTargets scope=X -> N/M` lines to confirm session isolation.
