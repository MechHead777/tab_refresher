const PILL_COLOR = '#174ea6';

function storageKey(tabId) {
  return `tab:${tabId}`;
}

function countdownText(remainingMs) {
  const r = Math.max(0, Math.ceil(remainingMs / 1000));
  const mm = String(Math.floor(r / 60)).padStart(2, '0');
  const ss = String(r % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function isInjectableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return false;
  // The Web Store blocks content scripts even over https.
  if (['chromewebstore.google.com', 'chrome.google.com'].includes(parsed.hostname)) return false;
  return true;
}

// Runs in the page: (re)arm the reload timer, replacing any existing one.
// Also ticks once per second to update a corner countdown overlay and to
// let the service worker paint the icon; the tick messages double as a
// service-worker keep-alive.
function pageStartTimer(ms) {
  clearTimeout(window.__tabRefresherTimeoutId);
  clearInterval(window.__tabRefresherTickerId);
  document.getElementById('__tab-refresher-overlay')?.remove();

  const deadline = Date.now() + ms;
  window.__tabRefresherTimeoutId = setTimeout(() => location.reload(), ms);

  // Corner overlay: fixed-position shadow-DOM host so page styles can't
  // leak in, pointer-events: none so it never blocks interaction.
  const host = document.createElement('div');
  host.id = '__tab-refresher-overlay';
  host.style.cssText =
    'position:fixed;right:12px;bottom:12px;z-index:2147483647;pointer-events:none;';
  const label = document.createElement('span');
  label.style.cssText =
    'display:block;padding:4px 10px;border-radius:6px;background:rgba(0,0,0,0.65);' +
    'color:#fff;font:600 16px/1.4 monospace;';
  host.attachShadow({ mode: 'open' }).appendChild(label);
  (document.body ?? document.documentElement).appendChild(host);

  const render = () => {
    const r = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    label.textContent = `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
  };
  render();

  window.__tabRefresherTickerId = setInterval(() => {
    render();
    try {
      chrome.runtime
        .sendMessage({ type: 'tick', remainingMs: deadline - Date.now() })
        .catch(() => {});
    } catch {
      // Extension was reloaded/removed; this context is orphaned.
      clearInterval(window.__tabRefresherTickerId);
      document.getElementById('__tab-refresher-overlay')?.remove();
    }
  }, 1000);
}

// Runs in the page: cancel the reload timer.
function pageCancelTimer() {
  clearTimeout(window.__tabRefresherTimeoutId);
  clearInterval(window.__tabRefresherTickerId);
  delete window.__tabRefresherTimeoutId;
  delete window.__tabRefresherTickerId;
  document.getElementById('__tab-refresher-overlay')?.remove();
}

async function injectTimer(tabId, seconds) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pageStartTimer,
    args: [seconds * 1000],
  });
}

// The countdown is drawn as the icon instead of the native badge: the badge
// renders in the system UI font, whose proportional digits make the text
// shift around as it ticks, and both badge and icon are clipped to a fixed
// 16-dip square — so the countdown takes over the whole square, and the
// default icon returns when the timer is off. Layout is a static 2x2 grid:
// minutes on the top row, seconds below, always zero-padded to two digits,
// so every frame has four digits in identical positions.
function drawCountdownCanvas(size, text) {
  const [mm, ss] = text.split(':');
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PILL_COLOR;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, Math.round(size * 0.2));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.round(size * 0.54)}px monospace`;
  ctx.fillText(mm, size / 2, size * 0.265);
  ctx.fillText(ss, size / 2, size * 0.765);
  return canvas;
}

async function paintCountdown(tabId, text) {
  const imageData = {};
  for (const size of [16, 32]) {
    const canvas = drawCountdownCanvas(size, text);
    imageData[size] = canvas.getContext('2d').getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ tabId, imageData });
}

async function resetIcon(tabId) {
  try {
    await chrome.action.setIcon({
      tabId,
      path: { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
    });
  } catch {
    // Tab already gone.
  }
}

async function setReload(tabId, seconds) {
  const tab = await chrome.tabs.get(tabId);
  if (!isInjectableUrl(tab.url)) {
    throw new Error("This page can't be auto-reloaded.");
  }
  await injectTimer(tabId, seconds);
  await chrome.storage.session.set({ [storageKey(tabId)]: seconds });
  await paintCountdown(tabId, countdownText(seconds * 1000));
}

async function clearReload(tabId) {
  await chrome.storage.session.remove(storageKey(tabId));
  await resetIcon(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: pageCancelTimer,
    });
  } catch {
    // Can't inject (restricted page or tab gone) — a pending timeout
    // can't outlive its page, so state cleanup above is sufficient.
  }
}

async function handleMessage(msg, sender) {
  try {
    switch (msg.type) {
      case 'tick': {
        // Countdown tick from a page's timer script.
        const tabId = sender?.tab?.id;
        if (tabId === undefined) return { ok: false };
        const key = storageKey(tabId);
        const data = await chrome.storage.session.get(key);
        // Ignore stale ticks from a tab that was just turned off.
        if (data[key] === undefined) return { ok: false };
        await paintCountdown(tabId, countdownText(msg.remainingMs));
        return { ok: true };
      }
      case 'get': {
        const key = storageKey(msg.tabId);
        const data = await chrome.storage.session.get(key);
        return { ok: true, seconds: data[key] ?? null };
      }
      case 'set':
        await setReload(msg.tabId, msg.seconds);
        return { ok: true };
      case 'clear':
        await clearReload(msg.tabId);
        return { ok: true };
      default:
        return { ok: false, error: `Unknown message type: ${msg.type}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse);
  return true;
});

// After each load, re-arm the timer and badge for monitored tabs. State is
// read fresh from session storage so this works across service-worker restarts.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  const key = storageKey(tabId);
  const data = await chrome.storage.session.get(key);
  const seconds = data[key];
  if (seconds === undefined) return;
  try {
    if (!isInjectableUrl(tab.url)) {
      throw new Error('uninjectable');
    }
    await injectTimer(tabId, seconds);
    await paintCountdown(tabId, countdownText(seconds * 1000));
  } catch {
    // Tab navigated somewhere we can't inject; stop monitoring it.
    await chrome.storage.session.remove(key);
    await resetIcon(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(storageKey(tabId));
});
