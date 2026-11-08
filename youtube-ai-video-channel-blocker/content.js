/* John's YouTube AI Video Channel Blocker
 *
 * 1) AI filter: YouTube only includes its AI-disclosure badge in watch-page data,
 *    not in the data behind feed/search/sidebar thumbnails. So for each video in a
 *    list, this script asks YouTube's own "next" endpoint (same site, no API key)
 *    for that video's badges + channel, caches the answer, and hides labeled items.
 *    Detection approach adapted from Weedout (MIT).
 * 2) Manual blocks: block a video or a whole channel from YouTube's three-dot menu,
 *    from a small button on each thumbnail, or from the watch page.
 */
(() => {
  'use strict';
  if (!globalThis.chrome?.storage) return;

  // ------------------------------------------------------------------ config
  const CONTAINER_SEL = [
    'ytd-rich-item-renderer',            // home, subscriptions, channel grids
    'ytd-video-renderer',                // search results, history
    'ytd-compact-video-renderer',        // older related sidebar
    'ytd-grid-video-renderer',           // older channel grid
    'ytd-playlist-video-renderer',       // playlist page
    'ytd-playlist-panel-video-renderer', // queue on watch page
    'ytd-reel-item-renderer',            // older Shorts shelf
    'yt-lockup-view-model',              // newer sidebar / grid cards
    'ytm-shorts-lockup-view-model',      // Shorts shelves
    'ytm-shorts-lockup-view-model-v2',
    'ytm-video-with-context-renderer',   // m.youtube.com
    'ytm-compact-video-renderer',
    'ytm-rich-item-renderer'
  ].join(',');

  const P = 'contents.twoColumnWatchNextResults.results.results.contents.';
  const FIELDS = [
    P + 'videoPrimaryInfoRenderer.badges',
    P + 'videoPrimaryInfoRenderer.title',
    P + 'videoSecondaryInfoRenderer.owner.videoOwnerRenderer.title',
    P + 'videoSecondaryInfoRenderer.owner.videoOwnerRenderer.navigationEndpoint.browseEndpoint'
  ].join(',');
  const CONCURRENCY = 4;
  const CLEAN_TTL_DAYS = 14;    // labels can be added later (auto-detection), so re-check
  const FLAGGED_TTL_DAYS = 180;
  const CACHE_MAX = 15000;
  const DEFAULTS = { enabled: true, mode: 'hide', skipShorts: true, guardWatch: true, hoverButton: true, showBadge: true };

  const AI_LABEL_RE =
    /(^|[\s(])(AI|IA|KI|ИИ)([\s):]|$)|made with ai|ai[- ]generated|synthetic|altered|generat|künstlich|sintétic|sintetic|yapay|生成|생성|人工知能/i;

  // ------------------------------------------------------------------- state
  let settings = { ...DEFAULTS };
  let cache = Object.create(null); // videoId -> {a: 0|1, d: day, c: channelId, h: @handle, n: channelName}
  let blockedVideos = {};          // videoId -> {title, channel, addedAt}
  let blockedChannels = {};        // key -> {id, handle, name, addedAt}
  let chanIds = new Set();
  let chanHandles = new Set();
  let allowedVideos = {};          // AI-labeled videos you chose to always show
  let allowedChannels = {};
  let allowIds = new Set();
  let allowHandles = new Set();
  let ready = false;
  const elsById = new Map();
  const titles = new Map();        // videoId -> title from lookups (not cached)
  const tabSeen = new Set();       // AI videos hidden in this tab
  let pageSeen = new Set();        // ...on the current page view
  let pageBlocked = new Set();
  let pendLog = {};                // unsaved AI-log changes (merged into storage on save)
  let pendDaily = {};
  let pendSearch = {};
  const queued = new Set();
  const failures = new Map();
  const queue = [];
  const waiters = new Map();       // videoId -> [resolve] for on-demand lookups
  let running = 0;
  let backoffUntil = 0;
  let clientVersion = null;
  let scanPending = false;
  let saveTimer = null;
  let lastSkip = { id: null, t: 0 };
  let lastHref = location.href;
  const allowedOnce = new Set();

  const today = () => Math.floor(Date.now() / 86400000);
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const runsText = (t) => t?.simpleText ?? (t?.runs || []).map((r) => r.text).join('');
  const clip = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

  // ------------------------------------------------------------- root attrs
  const applyRootAttrs = () => {
    const de = document.documentElement;
    if (!de) return;
    de.toggleAttribute('data-avf-on', !!settings.enabled);
    de.setAttribute('data-avf-mode', settings.mode === 'dim' ? 'dim' : 'hide');
  };

  // ---------------------------------------------------------------- storage
  const setBlocks = (v, c) => {
    blockedVideos = v && typeof v === 'object' ? v : {};
    blockedChannels = c && typeof c === 'object' ? c : {};
    chanIds = new Set();
    chanHandles = new Set();
    for (const r of Object.values(blockedChannels)) {
      if (r.id) chanIds.add(r.id);
      if (r.handle) chanHandles.add(r.handle.toLowerCase());
    }
  };

  const setAllowed = (v, c) => {
    allowedVideos = v && typeof v === 'object' ? v : {};
    allowedChannels = c && typeof c === 'object' ? c : {};
    allowIds = new Set();
    allowHandles = new Set();
    for (const r of Object.values(allowedChannels)) {
      if (r.id) allowIds.add(r.id);
      if (r.handle) allowHandles.add(r.handle.toLowerCase());
    }
  };

  const load = async () => {
    try {
      const got = await chrome.storage.local.get(['settings', 'cache2', 'blockedVideos', 'blockedChannels',
        'allowedVideos', 'allowedChannels']);
      if (got.settings) settings = { ...DEFAULTS, ...got.settings };
      if (got.cache2 && typeof got.cache2 === 'object') cache = got.cache2;
      setBlocks(got.blockedVideos, got.blockedChannels);
      setAllowed(got.allowedVideos, got.allowedChannels);
    } catch (e) { /* first run */ }
    chrome.storage.local.remove('cache').catch(() => {}); // old v1 cache format
    ready = true;
    applyRootAttrs();
    onNavigate();
  };

  const prune = () => {
    const ids = Object.keys(cache);
    if (ids.length <= CACHE_MAX) return;
    ids.sort((a, b) => (cache[a].d || 0) - (cache[b].d || 0));
    for (let i = 0; i < ids.length - Math.floor(CACHE_MAX * 0.8); i++) delete cache[ids[i]];
  };

  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      prune();
      try {
        await chrome.storage.local.set({ cache2: cache });
        await flushLog();
      } catch (e) { /* retry on next save */ }
    }, 2500);
  };

  // Merge this tab's new AI-log entries into storage (other tabs may be writing too).
  const LOG_MAX = 5000;
  const flushLog = async () => {
    if (!Object.keys(pendLog).length && !Object.keys(pendDaily).length && !Object.keys(pendSearch).length) return;
    const L = pendLog, D = pendDaily, S = pendSearch;
    pendLog = {}; pendDaily = {}; pendSearch = {};
    const got = await chrome.storage.local.get(['aiLog', 'aiDaily', 'searchLog']);
    const log = got.aiLog || {};
    const daily = got.aiDaily || {};
    const sl = got.searchLog || {};
    for (const [id, p] of Object.entries(L)) {
      const e = log[id] || (log[id] = { first: p.first, seen: 0, where: {}, q: [] });
      for (const k of ['t', 'n', 'c', 'h']) if (p[k]) e[k] = p[k];
      e.first = Math.min(e.first || p.first, p.first);
      e.last = Math.max(e.last || 0, p.last);
      e.seen = (e.seen || 0) + p.seen;
      e.where = e.where || {};
      for (const [w, n] of Object.entries(p.where)) e.where[w] = (e.where[w] || 0) + n;
      e.q = [...new Set([...p.q, ...(e.q || [])])].slice(0, 5);
    }
    const ids = Object.keys(log);
    if (ids.length > LOG_MAX) {
      ids.sort((a, b) => (log[a].last || 0) - (log[b].last || 0));
      for (let i = 0; i < ids.length - LOG_MAX; i++) delete log[ids[i]];
    }
    for (const [day, n] of Object.entries(D)) daily[day] = (daily[day] || 0) + n;
    for (const [q, s] of Object.entries(S)) {
      const e = sl[q] || (sl[q] = { searches: 0, ai: 0, blocked: 0 });
      e.searches += s.searches;
      e.ai = Math.max(e.ai || 0, s.ai);
      e.blocked = Math.max(e.blocked || 0, s.blocked);
      e.last = Math.max(e.last || 0, s.last);
    }
    const qs = Object.keys(sl);
    if (qs.length > 1000) {
      qs.sort((a, b) => (sl[a].last || 0) - (sl[b].last || 0));
      for (let i = 0; i < qs.length - 1000; i++) delete sl[qs[i]];
    }
    await chrome.storage.local.set({ aiLog: log, aiDaily: daily, searchLog: sl });
  };

  // --------------------------------------------------------------- AI log
  const dayKey = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
  const searchQuery = () =>
    location.pathname === '/results' ? (new URLSearchParams(location.search).get('search_query') || '').trim() : '';
  const whereNow = () => {
    const p = location.pathname;
    if (p === '/') return 'home';
    if (p === '/results') return 'search';
    if (p === '/watch') return 'watch';
    if (p.startsWith('/shorts')) return 'shorts';
    if (p.startsWith('/feed/subscriptions')) return 'subscriptions';
    if (p.startsWith('/playlist')) return 'playlist';
    if (/^\/(@|channel\/|c\/|user\/)/.test(p)) return 'channel';
    return 'other';
  };

  // ---------------------------------------------- count on the toolbar icon
  let badgeSent = -1;
  let badgeSentAt = 0;
  let badgeTimer = null;
  const updateBadge = (force = false) => {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      const n = settings.enabled && settings.showBadge ? pageSeen.size : 0;
      if (!force && n === badgeSent) return;
      badgeSent = n;
      badgeSentAt = Date.now();
      try { chrome.runtime.sendMessage({ type: 'avf:badge', count: n }).catch(() => {}); } catch (e) { /* extension reloaded */ }
    }, 150);
  };

  const recordAI = (id, el, info, where = whereNow()) => {
    if (pageSeen.has(id)) return;
    pageSeen.add(id);
    tabSeen.add(id);
    updateBadge();
    const now = Date.now();
    const ch = channelFor(el, info);
    const p = pendLog[id] || (pendLog[id] = { seen: 0, where: {}, q: [], first: now });
    p.t = p.t || titles.get(id) || domTitle(el) || undefined;
    p.n = ch.name; p.c = ch.id; p.h = ch.handle;
    p.last = now;
    p.seen++;
    p.where[where] = (p.where[where] || 0) + 1;
    const q = searchQuery();
    if (q && !p.q.includes(q)) p.q.push(q);
    const d = dayKey();
    pendDaily[d] = (pendDaily[d] || 0) + 1;
    scheduleSave();
  };

  const saveBlocks = () => chrome.storage.local.set({ blockedVideos, blockedChannels });

  // ------------------------------------------------------- reading the page
  const idFromHref = (h) => {
    if (!h) return null;
    const m = h.match(/[?&]v=([A-Za-z0-9_-]{11})/) || h.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  };
  const idOf = (el) => {
    const a = el.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
    return a ? idFromHref(a.getAttribute('href')) : null;
  };

  const domChannel = (el) => {
    const out = {};
    if (!el) return out;
    for (const a of el.querySelectorAll('a[href^="/@"], a[href^="/channel/"]')) {
      const href = a.getAttribute('href');
      const h = href.match(/^\/(@[^/?#]+)/);
      const c = href.match(/^\/channel\/(UC[\w-]{22})/);
      if (h && !out.handle) out.handle = safeDecode(h[1]);
      if (c && !out.id) out.id = c[1];
      const txt = (a.textContent || '').trim();
      if (txt && !out.name) out.name = txt;
    }
    if (!out.name) {
      const n = el.querySelector('ytd-channel-name #text, #channel-name #text, #owner #channel-name a');
      if (n?.textContent.trim()) out.name = n.textContent.trim();
    }
    return out;
  };

  const domTitle = (el) => {
    if (!el) return '';
    const t = el.querySelector('h1 yt-formatted-string, #video-title, a#video-title-link, ' +
      '.yt-lockup-metadata-view-model__title, h3 a, h3, [class*="title"]');
    return (t?.getAttribute?.('title') || t?.textContent || '').replace(/\s+/g, ' ').trim();
  };

  const channelFor = (el, info) => {
    const d = domChannel(el);
    return { id: info?.c || d.id, handle: info?.h || d.handle, name: info?.n || d.name };
  };

  const isBlocked = (vid, ch) =>
    !!blockedVideos[vid] ||
    !!(ch.id && chanIds.has(ch.id)) ||
    !!(ch.handle && chanHandles.has(ch.handle.toLowerCase()));

  const isAllowed = (vid, ch) =>
    !!allowedVideos[vid] ||
    !!(ch.id && allowIds.has(ch.id)) ||
    !!(ch.handle && allowHandles.has(ch.handle.toLowerCase()));

  // ---------------------------------------------------------------- lookups
  const getClientVersion = () => {
    if (clientVersion) return clientVersion;
    try {
      for (const s of document.scripts) {
        const m = (s.textContent || '').match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/);
        if (m) { clientVersion = m[1]; break; }
      }
    } catch (e) { /* ignore */ }
    return clientVersion || '2.20260101.00.00';
  };

  const badgeIsAI = (mb) => {
    const label = `${mb.label || ''} ${mb.tooltip || ''} ${mb.accessibilityData?.label || ''}`.trim();
    if (AI_LABEL_RE.test(label)) return true;
    return mb.icon?.iconType === 'INFO' && label.length <= 4; // short-label locale fallback
  };

  const parseInfo = (json) => {
    const info = { a: 0 };
    const contents = json?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
    for (const c of Array.isArray(contents) ? contents : []) {
      const p = c?.videoPrimaryInfoRenderer;
      if (p) {
        for (const b of p.badges || []) {
          if (b?.metadataBadgeRenderer && badgeIsAI(b.metadataBadgeRenderer)) info.a = 1;
        }
        const t = runsText(p.title);
        if (t) info.t = t;
      }
      const o = c?.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
      if (o) {
        const n = runsText(o.title);
        if (n) info.n = n;
        const be = o.navigationEndpoint?.browseEndpoint;
        if (be?.browseId) info.c = be.browseId;
        const h = (be?.canonicalBaseUrl || '').match(/^\/(@[^/?#]+)/);
        if (h) info.h = safeDecode(h[1]);
      }
    }
    return info;
  };

  const fetchInfo = async (id, useMask = true) => {
    const url = '/youtubei/v1/next?prettyPrint=false' +
      (useMask ? '&fields=' + encodeURIComponent(FIELDS) : '');
    const r = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: { client: { clientName: 'WEB', clientVersion: getClientVersion() } },
        videoId: id
      })
    });
    if (r.status === 400 && useMask) return fetchInfo(id, false);
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return parseInfo(await r.json());
  };

  const setInfo = (id, info) => {
    const entry = { a: info.a ? 1 : 0, d: today() };
    if (info.c) entry.c = info.c;
    if (info.h) entry.h = info.h;
    if (info.n) entry.n = info.n;
    cache[id] = entry;
    if (info.t) {
      titles.set(id, info.t);
      if (pendLog[id] && !pendLog[id].t) pendLog[id].t = info.t;
    }
    scheduleSave();
    reevaluateId(id);
    if (id === currentWatchId()) handleCurrentVideo();
    for (const resolve of waiters.get(id) || []) resolve({ ...entry, t: info.t });
    waiters.delete(id);
  };

  const pump = () => {
    if (!settings.enabled) return;
    const wait = backoffUntil - Date.now();
    if (wait > 0) { setTimeout(pump, wait + 50); return; }
    while (running < CONCURRENCY && queue.length) {
      const id = queue.shift();
      queued.delete(id);
      running++;
      fetchInfo(id)
        .then((info) => setInfo(id, info))
        .catch((e) => {
          const n = (failures.get(id) || 0) + 1;
          failures.set(id, n);
          if (e.status === 429 || e.status >= 500) backoffUntil = Date.now() + 30000;
          if (n < 2) enqueue(id);
          else { for (const r of waiters.get(id) || []) r(null); waiters.delete(id); }
        })
        .finally(() => { running--; pump(); if (location.pathname === '/results') trackSearch(); });
    }
  };

  const enqueue = (id, front = false) => {
    if (queued.has(id) || (failures.get(id) || 0) >= 2) return;
    queued.add(id);
    front ? queue.unshift(id) : queue.push(id);
    pump();
  };

  const cachedInfo = (id) => {
    const e = cache[id];
    if (!e || typeof e !== 'object') return null;
    if (today() - (e.d || 0) > (e.a ? FLAGGED_TTL_DAYS : CLEAN_TTL_DAYS)) enqueue(id);
    return e;
  };

  // Info right now (for a block action): cached, or fetched with priority.
  const getInfoNow = (id) => {
    if (cache[id]?.c) return Promise.resolve(cache[id]);
    return new Promise((resolve) => {
      if (!waiters.has(id)) waiters.set(id, []);
      waiters.get(id).push(resolve);
      failures.delete(id);
      if (queued.has(id)) { queue.splice(queue.indexOf(id), 1); queued.delete(id); }
      enqueue(id, true);
      setTimeout(() => resolve(cache[id] || null), 4000);
    });
  };

  // ------------------------------------------------------------- evaluation
  const evaluate = (el) => {
    const id = idOf(el);
    if (el.__avfId && el.__avfId !== id) {          // YouTube recycles cards
      elsById.get(el.__avfId)?.delete(el);
      el.removeAttribute('data-avf');
      el.removeAttribute('data-avf-block');
      el.__avfId = null;
    }
    if (!id) return;
    el.__avfId = id;
    if (!elsById.has(id)) elsById.set(id, new Set());
    elsById.get(id).add(el);
    const info = cachedInfo(id);
    if (!info) enqueue(id);
    const ch = channelFor(el, info);
    const blocked = isBlocked(id, ch);
    const ai = !blocked && info?.a === 1 && !isAllowed(id, ch);
    el.toggleAttribute('data-avf-block', blocked);
    el.toggleAttribute('data-avf', ai);
    if (blocked) pageBlocked.add(id);
    if (ai) recordAI(id, el, info);
  };

  const reevaluateId = (id) => {
    const set = elsById.get(id);
    if (!set) return;
    for (const el of set) el.isConnected ? evaluate(el) : set.delete(el);
  };

  const reevaluateAll = () => { for (const id of [...elsById.keys()]) reevaluateId(id); };

  const scan = () => {
    if (!ready || !settings.enabled || !document.body) return;
    document.querySelectorAll(CONTAINER_SEL).forEach(evaluate);
    checkWatchPageDom();
    injectWatchButton();
    handleCurrentVideo();
    trackSearch();
  };

  const scheduleScan = () => {
    if (scanPending) return;
    scanPending = true;
    setTimeout(() => { scanPending = false; scan(); }, 250);
  };

  // ------------------------------------------------- the video being watched
  const currentWatchId = () => {
    if (location.pathname === '/watch') return idFromHref(location.search);
    const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
    return m ? m[1] : null;
  };
  const isShortsPage = () => location.pathname.startsWith('/shorts/');

  // The watch-page element for the current video, only once it shows *this* video
  // (during SPA navigation the old video's details linger for a moment).
  const watchEl = () => {
    const id = currentWatchId();
    if (!id) return null;
    if (isShortsPage()) return document.querySelector('ytd-reel-video-renderer[is-active]');
    const flexy = document.querySelector('ytd-watch-flexy');
    if (flexy && flexy.getAttribute('video-id') !== id) return null;
    return document.querySelector('ytd-watch-metadata');
  };

  const checkWatchPageDom = () => {
    const id = currentWatchId();
    if (!id || isShortsPage() || cache[id]?.a === 1) return;
    const meta = watchEl();
    if (!meta) return;
    for (const b of meta.querySelectorAll('ytd-badge-supported-renderer .badge, [class*="badge"]')) {
      const label = `${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`.replace(/\s+/g, ' ').trim();
      if (label && label.length < 60 && AI_LABEL_RE.test(label)) {
        setInfo(id, { ...(cache[id] || {}), a: 1 });
        return;
      }
    }
  };

  const skipShort = (id) => {
    const now = Date.now();
    if (lastSkip.id === id && now - lastSkip.t < 2500) return;
    lastSkip = { id, t: now };
    const btn = document.querySelector('#navigation-button-down button, #navigation-button-down yt-button-shape button');
    if (btn) btn.click();
  };

  const removeGuard = () => document.getElementById('avf-guard')?.remove();

  const showGuard = (id, reason) => {
    const existing = document.getElementById('avf-guard');
    if (existing?.dataset.vid === id && existing.dataset.reason === reason) return;
    existing?.remove();
    document.querySelector('#movie_player video')?.pause();
    const g = document.createElement('div');
    g.id = 'avf-guard';
    g.dataset.vid = id;
    g.dataset.reason = reason;
    const blocked = reason !== 'ai';
    g.innerHTML = `
      <div class="avf-card">
        <div class="avf-badge ${blocked ? 'avf-badge-block' : ''}">${blocked ? 'BLOCKED' : 'AI'}</div>
        <h2></h2>
        <p></p>
        <div class="avf-actions">
          <button data-act="back">Go back</button>
          <button data-act="watch" class="avf-secondary">Watch anyway</button>
          ${blocked ? '<button data-act="unblock" class="avf-secondary">Unblock</button>'
    : '<button data-act="allow" class="avf-secondary" title="Never hide this channel\'s AI-labeled videos">Always allow this channel</button>'}
        </div>
      </div>`;
    g.querySelector('h2').textContent =
      reason === 'ai' ? 'YouTube labels this video as AI-generated or altered'
        : reason === 'channel' ? 'You blocked this channel' : 'You blocked this video';
    g.querySelector('p').textContent = "John's YouTube AI Video Channel Blocker paused it for you.";
    document.documentElement.appendChild(g);
    g.addEventListener('click', async (e) => {
      const act = e.target.closest('button')?.dataset.act;
      if (!act) return;
      if (act === 'back') {
        removeGuard();
        if (history.length > 1) history.back(); else location.href = '/';
      } else {
        if (act === 'unblock') await unblockFor(id, watchEl(), cache[id]);
        if (act === 'allow') await allowChannel(id, watchEl());
        allowedOnce.add(id);
        removeGuard();
        document.querySelector('#movie_player video')?.play();
      }
    });
  };

  const handleCurrentVideo = () => {
    const id = currentWatchId();
    if (!id || !settings.enabled || allowedOnce.has(id)) return;
    const info = cache[id];
    const ch = channelFor(watchEl(), info);
    let reason = null;
    if (blockedVideos[id]) reason = 'video';
    else if (isBlocked(id, ch)) reason = 'channel';
    else if (info?.a === 1 && !isAllowed(id, ch)) reason = 'ai';
    if (!reason) {
      const g = document.getElementById('avf-guard');
      if (g && g.dataset.vid === id) removeGuard(); // e.g. just unblocked from the list page
      return;
    }
    if (isShortsPage()) {
      if (reason !== 'ai' || settings.skipShorts) {
        if (reason === 'ai') recordAI(id, watchEl(), info, 'shorts');
        skipShort(id);
      }
    } else if (reason !== 'ai' || settings.guardWatch) {
      if (reason === 'ai') recordAI(id, watchEl(), info, 'opened');
      showGuard(id, reason);
    }
  };

  const onNavigate = () => {
    if (!ready) return;
    removeGuard();
    closeMiniMenu();
    clientVersion = null;
    pageSeen = new Set();
    pageBlocked = new Set();
    updateBadge(true);
    setTimeout(() => updateBadge(true), 1500); // after the browser's own reset on navigation
    const q = searchQuery();
    if (q) {
      const e = pendSearch[q] || (pendSearch[q] = { searches: 0, ai: 0, blocked: 0 });
      e.searches++;
      e.last = Date.now();
      scheduleSave();
    }
    trackSearch();
    const id = currentWatchId();
    if (id && settings.enabled) {
      if (cachedInfo(id)) handleCurrentVideo();
      else enqueue(id, true);
    }
    scheduleScan();
  };

  // --------------------------------------------------------- block actions
  const blockVideo = async (vid, el) => {
    const title = domTitle(el);
    blockedVideos[vid] = { title: title || vid, channel: '', addedAt: Date.now() };
    setBlocks(blockedVideos, blockedChannels);
    reevaluateAll();
    await saveBlocks();
    toast(`Blocked video${title ? ` “${clip(title, 50)}”` : ''}`, async () => {
      delete blockedVideos[vid];
      await saveBlocks();
    });
    if (vid === currentWatchId()) handleCurrentVideo();
    // fill in channel name / title for the list page
    getInfoNow(vid).then((info) => {
      if (!blockedVideos[vid] || !info) return;
      blockedVideos[vid].channel = info.n || channelFor(el, info).name || '';
      if (!title && info.t) blockedVideos[vid].title = info.t;
      saveBlocks();
    });
  };

  const blockChannel = async (vid, el) => {
    let ch = channelFor(el, cache[vid]);
    if (!ch.id) ch = channelFor(el, await getInfoNow(vid));
    if (!ch.id && !ch.handle) { toast("Couldn't identify this video's channel. Try again in a moment."); return; }
    const key = ch.id || ch.handle.toLowerCase();
    blockedChannels[key] = {
      id: ch.id || null, handle: ch.handle || null,
      name: ch.name || ch.handle || ch.id, addedAt: Date.now()
    };
    setBlocks(blockedVideos, blockedChannels);
    reevaluateAll();
    await saveBlocks();
    toast(`Blocked channel ${clip(blockedChannels[key].name, 40)}`, async () => {
      delete blockedChannels[key];
      await saveBlocks();
    });
    if (vid === currentWatchId()) handleCurrentVideo();
  };

  const unblockFor = async (vid, el, info) => {
    delete blockedVideos[vid];
    const ch = channelFor(el, info);
    for (const [k, r] of Object.entries(blockedChannels)) {
      if ((ch.id && r.id === ch.id) || (ch.handle && r.handle && r.handle.toLowerCase() === ch.handle.toLowerCase())) {
        delete blockedChannels[k];
      }
    }
    setBlocks(blockedVideos, blockedChannels);
    reevaluateAll();
    await saveBlocks();
  };

  const allowChannel = async (vid, el) => {
    let ch = channelFor(el, cache[vid]);
    if (!ch.id && !ch.handle) ch = channelFor(el, await getInfoNow(vid));
    if (!ch.id && !ch.handle) return;
    const key = ch.id || ch.handle.toLowerCase();
    allowedChannels[key] = { id: ch.id || null, handle: ch.handle || null, name: ch.name || ch.handle || ch.id, addedAt: Date.now() };
    setAllowed(allowedVideos, allowedChannels);
    reevaluateAll();
    await chrome.storage.local.set({ allowedChannels });
    toast(`AI-labeled videos from ${clip(allowedChannels[key].name, 40)} will always show`);
  };

  // ------------------------- search statistics (for the AI videos page; no on-page message)
  const trackSearch = () => {
    const e = pendSearch[searchQuery()];
    if (!e) return;
    e.ai = Math.max(e.ai, pageSeen.size);
    e.blocked = Math.max(e.blocked, pageBlocked.size);
  };

  // ------------------------------------------------------------------ toast
  let toastTimer = null;
  const toast = (msg, undo) => {
    document.getElementById('avf-toast')?.remove();
    clearTimeout(toastTimer);
    const t = document.createElement('div');
    t.id = 'avf-toast';
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    if (undo) {
      const b = document.createElement('button');
      b.textContent = 'Undo';
      b.onclick = async () => { t.remove(); await undo(); };
      t.appendChild(b);
    }
    document.documentElement.appendChild(t);
    toastTimer = setTimeout(() => t.remove(), 6000);
  };

  // ------------------------------------------------- our own small menu
  const ICON_VIDEO = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2a8 8 0 0 1 6.32 12.9L7.1 5.68A7.96 7.96 0 0 1 12 4Zm0 16a8 8 0 0 1-6.32-12.9L16.9 18.32A7.96 7.96 0 0 1 12 20Z"/></svg>';
  const ICON_CHANNEL = '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-6a2 2 0 1 1 0 4 2 2 0 0 1 0-4Zm-8 14c0-3.1 4-5 8-5 .7 0 1.4.06 2.06.17l-1.8 1.85L12 17c-3.2 0-6 1.4-6 3h7v2H4v-2Zm13.6-4L16 17.6l1.4 1.4-1.4 1.4 1.6 1.6 1.4-1.4 1.4 1.4 1.6-1.6-1.4-1.4 1.4-1.4-1.6-1.6-1.4 1.4-1.4-1.4Z"/></svg>';

  const buildItems = (vid, el, onDone) => {
    const frag = document.createElement('div');
    frag.className = 'avf-menu-section';
    frag.dataset.vid = vid;
    const known = channelFor(el, cache[vid]).name;
    const items = [
      { act: 'video', icon: ICON_VIDEO, label: 'Block this video' },
      { act: 'channel', icon: ICON_CHANNEL, label: known ? `Block channel: ${clip(known, 28)}` : 'Block this channel' }
    ];
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'avf-menu-item';
      row.setAttribute('role', 'menuitem');
      row.tabIndex = 0;
      row.innerHTML = it.icon;
      const s = document.createElement('span');
      s.textContent = it.label;
      row.appendChild(s);
      const run = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onDone();
        if (it.act === 'video') blockVideo(vid, el); else blockChannel(vid, el);
      };
      row.addEventListener('click', run);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') run(e); });
      frag.appendChild(row);
    }
    if (!known) {
      getInfoNow(vid).then((info) => {
        const n = channelFor(el, info).name;
        const span = frag.querySelectorAll('.avf-menu-item span')[1];
        if (n && span) span.textContent = `Block channel: ${clip(n, 28)}`;
      });
    }
    return frag;
  };

  // ---------------------------------- 1) items inside YouTube's three-dot menu
  let menuTarget = null;

  const openDropdown = () => {
    for (const d of document.querySelectorAll('tp-yt-iron-dropdown')) {
      if (d.getAttribute('aria-hidden') === 'true') continue;
      if (getComputedStyle(d).display === 'none') continue;
      if (!d.getBoundingClientRect().height) continue;
      return d;
    }
    return null;
  };

  const closeDropdown = (d) => {
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, composed: true };
    d.dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
    setTimeout(() => { if (openDropdown() === d) d.style.display = 'none'; }, 120);
  };

  const injectMenu = () => {
    if (!menuTarget || Date.now() - menuTarget.t > 2500 || !settings.enabled) return;
    const d = openDropdown();
    if (!d) return;
    const list =
      d.querySelector('ytd-menu-popup-renderer tp-yt-paper-listbox') ||
      d.querySelector('yt-list-view-model') ||
      d.querySelector('ytd-menu-popup-renderer') ||
      d.querySelector('yt-sheet-view-model');
    if (!list) return;
    const existing = d.querySelector('.avf-menu-section');
    if (existing && existing.dataset.vid === menuTarget.vid && existing.parentNode === list) return;
    existing?.remove();
    const { vid, el } = menuTarget;
    const section = buildItems(vid, el, () => closeDropdown(d));
    section.classList.add('avf-in-yt-menu');
    list.prepend(section);
  };

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || t.closest('.avf-menu-section, #avf-hover-btn, #avf-mini-menu, #avf-toast')) return;
    let target = null;
    if (t.closest('button, yt-icon-button, [role="button"], ytd-menu-renderer')) {
      const card = t.closest(CONTAINER_SEL);
      if (card) {
        const vid = idOf(card);
        if (vid) target = { vid, el: card };
      } else if (t.closest('ytd-watch-metadata, ytd-reel-video-renderer, ytd-shorts, #movie_player')) {
        const vid = currentWatchId();
        if (vid) target = { vid, el: watchEl() };
      }
    }
    if (target) {
      menuTarget = { ...target, t: Date.now() };
      for (const ms of [40, 120, 250, 500, 900]) setTimeout(injectMenu, ms);
    } else if (!t.closest('tp-yt-iron-dropdown')) {
      menuTarget = null;
      // the popup element is reused for other menus (e.g. account menu): drop our items
      setTimeout(() => document.querySelectorAll('.avf-in-yt-menu').forEach((n) => n.remove()), 0);
    }
  }, true);

  // ------------------------------- 2) small block button on hovered thumbnails
  let hoverCard = null;
  let hoverHideTimer = null;
  let miniMenu = null;

  const hoverBtn = () => {
    let b = document.getElementById('avf-hover-btn');
    if (!b) {
      b = document.createElement('button');
      b.id = 'avf-hover-btn';
      b.title = 'Block video or channel';
      b.innerHTML = ICON_VIDEO;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!hoverCard) return;
        const vid = idOf(hoverCard);
        if (vid) openMiniMenu(vid, hoverCard, b.getBoundingClientRect());
      });
      b.addEventListener('mouseenter', () => clearTimeout(hoverHideTimer));
      b.addEventListener('mouseleave', () => scheduleHoverHide());
      document.documentElement.appendChild(b);
    }
    return b;
  };

  const scheduleHoverHide = () => {
    clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (!miniMenu) { hoverBtn().style.display = 'none'; hoverCard = null; }
    }, 200);
  };

  document.addEventListener('mouseover', (e) => {
    if (!settings.enabled || !settings.hoverButton || !(e.target instanceof Element)) return;
    if (e.target.closest('#avf-hover-btn, #avf-mini-menu')) return;
    const card = e.target.closest(CONTAINER_SEL);
    if (!card || card.hasAttribute('data-avf-block') || !idOf(card)) { if (hoverCard) scheduleHoverHide(); return; }
    clearTimeout(hoverHideTimer);
    if (card === hoverCard && hoverBtn().style.display === 'flex') return;
    hoverCard = card;
    const thumb = card.querySelector('ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, .yt-lockup-view-model__content-image, img') || card;
    const r = thumb.getBoundingClientRect();
    if (r.width < 60 || r.height < 30) return;
    const b = hoverBtn();
    b.style.top = `${Math.max(r.top + 6, 60)}px`;
    b.style.left = `${r.right - 38}px`;
    b.style.display = 'flex';
  }, { passive: true });

  window.addEventListener('scroll', () => {
    if (miniMenu) closeMiniMenu();
    const b = document.getElementById('avf-hover-btn');
    if (b) b.style.display = 'none';
    hoverCard = null;
  }, { passive: true, capture: true });

  const openMiniMenu = (vid, el, rect) => {
    closeMiniMenu();
    miniMenu = document.createElement('div');
    miniMenu.id = 'avf-mini-menu';
    miniMenu.appendChild(buildItems(vid, el, closeMiniMenu));
    document.documentElement.appendChild(miniMenu);
    const w = miniMenu.offsetWidth || 260;
    const h = miniMenu.offsetHeight || 90;
    miniMenu.style.left = `${Math.max(8, Math.min(rect.right - w, innerWidth - w - 8))}px`;
    miniMenu.style.top = `${rect.bottom + 6 + h > innerHeight ? rect.top - h - 6 : rect.bottom + 6}px`;
  };

  function closeMiniMenu() {
    miniMenu?.remove();
    miniMenu = null;
    const b = document.getElementById('avf-hover-btn');
    if (b && !hoverCard) b.style.display = 'none';
  }

  document.addEventListener('mousedown', (e) => {
    if (miniMenu && !(e.target instanceof Element && e.target.closest('#avf-mini-menu, #avf-hover-btn'))) {
      closeMiniMenu();
      scheduleHoverHide();
    }
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && miniMenu) closeMiniMenu(); }, true);

  // ------------------------------------- 3) "Block" button on the watch page
  const injectWatchButton = () => {
    const id = currentWatchId();
    const old = document.querySelector('.avf-watch-btns');
    if (!id || isShortsPage() || !settings.enabled) { old?.remove(); return; }
    const meta = watchEl();
    const owner = meta?.querySelector('#owner');
    if (!owner) return;
    if (old && old.parentNode === owner) return;
    old?.remove();
    const wrap = document.createElement('span');
    wrap.className = 'avf-watch-btns';
    const make = (icon, label, title, action) => {
      const b = document.createElement('button');
      b.className = 'avf-watch-btn';
      b.title = title;
      b.innerHTML = icon;
      const s = document.createElement('span');
      s.textContent = label;
      b.appendChild(s);
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const vid = currentWatchId();
        if (vid) action(vid, watchEl());
      });
      return b;
    };
    wrap.append(
      make(ICON_VIDEO, 'Block video', 'Hide this video everywhere on YouTube', blockVideo),
      make(ICON_CHANNEL, 'Block channel', 'Hide every video from this channel', blockChannel)
    );
    owner.appendChild(wrap);
  };

  // ------------------------------------------------------------ popup / IPC
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'avf:stats') {
      reply({ hiddenHere: pageSeen.size, checked: Object.keys(cache).length });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      const was = settings.enabled;
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      applyRootAttrs();
      updateBadge(true);
      if (!settings.enabled) { removeGuard(); closeMiniMenu(); document.querySelector('.avf-watch-btns')?.remove(); }
      if (!settings.hoverButton) document.getElementById('avf-hover-btn')?.remove();
      if (settings.enabled && !was) { pump(); scheduleScan(); }
    }
    if (changes.allowedVideos || changes.allowedChannels) {
      setAllowed(
        changes.allowedVideos ? changes.allowedVideos.newValue : allowedVideos,
        changes.allowedChannels ? changes.allowedChannels.newValue : allowedChannels
      );
      reevaluateAll();
      handleCurrentVideo();
    }
    if (changes.blockedVideos || changes.blockedChannels) {
      setBlocks(
        changes.blockedVideos ? changes.blockedVideos.newValue : blockedVideos,
        changes.blockedChannels ? changes.blockedChannels.newValue : blockedChannels
      );
      reevaluateAll();
      handleCurrentVideo();
    }
    if (changes.cache2 && changes.cache2.newValue && !Object.keys(changes.cache2.newValue).length) {
      cache = Object.create(null);           // cleared from the popup
      tabSeen.clear();
      pageSeen = new Set();
      updateBadge(true);
      failures.clear();
      reevaluateAll();
    }
  });

  // ------------------------------------------------------------------- boot
  applyRootAttrs();
  load();

  const observer = new MutationObserver(scheduleScan);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    onNavigate();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  document.addEventListener('yt-navigate-finish', onNavigate);
  document.addEventListener('yt-page-data-updated', scheduleScan);
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; onNavigate(); }
    if (Date.now() - badgeSentAt > 5000) updateBadge(true); // the browser can reset it on its own
    scheduleScan();
  }, 1500);

  if (globalThis.__AVF_TEST__) Object.assign(globalThis.__AVF_TEST__, { parseInfo, blockVideo, blockChannel });
})();
