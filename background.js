const BADGE_COLOR = '#1a73e8';

function storageKey(tabId) {
  return `tab:${tabId}`;
}

function badgeText(seconds) {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
}

function countdownText(remainingMs) {
  const r = Math.max(0, Math.ceil(remainingMs / 1000));
  return r >= 60 ? `${Math.ceil(r / 60)}m` : `${r}s`;
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

async function setBadge(tabId, seconds) {
  await chrome.action.setBadgeText({ tabId, text: badgeText(seconds) });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
}

async function clearBadge(tabId) {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
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
  await setBadge(tabId, seconds);
}

async function clearReload(tabId) {
  await chrome.storage.session.remove(storageKey(tabId));
  await clearBadge(tabId);
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
        await chrome.action.setBadgeText({ tabId, text: countdownText(msg.remainingMs) });
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
    await setBadge(tabId, seconds);
  } catch {
    // Tab navigated somewhere we can't inject; stop monitoring it.
    await chrome.storage.session.remove(key);
    await clearBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(storageKey(tabId));
});
