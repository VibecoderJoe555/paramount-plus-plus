'use strict';

const $ = (id) => document.getElementById(id);

const state = { enabled: true, mode: '1080', busy: false };
let recoveringSince = 0;

const onParamount = (url) => /^https?:\/\/([^/]+\.)?paramountplus\.com\//i.test(url || '');

const activeTab = async () => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
};

const fmt = (w, h) => (w && h ? w + '\u00d7' + h : null);

const label = (h) => (h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : h + 'p');

function paint() {
  $('dot').classList.toggle('on', state.enabled);
  $('toggle').checked = state.enabled;
  $('toggle').disabled = state.busy;
  $('stateWord').textContent = state.enabled ? 'On' : 'Off';
  const buttons = $('modes').querySelectorAll('button');
  for (let i = 0; i < buttons.length; i++) {
    buttons[i].classList.toggle('active', buttons[i].dataset.mode === state.mode);
    buttons[i].disabled = !state.enabled || state.busy;
  }
}

function show(resText, subText, tone) {
  const res = $('res');
  const sub = $('sub');
  res.textContent = resText;
  res.className = 'res' + (resText.length > 8 ? '' : ' idle');
  sub.textContent = subText || '';
  sub.className = 'sub' + (tone ? ' ' + tone : '');
}

function setHint(on) {
  const hint = $('hint');
  if (!on) {
    if (hint.textContent) hint.textContent = '';
    hint.dataset.on = '0';
    return;
  }
  if (hint.dataset.on === '1') return;
  hint.dataset.on = '1';
  hint.textContent = 'Taking a while? Press ';
  const key = document.createElement('kbd');
  key.textContent = 'Ctrl+Shift+R';
  hint.append(key, ' to reload.');
}

function render(data) {
  state.busy = !!(data && (data.recovering || data.applying));
  paint();

  if (!state.enabled) {
    recoveringSince = 0;
    setHint(false);
    show('Off', 'Paramount+ plays at its default quality.');
    return;
  }

  if (!data) {
    recoveringSince = 0;
    setHint(false);
    show('Reload the tab', 'The extension is not attached to this page.');
    return;
  }

  if (data.recovering) {
    if (!recoveringSince) recoveringSince = Date.now();
    show('Switching\u2026', 'Finding a source that allows HD.', 'warn');
    setHint(Date.now() - recoveringSince > 8000);
    return;
  }

  if (data.applying) {
    recoveringSince = 0;
    setHint(false);
    show('Switching\u2026', 'Applying your quality setting.', 'warn');
    return;
  }

  recoveringSince = 0;
  setHint(false);

  const video = data.video;
  if (!video || !video.height) {
    show('Waiting', 'Start a video to begin.');
    return;
  }

  const res = fmt(video.width, video.height);
  const stats = data.stats;
  const target = stats && stats.height ? stats.height : video.height;

  if (video.height >= target) {
    show(res, 'Locked to ' + label(video.height) + '.', 'good');
  } else {
    show(res, 'Playing ' + label(video.height) + ' \u2014 target is ' + label(target) + '.', 'warn');
  }
}

async function refresh() {
  const tab = await activeTab();
  if (!tab || !onParamount(tab.url)) {
    recoveringSince = 0;
    setHint(false);
    show('Not available', 'Open a Paramount+ video to begin.');
    return;
  }
  try {
    const data = await browser.tabs.sendMessage(tab.id, { type: 'PQM_GET_STATUS' });
    render(data);
  } catch (_) {
    recoveringSince = 0;
    setHint(false);
    show('Reload the tab', 'The extension is not attached to this page.');
  }
}

async function save() {
  await browser.storage.local.set({ enabled: state.enabled, mode: state.mode });
  paint();
  const tab = await activeTab();
  if (tab) {
    try {
      await browser.tabs.sendMessage(tab.id, { type: 'PQM_RECONFIG' });
    } catch (_) {}
  }
  setTimeout(refresh, 250);
}

async function init() {
  const stored = await browser.storage.local.get({ enabled: true, mode: '1080' });
  state.enabled = !!stored.enabled;
  state.mode = stored.mode === '720' ? '720' : '1080';
  paint();

  $('toggle').addEventListener('change', (event) => {
    state.enabled = event.target.checked;
    save();
  });

  $('modes').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]');
    if (!button || !state.enabled) return;
    if (button.dataset.mode !== '720' && button.dataset.mode !== '1080') return;
    state.mode = button.dataset.mode;
    save();
  });

  await refresh();
  setInterval(refresh, 1000);
}

init().catch((err) => show('Error', err.message));
