(() => {
  'use strict';
  const DEFAULTS = { enabled: true, mode: 'hide', blockShorts: true, skipShorts: true, guardWatch: true, hoverButton: true, showBadge: true };
  let settings = { ...DEFAULTS };
  const $ = (id) => document.getElementById(id);

  const render = () => {
    $('enabled').checked = settings.enabled;
    $('blockShorts').checked = settings.blockShorts;
    $('skipShorts').checked = settings.skipShorts;
    $('row-skipShorts').classList.toggle('moot', settings.blockShorts); // all Shorts are blocked anyway
    $('guardWatch').checked = settings.guardWatch;
    $('hoverButton').checked = settings.hoverButton;
    $('showBadge').checked = settings.showBadge;
    $('mode-hide').classList.toggle('active', settings.mode !== 'dim');
    $('mode-dim').classList.toggle('active', settings.mode === 'dim');
    document.body.classList.toggle('off', !settings.enabled);
  };
  const save = () => chrome.storage.local.set({ settings });

  const loadStats = async () => {
    const got = await chrome.storage.local.get(['aiDaily', 'cache2', 'blockedVideos', 'blockedChannels']);
    $('stat-total').textContent = Object.values(got.aiDaily || {}).reduce((a, b) => a + b, 0).toLocaleString();
    $('stat-checked').textContent = got.cache2 ? Object.keys(got.cache2).length : 0;
    $('n-channels').textContent = Object.keys(got.blockedChannels || {}).length;
    $('n-videos').textContent = Object.keys(got.blockedVideos || {}).length;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const s = await chrome.tabs.sendMessage(tab.id, { type: 'avf:stats' });
      if (s) { $('stat-here').textContent = s.hiddenHere; $('stat-checked').textContent = s.checked; }
    } catch (e) { $('stat-here').textContent = '–'; } // not a YouTube tab
  };

  const init = async () => {
    const got = await chrome.storage.local.get('settings');
    if (got.settings) settings = { ...DEFAULTS, ...got.settings };
    render();
    loadStats();

    for (const key of ['enabled', 'blockShorts', 'skipShorts', 'guardWatch', 'hoverButton', 'showBadge']) {
      $(key).addEventListener('change', () => { settings[key] = $(key).checked; render(); save(); });
    }
    $('mode-hide').onclick = () => { settings.mode = 'hide'; render(); save(); };
    $('mode-dim').onclick = () => { settings.mode = 'dim'; render(); save(); };
    $('stats').onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL('stats.html') }); window.close(); };
    $('manage').onclick = () => { chrome.runtime.openOptionsPage(); window.close(); };
    $('clear').onclick = async () => {
      await chrome.storage.local.set({ cache2: {} });
      loadStats();
    };
  };
  init();
})();
