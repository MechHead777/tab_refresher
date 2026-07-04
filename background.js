const BADGE_COLOR = '#1a73e8';

function storageKey(tabId) {
  return `tab:${tabId}`;
}

function badgeText(seconds) {
  return seconds < 60 ? `${seconds}s` : `${seconds / 60}m`;
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
function pageStartTimer(ms) {
  clearTimeout(window.__tabRefresherTimeoutId);
  window.__tabRefresherTimeoutId = setTimeout(() => location.reload(), ms);
}

// Runs in the page: cancel the reload timer.
function pageCancelTimer() {
  clearTimeout(window.__tabRefresherTimeoutId);
  delete window.__tabRefresherTimeoutId;
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

async function handleMessage(msg) {
  try {
    switch (msg.type) {
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
  handleMessage(msg).then(sendResponse);
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
