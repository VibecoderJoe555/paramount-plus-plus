/*
 * Paramount++ - isolated-world content script.
 * Injects the page engine and relays config/status to the popup.
 */
(() => {
  'use strict';

  if (window.__pqmContent) return;
  window.__pqmContent = true;

  const script = document.createElement('script');
  script.src = browser.runtime.getURL('page.js');
  script.addEventListener('load', () => script.remove());
  (document.head || document.documentElement).appendChild(script);

  let stats = null;
  let recovering = false;
  let applying = false;
  let sawReady = false;
  let applyTimer = null;

  const pushConfig = () => {
    browser.storage.local.get({ enabled: true, mode: '1080' }).then((s) => {
      window.postMessage({ __pqm: 'config', payload: { enabled: !!s.enabled, mode: s.mode } }, '*');
    });
  };

  // Debounced so a burst of clicks restarts the stream once.
  const scheduleApply = () => {
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      applyTimer = null;
      browser.storage.local.get({ enabled: true, mode: '1080' }).then((s) => {
        window.postMessage({ __pqm: 'apply', payload: { enabled: !!s.enabled, mode: s.mode } }, '*');
      });
    }, 700);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__pqm !== true) return;
    const payload = event.data.payload || {};
    if (event.data.type === 'status') {
      stats = payload.stats || null;
    } else if (event.data.type === 'recovering') {
      recovering = !!payload.active;
    } else if (event.data.type === 'applying') {
      applying = !!payload.active;
    } else if (event.data.type === 'ready') {
      sawReady = true;
      pushConfig();
    }
  });

  pushConfig();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled || changes.mode) {
      pushConfig();
      scheduleApply();
    }
  });

  browser.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg || typeof msg !== 'object') return false;

    if (msg.type === 'PQM_GET_STATUS') {
      const video = document.querySelector('video');
      respond({
        sawReady: sawReady,
        stats: stats,
        recovering: recovering,
        applying: applying,
        video: video
          ? { width: video.videoWidth || 0, height: video.videoHeight || 0, paused: video.paused }
          : null
      });
      return true;
    }

    if (msg.type === 'PQM_RECONFIG') {
      pushConfig();
      respond({ ok: true });
      return true;
    }

    return false;
  });
})();
