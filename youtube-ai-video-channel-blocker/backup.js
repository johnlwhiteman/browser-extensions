/* Backup & restore: one file with everything, for moving to another installation.
 * Importing merges into what's already there (it never deletes anything), and
 * importing the same file twice doesn't double-count statistics. */
const Backup = (() => {
  'use strict';
  const KEYS = ['settings', 'blockedVideos', 'blockedChannels', 'allowedVideos', 'allowedChannels',
    'aiLog', 'aiDaily', 'searchLog', 'cache2'];
  const APP = 'youtube-ai-video-channel-blocker';

  const exportAll = async () => {
    const data = await chrome.storage.local.get(KEYS);
    const file = { app: APP, format: 2, exportedAt: new Date().toISOString(), data };
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `youtube-ai-blocker-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return {
      channels: Object.keys(data.blockedChannels || {}).length,
      videos: Object.keys(data.blockedVideos || {}).length,
      ai: Object.keys(data.aiLog || {}).length
    };
  };

  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  const importAll = async (text) => {
    const parsed = JSON.parse(text);
    // Accept full backups and the older "blocked list only" export.
    const inc = parsed.app === APP && parsed.data ? parsed.data : parsed;
    if (!inc.blockedVideos && !inc.blockedChannels && !inc.aiLog) throw new Error('Not a backup from this extension');
    const cur = await chrome.storage.local.get(KEYS);
    const out = {};
    const added = { channels: 0, videos: 0, allowed: 0, ai: 0 };

    const mergeList = (key, countKey) => {
      const c = obj(cur[key]);
      for (const [k, v] of Object.entries(obj(inc[key]))) {
        if (!c[k]) { c[k] = v; added[countKey]++; }
      }
      out[key] = c;
    };
    mergeList('blockedChannels', 'channels');
    mergeList('blockedVideos', 'videos');
    mergeList('allowedChannels', 'allowed');
    mergeList('allowedVideos', 'allowed');

    // AI log: same video seen on both installs → keep the bigger numbers
    const log = obj(cur.aiLog);
    for (const [id, e] of Object.entries(obj(inc.aiLog))) {
      const m = log[id];
      if (!m) { log[id] = e; added.ai++; continue; }
      for (const k of ['t', 'n', 'c', 'h']) if (!m[k] && e[k]) m[k] = e[k];
      m.first = Math.min(m.first || e.first, e.first || m.first);
      m.last = Math.max(m.last || 0, e.last || 0);
      m.seen = Math.max(m.seen || 0, e.seen || 0);
      m.where = obj(m.where);
      for (const [w, n] of Object.entries(obj(e.where))) m.where[w] = Math.max(m.where[w] || 0, n);
      m.q = [...new Set([...(m.q || []), ...(e.q || [])])].slice(0, 5);
    }
    out.aiLog = log;

    const daily = obj(cur.aiDaily);
    for (const [d, n] of Object.entries(obj(inc.aiDaily))) daily[d] = Math.max(daily[d] || 0, n);
    out.aiDaily = daily;

    const sl = obj(cur.searchLog);
    for (const [q, e] of Object.entries(obj(inc.searchLog))) {
      const m = sl[q];
      sl[q] = m ? {
        searches: Math.max(m.searches || 0, e.searches || 0), ai: Math.max(m.ai || 0, e.ai || 0),
        blocked: Math.max(m.blocked || 0, e.blocked || 0), last: Math.max(m.last || 0, e.last || 0)
      } : e;
    }
    out.searchLog = sl;

    // detection results: keep the most recently checked answer
    const cache = obj(cur.cache2);
    for (const [id, e] of Object.entries(obj(inc.cache2))) {
      if (!cache[id] || (e.d || 0) > (cache[id].d || 0)) cache[id] = e;
    }
    out.cache2 = cache;

    if (inc.settings && !cur.settings) out.settings = inc.settings;
    await chrome.storage.local.set(out);
    return added;
  };

  const summary = (a) => {
    const parts = [];
    if (a.channels) parts.push(`${a.channels} blocked channel${a.channels === 1 ? '' : 's'}`);
    if (a.videos) parts.push(`${a.videos} blocked video${a.videos === 1 ? '' : 's'}`);
    if (a.allowed) parts.push(`${a.allowed} allowed item${a.allowed === 1 ? '' : 's'}`);
    if (a.ai) parts.push(`${a.ai} AI video${a.ai === 1 ? '' : 's'} in the log`);
    return parts.length ? `Imported ${parts.join(', ')}.` : 'Imported. Everything in that file was already here.';
  };

  return { exportAll, importAll, summary };
})();
