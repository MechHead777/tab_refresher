# Tab Refresher

A Manifest V3 Chrome extension that auto-reloads individual tabs at a chosen interval. The extension icon shows a live countdown (`10s` … `2s`, `1s` below a minute, `m:ss` like `4:59` above) for each tab.

Plain JavaScript, no build step, no dependencies, no telemetry.

## Features

- Per-tab reload intervals: **5s, 10s, 15s, 30s, 60s, 5m, 10m, 15m, 30m, 60m**, plus **Off**
- Live countdown on the toolbar icon showing time until the next reload (seconds below one minute, `m:ss` above)
- State is cleared automatically when the tab closes
- Reload state resets on browser restart (session-scoped)

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select this directory.

## Usage

Click the toolbar icon, pick an interval, and the current tab reloads on that schedule. Pick a different interval to change it, or **Off** to stop. Each tab is configured independently.

Restricted pages (`chrome://` pages, the Chrome Web Store, the PDF viewer, etc.) can't be auto-reloaded; the popup shows an inline error instead.

## How it works

`chrome.alarms` can't fire more often than every 30 seconds, so the timer lives in the page itself:

- The service worker (`background.js`) injects a small function via `chrome.scripting.executeScript` that arms a `setTimeout(() => location.reload(), ms)` in the tab. The page reloads itself — no message round-trips.
- The reload wipes the injected script, so a `chrome.tabs.onUpdated` listener (`status: 'complete'`) re-injects the timer and re-sets the badge after every load.
- The injected script also ticks a message to the service worker once per second, which repaints the countdown. The ticks keep the worker awake while any tab is monitored; with no timers active it idles out as usual.
- The countdown is drawn onto the toolbar icon with `OffscreenCanvas` + `chrome.action.setIcon` rather than the native badge: the badge renders in the system UI font, whose proportional digits (1, 5, 7…) make the text visibly shift as it ticks. Drawing it ourselves in a monospace font keeps every frame perfectly centered.
- Per-tab config lives in `chrome.storage.session` (`tabId → seconds`), which survives service-worker termination but resets with the browser. The worker keeps no in-memory state.
- Turning a tab off injects a one-shot `clearTimeout`, since injected scripts can't be removed.
- `chrome.tabs.onRemoved` cleans up storage when a tab closes; if a monitored tab navigates somewhere injection fails, its state and badge are dropped gracefully.

## Permissions

| Permission | Why |
| --- | --- |
| `tabs` | Read the tab URL to detect pages that can't be injected |
| `scripting` | Inject the timer function into pages |
| `storage` | Keep per-tab intervals in `chrome.storage.session` |
| `<all_urls>` | Re-injection after each reload happens without a user gesture, so `activeTab` can't work |
