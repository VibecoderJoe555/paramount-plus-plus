/*
 * Paramount++ - DAI source failover (page context).
 *
 * Forcing the HD rendition can fail with player error 2103 / cause 4012
 * (category 4) when the licence response does not include the key for the HD
 * asset on the current DAI (SSAI) source. The media and the manifest are fine;
 * the entitlement for that key is not granted on this stream.
 *
 * Recovery: reload the same title through the player's own SDK using the
 * alternate CMS source id, keeping the playback position, then let the normal
 * manifest rewrite apply HD there. If that also fails, reload once with the
 * extension switched off so the viewer gets stock playback instead of an error.
 */
(() => {
  'use strict';

  if (window.__pqmFailover) return;
  window.__pqmFailover = true;

  const TAG = '[Paramount++:recover]';
  const DISABLE_KEY = 'pqmDisable';
  const EVENTS = [
    'TagEvent.ON_FATAL_ERROR',
    'TagEvent.ON_PLAYER_EVENT',
    'TagEvent.ON_CREATE_PLAYER_SUCCESS',
    'TagEvent.ON_DESTROY_PLAYER_SUCCESS'
  ];
  const MAX_ATTEMPTS = 2;
  const RECOVERY_TIMEOUT_MS = 45000;

  // A previous run gave up and asked for one clean reload.
  if (sessionStorage.getItem(DISABLE_KEY) === '1') {
    sessionStorage.removeItem(DISABLE_KEY);
    window.__pqmDisabled = true;
    console.info(TAG, 'extension disabled for this load after a failed recovery');
    return;
  }

  const safe = (fn, fallback) => {
    try {
      const value = fn();
      return value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  const normalize = (value) => String(value || '').replace(/-/g, '').toLowerCase();

  // Volume and mute live on the <video> element, so a reload resets them.
  const captureAv = (video) => (video ? { volume: video.volume, muted: video.muted } : null);

  // The player mutes the element for autoplay and tracks that in its own model.
  // Setting element.muted back leaves the two out of sync: audio plays but the
  // UI still shows muted. Push the state through the player's own API when it
  // exposes one, and otherwise click its "Unmute" control if it disagrees.
  function syncPlayerMute(api, state) {
    const player = safe(() => api && api.PLAYER, null);
    if (!player) {
      console.info(TAG, 'no player API, cannot resync mute');
      return;
    }
    if (!state) return;

    let handled = false;
    if (typeof player.setVolume === 'function') {
      safe(() => player.setVolume(state.volume));
      handled = true;
    } else if (typeof player.volume === 'function') {
      safe(() => player.volume(state.volume));
      handled = true;
    }

    if (typeof player.setMuted === 'function') {
      safe(() => player.setMuted(state.muted));
      handled = true;
    } else if (typeof player.mute === 'function') {
      if (player.mute.length >= 1) safe(() => player.mute(state.muted));
      else if (!state.muted) safe(() => player.mute());
      handled = true;
    }

    // Some builds expose a volume plugin instead of player methods.
    if (!handled && typeof player.getPlugin === 'function') {
      const names = ['volume', 'Volume', 'audio', 'Audio', 'volumePlugin'];
      for (let i = 0; i < names.length; i++) {
        const plugin = safe(() => player.getPlugin(names[i]), null);
        if (!plugin) continue;
        if (typeof plugin.setMuted === 'function') {
          safe(() => plugin.setMuted(state.muted));
          handled = true;
        }
        if (typeof plugin.setVolume === 'function') {
          safe(() => plugin.setVolume(state.volume));
          handled = true;
        }
        if (handled) break;
      }
    }

    if (handled) {
      console.info(TAG, 'volume/mute restored through the player API');
      return;
    }

    if (state.muted) return;
    console.info(TAG, 'player has no volume API, looking for the mute control');
    resyncViaControl(state);
  }

  // Walk open shadow roots too; player chrome is often encapsulated.
  function deepQueryAll(selector) {
    const out = [];
    const walk = (root) => {
      try {
        const found = root.querySelectorAll(selector);
        for (let i = 0; i < found.length; i++) out.push(found[i]);
      } catch (_) {}
      let all;
      try {
        all = root.querySelectorAll('*');
      } catch (_) {
        return;
      }
      for (let i = 0; i < all.length; i++) {
        if (all[i].shadowRoot) walk(all[i].shadowRoot);
      }
    };
    walk(document);
    return out;
  }

  const isClickable = (el) => {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'button' || tag === 'a') return true;
    if (el.getAttribute && el.getAttribute('role') === 'button') return true;
    try {
      return getComputedStyle(el).cursor === 'pointer';
    } catch (_) {
      return false;
    }
  };

  function resyncViaControl(state) {
    setTimeout(() => {
      const video = document.querySelector('video');
      if (!video || video.muted !== state.muted || state.muted) return;

      const labelled = deepQueryAll('[aria-label*="mute" i],[title*="mute" i],[data-testid*="mute" i]');
      let control = labelled.filter(isClickable)[0] || labelled[0];

      if (!control) {
        const byClass = deepQueryAll('[class*="mute" i],[class*="volume" i]');
        control = byClass.filter(isClickable)[0] || null;
        if (control) {
          console.info(TAG, 'using class-matched control: ' + (control.className || control.tagName));
        }
      }

      if (!control) {
        console.info(TAG, 'no mute control found, leaving audio alone');
        return;
      }

      console.info(TAG, 'clicking the mute control to resync');
      safe(() => control.click());

      // If that actually muted us, undo it: the element must stay unmuted.
      setTimeout(() => {
        const now = document.querySelector('video');
        if (now && now.muted) {
          console.info(TAG, 'control muted the element, clicking back');
          safe(() => control.click());
          safe(() => { now.muted = false; });
        }
      }, 250);
    }, 600);
  }

  function restoreAv(state, api, oldVideo) {
    if (!state) return;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const video = document.querySelector('video');
      const stale = video && oldVideo && video === oldVideo && Date.now() - startedAt < 4000;
      if (video && !stale && video.readyState >= 2) {
        clearInterval(timer);
        safe(() => {
          video.volume = state.volume;
          video.muted = state.muted;
        });
        syncPlayerMute(api, state);
      } else if (Date.now() - startedAt > 20000) {
        clearInterval(timer);
      }
    }, 250);
  }

  let tag = null;
  let poll = null;
  let watch = null;
  let pending = null;
  let attempts = 0;
  let teardownSeen = false;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const state = () => window.__pqmState || null;

  const announce = (active) => {
    try {
      window.postMessage({ __pqm: true, type: 'recovering', payload: { active: active } }, '*');
    } catch (_) {}
  };

  function findTag() {
    const list = safe(() => window.SmartTag && window.SmartTag.list, null);
    if (!list || list.length !== 1) return null;
    const candidate = list[0];
    if (!candidate || !candidate.eventDispatcher) return null;
    return candidate;
  }

  function onEvent(event) {
    try {
      if (!event) return;
      const error = findError(event);
      if (error) {
        handleError(error);
        return;
      }
      if (event.type === 'TagEvent.ON_DESTROY_PLAYER_SUCCESS') {
        teardownSeen = true;
      }
      if (event.type === 'TagEvent.ON_CREATE_PLAYER_SUCCESS' && pending) startWatch();
    } catch (err) {
      console.debug(TAG, 'event handler failed', err);
    }
  }

  function findError(value, seen, depth) {
    if (!value || typeof value !== 'object') return null;
    const visited = seen || new Set();
    const level = depth || 0;
    if (level > 8 || visited.has(value)) return null;
    visited.add(value);
    if (value.fatal === true && value.code !== undefined) return value;
    const names = ['error', 'detail', 'cause', 'data', 'playerEvent', 'originalError', 'original'];
    for (let n = 0; n < names.length; n++) {
      const child = value[names[n]];
      const list = Array.isArray(child) ? child : [child];
      for (let i = 0; i < list.length; i++) {
        const found = findError(list[i], visited, level + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function bind() {
    const next = findTag();
    if (!next || next === tag) return;
    if (tag) {
      for (let i = 0; i < EVENTS.length; i++) {
        safe(() => tag.eventDispatcher.removeEventListener(EVENTS[i], onEvent));
      }
    }
    tag = next;
    let bound = false;
    if (typeof tag.tagEventsHandler === 'function') {
      bound = safe(() => {
        tag.tagEventsHandler(onEvent, EVENTS);
        return true;
      }, false);
    }
    if (!bound) {
      for (let i = 0; i < EVENTS.length; i++) {
        safe(() => tag.eventDispatcher.addEventListener(EVENTS[i], onEvent));
      }
    }
    console.info(TAG, 'bound to player SDK');
  }

  function isCatalogUrl(url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return false;
      if (!['vod.pplus.paramount.tech', 'vod-gcs-cedexis.cbsaavideo.com'].includes(parsed.hostname)) return false;
      return /\/[^/]*_cenc_[^/]*dash\/stream\.mpd$/i.test(parsed.pathname);
    } catch (_) {
      return false;
    }
  }

  function clearErrorOverlay() {
    safe(() => {
      const tagRef = tag;
      tagRef.dispatchTagEvent(tagRef.getTagEventVO('TagEvent.ON_REQUEST_TO_CLEAR_ERROR', tagRef));
    });
  }

  function handleError(error) {
    if (pending) return;

    if (String(error.code) !== '2103') return;
    if (error.fatal !== true) return;

    const cause = error.cause;
    if (!cause) return;
    if (Number(cause.code) !== 4012) return;
    if (Number(cause.category) !== 4) return;

    const restriction = Array.isArray(cause.data) ? cause.data[0] : null;
    if (!restriction) return;
    if (restriction.hasAppRestrictions !== false) return;
    const restricted = restriction.restrictedKeyStatuses;
    if (Array.isArray(restricted) && restricted.length) return;

    const missing = (Array.isArray(restriction.missingKeys) ? restriction.missingKeys : [])
      .map(normalize)
      .filter(Boolean);
    if (!missing.length) return;

    const snapshot = state();
    const targetKID = snapshot && snapshot.targetKID ? normalize(snapshot.targetKID) : null;
    if (!targetKID) {
      console.info(TAG, 'no tracked key id, skipping failover');
      return;
    }
    if (missing.indexOf(targetKID) === -1) {
      console.info(TAG, 'missing key is not the forced rendition');
      return;
    }

    if (!tag) {
      bind();
      if (!tag) return;
    }

    const alternate = safe(() => String(tag.model.TagConstants.ADOPS_ID.CMSID), '');
    const current = snapshot && snapshot.sourceId ? String(snapshot.sourceId) : '';
    if (!/^\d+$/.test(alternate) || !current || alternate === current) {
      console.info(TAG, 'no alternate source id available');
      return;
    }

    const catalog = safe(() => tag.model.apiMetadata.streamingUrl, '');
    if (!isCatalogUrl(catalog)) {
      console.info(TAG, 'catalog manifest url not usable');
      return;
    }

    const api = safe(() => tag.API, null);
    if (!api || !api.VIDEO || typeof api.VIDEO.load !== 'function') {
      console.info(TAG, 'player load api unavailable');
      return;
    }

    const content = safe(() => tag.params.CONTENT, null);
    if (!content || !content.millstone) {
      console.info(TAG, 'content descriptor unavailable');
      return;
    }

    if (attempts >= MAX_ATTEMPTS) {
      giveUp('attempts-exhausted');
      return;
    }

    const video = document.querySelector('video');
    const playerTime = safe(() => api.PLAYER.contentTime, null);
    const resume = Number.isFinite(playerTime) ? playerTime : (video ? video.currentTime || 0 : 0);
    const paused = video ? video.paused : true;

    const next = Object.assign({}, content, {
      globalResumeTime: Math.max(0, resume),
      autoplay: true,
      millstone: Object.assign({}, content.millstone, {
        streamingUrl: catalog,
        daiParams: Object.assign({}, content.millstone.daiParams || {}, { daiCmsId: alternate })
      })
    });

    attempts += 1;
    teardownSeen = false;
    const job = {
      startedAt: Date.now(),
      errorAt: Date.now(),
      target: snapshot.height,
      time: Math.max(0, resume),
      paused: paused,
      alternate: alternate,
      api: api,
      av: captureAv(video),
      video: video
    };
    pending = job;

    console.info(TAG, 'reloading via alternate source ' + alternate + ' at ' + Math.round(resume) + 's');
    announce(true);
    runRecovery(next, job);
  }

  // Smart Tag destroys the failed player asynchronously and ignores VIDEO.load
  // while one is still attached, so wait for teardown (or for the video element
  // to disappear) before asking for the other source.
  function runRecovery(content, job) {
    const startedAt = Date.now();

    const step = () => {
      if (pending !== job) return;
      const attached = Array.prototype.some.call(
        document.querySelectorAll('video'),
        (video) => Boolean(video.player)
      );
      if (!teardownSeen && attached && Date.now() - startedAt < 5000) {
        setTimeout(step, 50);
        return;
      }
      if (Date.now() - job.errorAt < 250) {
        setTimeout(step, 50);
        return;
      }

      clearErrorOverlay();
      let result;
      try {
        result = job.api.VIDEO.load({ CONTENT: content });
      } catch (err) {
        console.info(TAG, 'load threw: ' + (err && err.message));
        giveUp('load-threw');
        return;
      }
      if (result && typeof result.then === 'function') {
        result.then(
          () => console.info(TAG, 'load accepted'),
          (err) => console.info(TAG, 'load rejected: ' + (err && err.message))
        );
      } else {
        console.info(TAG, 'load called');
      }
      startWatch();
      restoreAv(job.av, job.api, job.video);
    };

    step();
  }

  function stopWatch() {
    if (watch) {
      clearInterval(watch);
      watch = null;
    }
  }

  function startWatch() {
    if (!pending || watch) return;
    const started = pending.startedAt;
    watch = setInterval(() => {
      if (!pending) { stopWatch(); return; }
      const video = document.querySelector('video');
      if (video) {
        const height = video.videoHeight || 0;
        const ready = video.readyState >= 3 && height > 0;
        if (ready && Math.abs(height - pending.target) <= 16) {
          const api = safe(() => tag && tag.API, null);
          if (Math.abs(video.currentTime - pending.time) > 2) {
            safe(() => {
              if (api && api.PLAYER && typeof api.PLAYER.seek === 'function') api.PLAYER.seek(pending.time);
              else video.currentTime = pending.time;
            });
          }
          if (pending.paused) {
            safe(() => {
              video.pause();
              if (api && api.PLAYER) api.PLAYER.pause();
            });
          } else if (video.paused) {
            safe(() => {
              if (api && api.PLAYER) api.PLAYER.play();
              else video.play();
            });
          }
          console.info(TAG, 'recovered at ' + height + 'p');
          announce(false);
          stopWatch();
          pending = null;
          return;
        }
      }
      if (Date.now() - started > RECOVERY_TIMEOUT_MS) {
        giveUp('timeout');
      }
    }, 500);
  }

  function giveUp(reason) {
    stopWatch();
    pending = null;
    announce(false);
    console.info(TAG, 'giving up (' + reason + '), reloading with the extension off');
    safe(() => sessionStorage.setItem(DISABLE_KEY, '1'));
    safe(() => location.reload());
  }

  // Re-initialise the current title so a quality/toggle change takes effect
  // immediately. Smart Tag cannot survive overlapping VIDEO.load calls, so any
  // change requested while one is running is refused; the popup disables its
  // controls for that window, so no queue is needed.
  let applyState = 'idle';
  let appliedKey = null;

  const applyKey = (payload) =>
    payload ? String(!!payload.enabled) + '|' + String(payload.mode || '') : null;

  const announceApplying = (active) => {
    try {
      window.postMessage({ __pqm: true, type: 'applying', payload: { active: active } }, '*');
    } catch (_) {}
  };

  function requestApply(payload) {
    const key = applyKey(payload);

    if (key && key === appliedKey) return;

    if (pending) {
      console.info(TAG, 'change will land with the recovery reload');
      return;
    }
    if (applyState === 'loading') {
      console.info(TAG, 'change refused: a reload is already running');
      return;
    }
    startApply(key);
  }

  function startApply(key) {
    const current = findTag();
    if (!current) return;

    const api = safe(() => current.API, null);
    const content = safe(() => current.params.CONTENT, null);
    const video = document.querySelector('video');

    if (!api || !api.VIDEO || typeof api.VIDEO.load !== 'function' || !content) {
      console.info(TAG, 'cannot apply live, reloading page');
      safe(() => location.reload());
      return;
    }

    const playerTime = safe(() => api.PLAYER.contentTime, null);
    const resume = Number.isFinite(playerTime) ? playerTime : (video ? video.currentTime || 0 : 0);
    const wasPaused = video ? video.paused : false;
    const av = captureAv(video);

    const next = Object.assign({}, content, {
      globalResumeTime: Math.max(0, resume),
      autoplay: true
    });

    console.info(TAG, 'applying quality change at ' + Math.round(resume) + 's');
    applyState = 'loading';
    announceApplying(true);

    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      applyState = 'idle';
      // Only remember a change that actually took, so a failure stays retryable.
      appliedKey = ok ? key : null;
      announceApplying(false);
    };

    try {
      const result = api.VIDEO.load({ CONTENT: next });
      if (result && typeof result.then === 'function') {
        result.then(
          () => { console.info(TAG, 'quality change accepted'); done(true); },
          (err) => { console.info(TAG, 'quality change rejected: ' + (err && err.message)); done(false); }
        );
      } else {
        setTimeout(() => done(true), 1500);
      }
    } catch (err) {
      console.info(TAG, 'quality change threw: ' + (err && err.message));
      done(false);
      return;
    }

    // Never let a hung load block the controls forever.
    setTimeout(() => done(true), 15000);

    restoreAv(av, api, video);

    if (wasPaused) {      const startedAt = Date.now();
      const stop = setInterval(() => {
        const el = document.querySelector('video');
        if (el && el.readyState >= 3) {
          clearInterval(stop);
          safe(() => {
            el.pause();
            if (api.PLAYER) api.PLAYER.pause();
          });
        } else if (Date.now() - startedAt > 20000) {
          clearInterval(stop);
        }
      }, 300);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__pqm !== 'apply') return;
    requestApply(event.data.payload || null);
  });

  window.__pqmApplyNow = requestApply;

  poll = setInterval(() => {
    bind();
    if (tag && poll) {
      clearInterval(poll);
      poll = null;
    }
  }, 500);

  bind();
  console.info(TAG, 'installed');
})();
