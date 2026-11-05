/*
 * Paramount++ - page-context engine.
 *
 * Paramount ships two video ladders: an avc3 HD set (1080/720) and an avc1 SD
 * set (540 and below), each with its own content key. The player only accepts
 * avc1, so it plays the SD ladder.
 *
 * This script keeps only the representations at the requested height and drops
 * the sets that end up empty. Forcing HD usually triggers a missing-key error
 * (2103) on the ad-inserted source; failover.js catches that and reloads through
 * the alternate source where the key is granted.
 */
(() => {
  'use strict';

  if (window.__pqmPage) return;
  if (window.__pqmDisabled) {
    console.info('[Paramount++] disabled for this load');
    return;
  }
  window.__pqmPage = true;

  const TAG = '[Paramount++]';
  const SEGMENT_RE = /\.(m4s|mp4|m4a|m4v|ts|aac|vtt|srt|jpg|jpeg|png|webp|gif|css|woff2?)(\?|#|$)/i;
  const MAYBE_MANIFEST_RE = /manifest|playlist|\.mpd|m3u8|dash|hls|smoothstreaming|\.ism/i;

  let enabled = true;
  let mode = '1080';

  const stats = {
    manifests: 0,
    kind: null,
    width: 0,
    height: 0,
    bandwidth: 0,
    targetKID: null,
    sourceId: null
  };

  window.__pqmState = stats;

  const post = (type, payload) => {
    try {
      window.postMessage({ __pqm: true, type, payload }, '*');
    } catch (_) {}
  };

  const shortUrl = (u) => {
    const clean = String(u || '').split('?')[0];
    return clean.length > 110 ? '\u2026' + clean.slice(-110) : clean;
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__pqm !== 'config') return;
    const payload = event.data.payload || {};
    enabled = !!payload.enabled;
    mode = payload.mode === '720' ? '720' : '1080';
  });

  /* ============================ rewriters ============================ */

  const capFor = (m) => (m === '720' ? 720 : 1080);

  function manifestKind(text, url, contentType) {
    const ct = String(contentType || '').toLowerCase();
    const u = String(url || '');
    if (/dash\+xml/.test(ct) || /\.mpd(\?|#|$)/i.test(u)) return 'dash';
    if (/mpegurl|mpeg-url|vnd\.apple/.test(ct) || /\.m3u8(\?|#|$)/i.test(u)) return 'hls';
    const head = text.slice(0, 2000);
    if (/<MPD[\s>]/i.test(head)) return 'dash';
    if (/^\s*#EXTM3U/m.test(head)) return 'hls';
    return null;
  }

  function adaptationKind(set) {
    const ct = (set.getAttribute('contentType') || '').toLowerCase();
    const mime = (set.getAttribute('mimeType') || '').toLowerCase();
    if (ct === 'video' || mime.indexOf('video/') === 0) return 'video';
    if (ct === 'audio' || mime.indexOf('audio/') === 0) return 'audio';
    const reps = set.getElementsByTagName('Representation');
    for (let i = 0; i < reps.length; i++) {
      const m = (reps[i].getAttribute('mimeType') || '').toLowerCase();
      if (m.indexOf('video/') === 0) return 'video';
      if (m.indexOf('audio/') === 0) return 'audio';
    }
    return null;
  }

  function repInfo(rep) {
    return {
      width: parseInt(rep.getAttribute('width') || '0', 10) || 0,
      height: parseInt(rep.getAttribute('height') || '0', 10) || 0,
      bandwidth: parseInt(rep.getAttribute('bandwidth') || '0', 10) || 0
    };
  }

  function repBetter(a, b) {
    if (a.height !== b.height) return a.height > b.height;
    if (a.width !== b.width) return a.width > b.width;
    return a.bandwidth > b.bandwidth;
  }

  function directReps(set) {
    const out = [];
    for (let c = 0; c < set.children.length; c++) {
      if (set.children[c].localName === 'Representation') out.push(set.children[c]);
    }
    return out;
  }

  function directCP(set) {
    const out = [];
    for (let c = 0; c < set.children.length; c++) {
      if (set.children[c].localName === 'ContentProtection') out.push(set.children[c]);
    }
    return out;
  }

  // Content key of the rendition we are forcing, so failover can confirm a
  // missing-key error is ours and not an unrelated playback problem.
  function setKid(set) {
    const cps = directCP(set);
    for (let i = 0; i < cps.length; i++) {
      if (cps[i].getAttribute('schemeIdUri') !== 'urn:mpeg:dash:mp4protection:2011') continue;
      for (let a = 0; a < cps[i].attributes.length; a++) {
        if (cps[i].attributes[a].localName === 'default_KID') return cps[i].attributes[a].value;
      }
    }
    return null;
  }

  function videoSetsOf(scope) {
    const out = [];
    for (let c = 0; c < scope.children.length; c++) {
      const el = scope.children[c];
      if (el.localName === 'AdaptationSet' && adaptationKind(el) === 'video') out.push(el);
    }
    return out;
  }

  // Highest height present in every period, at or below the requested cap.
  function pickTarget(perScopeHeights) {
    if (!perScopeHeights.length) return 0;
    let common = null;
    for (let s = 0; s < perScopeHeights.length; s++) {
      const heights = perScopeHeights[s];
      if (!heights.size) return 0;
      if (!common) {
        common = new Set(heights);
      } else {
        common.forEach((h) => {
          if (!heights.has(h)) common.delete(h);
        });
      }
    }
    if (!common || !common.size) return 0;

    const cap = capFor(mode);
    let best = 0;
    common.forEach((h) => {
      if (h <= cap && h > best) best = h;
    });
    if (best) return best;
    common.forEach((h) => {
      if (h > best) best = h;
    });
    return best;
  }

  function rewriteMpd(text) {
    let doc;
    try {
      doc = new DOMParser().parseFromString(text, 'application/xml');
    } catch (_) {
      return null;
    }
    if (!doc || doc.getElementsByTagName('parsererror').length) return null;

    const periods = doc.getElementsByTagName('Period');
    const scopes = [];
    for (let i = 0; i < periods.length; i++) scopes.push(periods[i]);
    if (!scopes.length) scopes.push(doc.documentElement);

    const groups = [];
    const heights = [];
    for (let s = 0; s < scopes.length; s++) {
      const sets = videoSetsOf(scopes[s]);
      if (!sets.length) continue;
      const seen = new Set();
      for (let v = 0; v < sets.length; v++) {
        const reps = directReps(sets[v]);
        for (let r = 0; r < reps.length; r++) {
          const h = repInfo(reps[r]).height;
          if (h) seen.add(h);
        }
      }
      groups.push({ scope: scopes[s], sets: sets });
      heights.push(seen);
    }

    const target = pickTarget(heights);
    if (!target) return null;

    let changed = false;
    for (let g = 0; g < groups.length; g++) {
      const { scope, sets } = groups[g];
      for (let v = sets.length - 1; v >= 0; v--) {
        const set = sets[v];
        const reps = directReps(set);
        for (let r = 0; r < reps.length; r++) {
          if (repInfo(reps[r]).height !== target) {
            set.removeChild(reps[r]);
            changed = true;
          }
        }
        if (!directReps(set).length) {
          scope.removeChild(set);
          changed = true;
        }
      }
    }
    if (!changed) return null;

    let best = null;
    let kid = null;
    for (let g = 0; g < groups.length; g++) {
      const sets = groups[g].sets;
      for (let v = 0; v < sets.length; v++) {
        if (!sets[v].parentNode) continue;
        const reps = directReps(sets[v]);
        for (let r = 0; r < reps.length; r++) {
          const info = repInfo(reps[r]);
          if (info.height !== target) continue;
          if (!best || repBetter(info, best)) {
            best = info;
            kid = setKid(sets[v]);
          }
        }
      }
    }

    return {
      kind: 'dash',
      text: new XMLSerializer().serializeToString(doc),
      width: best ? best.width : 0,
      height: best ? best.height : target,
      bandwidth: best ? best.bandwidth : 0,
      kid: kid
    };
  }

  function rewriteHls(text) {
    const lines = text.split(/\r?\n/);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF:/i.test(lines[i])) continue;
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) continue;
      const res = /RESOLUTION=(\d+)x(\d+)/i.exec(lines[i]);
      const bw = /BANDWIDTH=(\d+)/i.exec(lines[i]);
      variants.push({
        tagLine: i,
        uriLine: j,
        width: res ? parseInt(res[1], 10) : 0,
        height: res ? parseInt(res[2], 10) : 0,
        bandwidth: bw ? parseInt(bw[1], 10) : 0
      });
    }
    if (variants.length < 2) return null;

    const cap = capFor(mode);
    let target = 0;
    for (let i = 0; i < variants.length; i++) {
      const h = variants[i].height;
      if (h && h <= cap && h > target) target = h;
    }
    if (!target) {
      for (let i = 0; i < variants.length; i++) {
        if (variants[i].height > target) target = variants[i].height;
      }
    }

    const keep = variants.filter((v) => v.height === target);
    if (!keep.length) return null;

    const drop = new Set();
    for (let i = 0; i < variants.length; i++) {
      if (variants[i].height === target) continue;
      drop.add(variants[i].tagLine);
      drop.add(variants[i].uriLine);
    }

    const out = [];
    for (let i = 0; i < lines.length; i++) {
      if (drop.has(i)) continue;
      if (/^#EXT-X-I-FRAME-STREAM-INF:/i.test(lines[i])) continue;
      out.push(lines[i]);
    }

    let best = keep[0];
    for (let i = 1; i < keep.length; i++) {
      if (repBetter(keep[i], best)) best = keep[i];
    }

    return {
      kind: 'hls',
      text: out.join('\n'),
      width: best.width,
      height: best.height,
      bandwidth: best.bandwidth,
      kid: null
    };
  }

  function rewriteManifest(text, url, contentType) {
    const kind = manifestKind(text, url, contentType);
    if (kind === 'dash') return rewriteMpd(text);
    if (kind === 'hls') return rewriteHls(text);
    return null;
  }

  /* ============================== hooks ============================== */

  function isManifestUrl(url) {
    return /\.(mpd|m3u8)(\?|#|$)/i.test(String(url || ''));
  }

  function isManifestType(ct) {
    return /dash\+xml|mpegurl|mpeg-url|vnd\.apple/i.test(String(ct || ''));
  }

  function looksManifestish(url, ct) {
    if (isManifestType(ct) || isManifestUrl(url)) return true;
    if (SEGMENT_RE.test(String(url || ''))) return false;
    return MAYBE_MANIFEST_RE.test(String(url || ''));
  }

  function report(result, url) {
    stats.manifests += 1;
    stats.kind = result.kind;
    stats.width = result.width;
    stats.height = result.height;
    stats.bandwidth = result.bandwidth;
    stats.targetKID = result.kid || null;
    const match = /\/content\/(\d+)\//.exec(String(url || ''));
    if (match) stats.sourceId = match[1];
    post('status', { stats: stats });
    console.info(
      TAG,
      'locked ' + result.kind + ' to ' + result.width + 'x' + result.height +
      ' @ ' + Math.round(result.bandwidth / 1000) + ' kbps'
    );
  }

  function buildResponse(res, result, url) {
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    headers.delete('content-range');
    const out = new Response(result.text, {
      status: res.status,
      statusText: res.statusText,
      headers: headers
    });
    try {
      Object.defineProperty(out, 'url', { value: url });
    } catch (_) {}
    return out;
  }

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
      const promise = nativeFetch.apply(this, arguments);
      if (!enabled) return promise;

      return promise.then(function (res) {
        try {
          if (!res || !res.ok) return res;
          const ct = res.headers.get('content-type') || '';
          if (!looksManifestish(url, ct)) return res;
          if (res.bodyUsed) return res;

          return res.clone().text().then(function (text) {
            let result = null;
            try {
              result = rewriteManifest(text, url, ct);
            } catch (err) {
              console.debug(TAG, 'rewrite failed', err);
            }
            if (!result || result.text === text) return res;
            report(result, url);
            return buildResponse(res, result, url);
          }).catch(function () {
            return res;
          });
        } catch (_) {
          return res;
        }
      });
    };
  }

  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto) {
    const nativeOpen = XHRProto.open;

    XHRProto.open = function (method, url) {
      const out = nativeOpen.apply(this, arguments);
      try {
        this.__pqmUrl = String(url || '');
        this.addEventListener('readystatechange', onXhrState, true);
      } catch (_) {}
      return out;
    };

    function onXhrState() {
      if (this.readyState !== 4 || this.__pqmDone) return;
      if (!enabled) return;
      try {
        const ct = this.getResponseHeader('content-type') || '';
        const url = this.__pqmUrl || '';
        if (!looksManifestish(url, ct)) return;

        let text = null;
        const type = this.responseType;
        if (type === '' || type === 'text') {
          text = this.responseText;
        } else if (type === 'arraybuffer' && this.response) {
          text = new TextDecoder('utf-8').decode(new Uint8Array(this.response));
        }
        if (!text) return;

        let result = null;
        try {
          result = rewriteManifest(text, url, ct);
        } catch (_) {}
        if (!result || result.text === text) return;

        this.__pqmDone = true;
        report(result, url);

        const self = this;
        const value = result.text;
        Object.defineProperty(self, 'responseText', {
          configurable: true,
          get: function () { return value; }
        });
        if (type === '' || type === 'text') {
          Object.defineProperty(self, 'response', {
            configurable: true,
            get: function () { return value; }
          });
        } else if (type === 'arraybuffer') {
          const buffer = new TextEncoder().encode(value).buffer;
          Object.defineProperty(self, 'response', {
            configurable: true,
            get: function () { return buffer; }
          });
        }
      } catch (err) {
        console.debug(TAG, 'xhr rewrite failed', err);
      }
    }
  }

  post('ready');
  console.info(TAG, 'installed');
})();
