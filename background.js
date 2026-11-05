'use strict';

const TONES = {
  good: '#2e7d32',
  warn: '#b26a00',
  off: '#5f5f6b'
};

// Badges are per-tab and disappear with the tab, so there is nothing to clean up.
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'PQM_BADGE') return;
  const tabId = sender.tab && sender.tab.id;
  if (typeof tabId !== 'number') return;

  const text = typeof msg.text === 'string' ? msg.text.slice(0, 4) : '';
  const color = TONES[msg.tone] || TONES.good;

  try {
    browser.action.setBadgeText({ tabId: tabId, text: text });
    if (text) browser.action.setBadgeBackgroundColor({ tabId: tabId, color: color });
  } catch (_) {}
});
