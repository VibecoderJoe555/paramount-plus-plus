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
  let enabledNow = true;
  let lastBadge = null;

  const sendBadge = (text, tone) => {
    const key = text + '|' + tone;
    if (key === lastBadge) return;
    lastBadge = key;
    try {
      Promise.resolve(browser.runtime.sendMessage({ type: 'PQM_BADGE', text: text, tone: tone })).catch(() => {});
    } catch (_) {}
  };

  const updateBadge = () => {
    if (!enabledNow) {
      sendBadge('OFF', 'off');
      return;
    }
    if (recovering) {
      sendBadge('...', 'warn');
      return;
    }

    const video = document.querySelector('video');
    const height = video && video.videoHeight ? video.videoHeight : 0;
    const target = stats && stats.height ? stats.height : 0;
    const shown = height || target;

    if (!shown) {
      sendBadge('', 'off');
      return;
    }

    const label = shown >= 1080 ? 'HD' : 'SD';
    const met = !target || shown >= target;
    sendBadge(label, met ? 'good' : 'warn');
  };

  const pushConfig = () => {
    browser.storage.local.get({ enabled: true, mode: '1080' }).then((s) => {
      enabledNow = !!s.enabled;
      window.postMessage({ __pqm: 'config', payload: { enabled: enabledNow, mode: s.mode } }, '*');
      updateBadge();
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
      updateBadge();
    } else if (event.data.type === 'recovering') {
      recovering = !!payload.active;
      updateBadge();
    } else if (event.data.type === 'applying') {
      applying = !!payload.active;
      if (applying) lastApplyAt = Date.now();
    } else if (event.data.type === 'ready') {
      sawReady = true;
      pushConfig();
    }
  });

  pushConfig();
  setInterval(updateBadge, 2000);

  /* ---- stuck-playback watchdog ---- */

  const RELOAD_KEY = 'pqmStuckReloadAt';
  let lastTime = -1;
  let advancingAt = Date.now();
  let expectBy = 0;
  let lastApplyAt = 0;
  let wasApplying = false;
  let wasRecovering = false;

  const stuckText = () => {
    try {
      const body = document.body;
      return !!body && /optimizing your video playback/i.test(body.innerText || '');
    } catch (_) {
      return false;
    }
  };

  const reloadOnce = (reason) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    } catch (_) {}
    if (last && Date.now() - last < 60000) return;
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch (_) {}
    console.info('[Paramount++] playback stuck (' + reason + '), reloading');
    location.reload();
  };

  setInterval(() => {
    if (!enabledNow) return;

    const now = Date.now();
    const video = document.querySelector('video');

    if (video && video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      advancingAt = now;
    }

    // A switch that finished without playback resuming is the spinner case.
    if (wasApplying && !applying) expectBy = now + 8000;
    if (wasRecovering && !recovering) expectBy = now + 8000;
    wasApplying = applying;
    wasRecovering = recovering;

    const pausedByUser = video && video.paused && video.readyState >= 2 && video.currentTime > 0;
    const alive = pausedByUser || now - advancingAt < 3000;

    if (expectBy) {
      if (now > expectBy) {
        expectBy = 0;
        if (!alive) {
          reloadOnce('no playback after switch');
          return;
        }
      }
    }

    if (!expectBy && alive === false && lastApplyAt && now - lastApplyAt < 45000 && stuckText()) {
      reloadOnce('optimizing overlay');
    }
  }, 1000);

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
