# Tab Refresher

Chrome extension (Manifest V3) that auto-reloads individual tabs on a timer. Each tab gets its own interval, and the toolbar icon turns into a live countdown while a timer is running.

Plain JavaScript — no build step, no dependencies, no telemetry.

## Features

- Per-tab intervals: 5s, 10s, 15s, 30s, 60s, 5m, 10m, 15m, 30m, 60m, or off
- Countdown on the toolbar icon: minutes on top, seconds below
- Countdown overlay in the page's bottom-right corner (shadow DOM, `pointer-events: none`, so it never fights the page)
- State clears when a tab closes, and resets on browser restart

## Install

1. Clone the repo
2. Open `chrome://extensions` and enable Developer mode
3. Click **Load unpacked** and select this folder

## Usage

Click the icon and pick an interval. Pick a different one to change it, or **Off** to stop. Tabs are independent of each other.

Pages that can't run content scripts (`chrome://`, the Web Store, the PDF viewer) can't be reloaded — the popup will tell you.

## How it works

`chrome.alarms` won't fire more often than every 30 seconds, so the timer lives in the page instead: the service worker injects a function that arms `setTimeout(() => location.reload(), ms)`, and re-injects it from `tabs.onUpdated` after every load since the reload wipes it out.

The injected script also ticks once a second — updating the corner overlay and messaging the service worker, which redraws the icon countdown with `OffscreenCanvas`. The native badge isn't used because it renders in the system UI font, where uneven digit widths make the text wobble as it counts; drawing monospace digits across the full icon avoids that and gets bigger text anyway.

Per-tab config lives in `chrome.storage.session`, so it survives service-worker shutdowns but resets with the browser. Turning a timer off injects a one-shot `clearTimeout` (injected scripts can't be removed), and `tabs.onRemoved` cleans up when a tab closes.

## Permissions

| Permission | Why |
| --- | --- |
| `scripting` | Inject the timer into pages |
| `storage` | Per-tab intervals in `chrome.storage.session` |
| `<all_urls>` | Re-injection after a reload happens without a user gesture, so `activeTab` isn't enough. Also covers reading tab URLs — no separate `tabs` permission, so no "read your browsing history" warning |

## Security notes

- Control messages (`set`/`clear`/`get`) are only accepted from the popup; ticks only from a tab's injected script, identified by `sender.tab.id` rather than anything in the message. A page context can't use the worker to script other tabs.
- Intervals are validated against the preset list, so a forged message can't arm a near-zero reload loop.
- No `innerHTML`, no `eval`, no external requests; the injected functions are fixed code taking one validated number.
- The only stored data is `tabId → seconds`, in session storage.

One inherent limitation: the overlay and timer live in the page, so a page could detect them, remove them, or spoof the overlay. Only matters if a site is actively targeting the extension.
