// Background tasks: the count on the toolbar icon, and opening the extension's
// pages when asked from a YouTube tab (content scripts can't do either themselves).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'avf:open' && ['stats.html', 'manage.html'].includes(msg.page)) {
    chrome.tabs.create({ url: chrome.runtime.getURL(msg.page) });
  }
  if (msg?.type === 'avf:badge' && sender.tab?.id != null) {
    const n = Number(msg.count) || 0;
    const tabId = sender.tab.id;
    chrome.action.setBadgeText({ tabId, text: n <= 0 ? '' : n > 999 ? '999+' : String(n) });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#dc2626' });
    chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' });
  }
});

// When a tab starts loading a new page (e.g. leaving YouTube), clear its count.
// On YouTube the page re-sends its own count right away.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
