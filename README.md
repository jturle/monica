# monica

An embedded multi-browser cockpit. Open multiple browser instances inside a
single desktop app, tile them like a security-camera wall, drive any one of them
by hand — and, because every pane is exposed as a **Chrome DevTools Protocol
(CDP) target**, attach external automation (Playwright, [agent-browser](https://github.com/vercel-labs/agent-browser),
chrome-devtools-mcp) to drive them remotely.

No more launching headless Chrome from a shell, juggling `--remote-debugging-port`
flags, and forwarding ports. monica is the launcher, supervisor, and viewer in one.

## Status

Early spike. Working today:

- A tiling pane tree (à la tmux/iTerm2). Each leaf is a live browser.
- **⌘D** splits the selected pane side-by-side; **⌘⇧D** splits it stacked.
- Drag the gutters to resize panes.
- Click a pane to select it; the omnibox navigates the selected pane.
- **⌘W** closes the selected pane and collapses the split.
- The whole app runs with a CDP endpoint on `localhost:9222`; each pane is an
  individually attachable target.

## Architecture

- **Shell:** Electron. Panes are `<webview>` elements living in the DOM, so
  tiling, drag-resize, selection, and z-order are plain CSS/HTML. (The pane is a
  swappable abstraction — it can migrate to `WebContentsView` later if needed.)
- **Isolation:** each pane gets its own persistent session partition
  (`persist:pane-<id>`) — separate cookies, storage, and cache.
- **Remote control:** one CDP endpoint, many targets. External tools connect to
  `http://localhost:9222`, list targets, and attach to a specific pane.

## Run

Requires Node and [Yarn](https://yarnpkg.com/).

```bash
yarn install
node node_modules/electron/install.js   # fetch the Electron binary (Yarn 4 doesn't auto-run this)
yarn start
```

Then, to confirm panes are CDP-attachable:

```bash
curl http://localhost:9222/json | jq '.[] | {title, type, url}'
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
