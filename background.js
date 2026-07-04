const PILL_COLOR = '#174ea6';

function storageKey(tabId) {
  return `tab:${tabId}`;
}

function countdownText(remainingMs) {
  const r = Math.max(0, Math.ceil(remainingMs / 1000));
  if (r < 60) return `${r}s`;
  return `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
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
// Also ticks once per second so the service worker can paint a live
// countdown badge; the tick messages double as a service-worker keep-alive.
function pageStartTimer(ms) {
  clearTimeout(window.__tabRefresherTimeoutId);
  clearInterval(window.__tabRefresherTickerId);
  const deadline = Date.now() + ms;
  window.__tabRefresherTimeoutId = setTimeout(() => location.reload(), ms);
  window.__tabRefresherTickerId = setInterval(() => {
    try {
      chrome.runtime
        .sendMessage({ type: 'tick', remainingMs: deadline - Date.now() })
        .catch(() => {});
    } catch {
      // Extension was reloaded/removed; this context is orphaned.
      clearInterval(window.__tabRefresherTickerId);
    }
  }, 1000);
}

// Runs in the page: cancel the reload timer.
function pageCancelTimer() {
  clearTimeout(window.__tabRefresherTimeoutId);
  clearInterval(window.__tabRefresherTickerId);
  delete window.__tabRefresherTimeoutId;
  delete window.__tabRefresherTickerId;
}

async function injectTimer(tabId, seconds) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: pageStartTimer,
    args: [seconds * 1000],
  });
}

// The countdown is drawn onto the icon instead of the native badge: the
// badge renders in the system UI font, whose proportional digits make the
// text shift around as it ticks. Drawing ourselves lets us use a monospace
// font and exact centering.
let iconBitmapPromise;
function baseIconBitmap() {
  iconBitmapPromise ??= fetch(chrome.runtime.getURL('icons/icon128.png'))
    .then((r) => r.blob())
    .then(createImageBitmap);
  return iconBitmapPromise;
}

async function drawCountdownCanvas(size, text) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(await baseIconBitmap(), 0, 0, size, size);
  const pillH = Math.round(size * 0.55);
  const y = size - pillH;
  ctx.fillStyle = PILL_COLOR;
  ctx.beginPath();
  ctx.roundRect(0, y, size, pillH, Math.round(size * 0.15));
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Wide strings like "60:00" can't fit at the base size; shrink those only.
  const maxWidth = size * 0.94;
  let fontSize = Math.round(pillH * 0.75);
  do {
    ctx.font = `bold ${fontSize}px monospace`;
    if (ctx.measureText(text).width <= maxWidth) break;
    fontSize--;
  } while (fontSize > 5);
  ctx.fillText(text, size / 2, y + pillH / 2 + size * 0.03);
  return canvas;
}

async function paintCountdown(tabId, text) {
  const imageData = {};
  for (const size of [16, 32]) {
    const canvas = await drawCountdownCanvas(size, text);
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
