# Tab Refresher

A Manifest V3 Chrome extension that auto-reloads individual tabs at a chosen interval. The extension icon shows a badge with the active interval (e.g. `10s`, `5m`) for each tab.

Plain JavaScript, no build step, no dependencies, no telemetry.

## Features

- Per-tab reload intervals: **5s, 10s, 15s, 30s, 60s, 5m, 10m, 15m, 30m, 60m**, plus **Off**
- Static badge on the toolbar icon showing the active interval for the current tab
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
