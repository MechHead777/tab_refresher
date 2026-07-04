const presetButtons = [...document.querySelectorAll('button[data-seconds]')];
const offButton = document.getElementById('off');
const errorBox = document.getElementById('error');

function showError(text) {
  errorBox.textContent = text;
  errorBox.hidden = false;
}

function markActive(seconds) {
  for (const button of presetButtons) {
    button.classList.toggle('active', Number(button.dataset.seconds) === seconds);
  }
  offButton.classList.toggle('active', seconds === null);
}

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
if (!tab) {
  showError('No active tab found.');
} else {
  const current = await chrome.runtime.sendMessage({ type: 'get', tabId: tab.id });
  markActive(current.ok ? current.seconds : null);

  for (const button of presetButtons) {
    button.addEventListener('click', async () => {
      const seconds = Number(button.dataset.seconds);
      const res = await chrome.runtime.sendMessage({ type: 'set', tabId: tab.id, seconds });
      if (res.ok) {
        window.close();
      } else {
        showError(res.error);
      }
    });
  }

  offButton.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clear', tabId: tab.id });
    window.close();
  });
}
