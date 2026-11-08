(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEYS = ['aiLog', 'aiDaily', 'searchLog', 'cache2', 'blockedChannels', 'allowedVideos', 'allowedChannels'];
  let D = {};
  let days = 30;
  let shown = 50;
  let toastTimer = null;

  const WHERE = {
    home: 'Home feed', search: 'Search results', watch: 'Sidebar', shorts: 'Shorts',
    subscriptions: 'Subscriptions', channel: 'Channel pages', playlist: 'Playlists',
    opened: 'Opened directly', other: 'Other'
  };

  // ---------------------------------------------------------------- helpers
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'dataset') Object.assign(n.dataset, v); else n[k] = v;
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };
  const svg = (tag, attrs = {}) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const fmt = (n) => (n || 0).toLocaleString();
  const fmtDate = (t) => t ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const url = (id) => `https://www.youtube.com/watch?v=${id}`;
  const chanKey = (e) => e.c || (e.h || '').toLowerCase() || e.n || '?';
  const chanUrl = (e) => e.h ? `https://www.youtube.com/${e.h}` : e.c ? `https://www.youtube.com/channel/${e.c}` : null;
  const dayStr = (d) => d.toLocaleDateString('en-CA');

  const msg = (text, err) => { const m = $('msg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); m.hidden = false; };
  const toast = (text, undo) => {
    const t = $('toast');
    t.querySelector('span').textContent = text;
    const b = t.querySelector('button');
    b.hidden = !undo;
    b.onclick = async () => { t.hidden = true; await undo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  };
  const tip = (e, html) => {
    const t = $('tip');
    if (!html) { t.hidden = true; return; }
    t.innerHTML = html;
    t.hidden = false;
    const w = t.offsetWidth;
    t.style.left = `${Math.min(e.clientX + 12, innerWidth - w - 8)}px`;
    t.style.top = `${e.clientY - 36}px`;
  };

  const isBlockedCh = (e) => Object.values(D.blockedChannels).some((r) =>
    (e.c && r.id === e.c) || (e.h && r.handle && r.handle.toLowerCase() === e.h.toLowerCase()));
  const isAllowedCh = (e) => Object.values(D.allowedChannels).some((r) =>
    (e.c && r.id === e.c) || (e.h && r.handle && r.handle.toLowerCase() === e.h.toLowerCase()));

  // -------------------------------------------------------------------- load
  const load = async () => {
    const got = await chrome.storage.local.get(KEYS);
    D = {
      aiLog: got.aiLog || {}, aiDaily: got.aiDaily || {}, searchLog: got.searchLog || {},
      cache: got.cache2 || {}, blockedChannels: got.blockedChannels || {},
      allowedVideos: got.allowedVideos || {}, allowedChannels: got.allowedChannels || {}
    };
    render();
  };

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local' || !KEYS.some((k) => c[k])) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 400);
  });

  // ------------------------------------------------------------------ tiles
  const renderTiles = () => {
    const log = Object.values(D.aiLog);
    const totalHidden = Object.values(D.aiDaily).reduce((a, b) => a + b, 0);
    const today = new Date();
    let week = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      week += D.aiDaily[dayStr(d)] || 0;
    }
    const chans = new Set(log.map(chanKey));
    const checked = Object.values(D.cache);
    const aiChecked = checked.filter((e) => e.a === 1).length;
    const searches = Object.values(D.searchLog);
    const searchTotal = searches.reduce((a, s) => a + (s.searches || 0), 0);
    const searchAI = searches.filter((s) => s.ai > 0).length;
    const tiles = [
      [fmt(log.length), 'different AI videos caught'],
      [fmt(totalHidden), 'times one was hidden'],
      [fmt(week), 'hidden in the last 7 days'],
      [fmt(chans.size), 'channels posting AI videos'],
      [checked.length ? `${(aiChecked / checked.length * 100).toFixed(1)}%` : '–',
        `of ${fmt(checked.length)} videos checked were AI-labeled`],
      [searches.length ? `${searchAI} / ${searches.length}` : '–',
        `different searches had AI results (${fmt(searchTotal)} searches total)`]
    ];
    $('tiles').replaceChildren(...tiles.map(([v, l]) => el('div', { className: 'tile' }, el('b', { textContent: v }), el('span', { textContent: l }))));
  };

  // ------------------------------------------------------- per-day bar chart
  const niceMax = (m) => {
    if (m <= 4) return 4;
    const p = Math.pow(10, Math.floor(Math.log10(m)));
    for (const s of [1, 2, 2.5, 5, 10]) if (s * p >= m) return s * p;
    return 10 * p;
  };

  const renderDaily = () => {
    const W = 1000, H = 220, L = 34, R = 6, T = 10, B = 26;
    const pts = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      pts.push({ d, v: D.aiDaily[dayStr(d)] || 0 });
    }
    const max = niceMax(Math.max(...pts.map((p) => p.v)));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `AI videos hidden per day, last ${days} days` });
    const y = (v) => T + (H - T - B) * (1 - v / max);
    for (let i = 0; i <= 4; i++) {
      const v = max * i / 4;
      s.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      const t = svg('text', { class: 'axis', x: L - 6, y: y(v) + 4, 'text-anchor': 'end' });
      t.textContent = Number.isInteger(v) ? v : v.toFixed(1);
      s.append(t);
    }
    const slot = (W - L - R) / pts.length;
    const bw = Math.max(2, slot - 2);           // 2px gap between bars
    const every = days <= 14 ? 2 : days <= 30 ? 5 : 14;
    pts.forEach((p, i) => {
      const x = L + i * slot + (slot - bw) / 2;
      const g = svg('g');
      if (p.v > 0) {
        const top = y(p.v), base = y(0), r = Math.min(4, bw / 2, base - top);
        g.append(svg('path', {
          class: 'bar',
          d: `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z`
        }));
      }
      const hit = svg('rect', { class: 'hit', x: L + i * slot, y: T, width: slot, height: H - T - B });
      const label = p.d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      hit.addEventListener('mousemove', (e) => tip(e, `${label}: <b>${p.v}</b> hidden`));
      hit.addEventListener('mouseleave', (e) => tip(e, null));
      g.append(hit);
      s.append(g);
      if ((pts.length - 1 - i) % every === 0) {
        const t = svg('text', { class: 'axis', x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' });
        t.textContent = p.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        s.append(t);
      }
    });
    if (pts.every((p) => !p.v)) {
      const t = svg('text', { class: 'empty-chart', x: W / 2, y: H / 2, 'text-anchor': 'middle' });
      t.textContent = 'Nothing hidden in this period yet';
      s.append(t);
    }
    $('daily').replaceChildren(s);
  };

  // ------------------------------------------------------------------ where
  const renderWhere = () => {
    const sums = {};
    for (const e of Object.values(D.aiLog)) {
      for (const [w, n] of Object.entries(e.where || {})) sums[w] = (sums[w] || 0) + n;
    }
    const rows = Object.entries(sums).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...rows.map((r) => r[1]));
    $('where').replaceChildren(...(rows.length ? rows.map(([w, n]) => {
      const row = el('div', { className: 'hbar' },
        el('span', { className: 'lbl', textContent: WHERE[w] || w }),
        el('div', { className: 'track' }, el('div', { className: 'fill', style: `width:${n / max * 100}%` })),
        el('span', { className: 'val', textContent: fmt(n) }));
      row.addEventListener('mousemove', (e) => tip(e, `${WHERE[w] || w}: <b>${fmt(n)}</b> hidden`));
      row.addEventListener('mouseleave', (e) => tip(e, null));
      return row;
    }) : [el('p', { className: 'empty', textContent: 'No data yet.' })]));
  };

  // --------------------------------------------------------------- channels
  const channelGroups = () => {
    const g = new Map();
    for (const [id, e] of Object.entries(D.aiLog)) {
      const k = chanKey(e);
      if (!g.has(k)) g.set(k, { key: k, n: e.n || e.h || 'Unknown channel', c: e.c, h: e.h, videos: 0, seen: 0 });
      const x = g.get(k);
      x.videos++;
      x.seen += e.seen || 0;
      if (!x.c && e.c) x.c = e.c;
      if (!x.h && e.h) x.h = e.h;
    }
    return [...g.values()].sort((a, b) => b.videos - a.videos || b.seen - a.seen);
  };

  const renderChannels = (groups) => {
    const top = groups.slice(0, 10);
    $('channels').replaceChildren(...(top.length ? top.map((x) => {
      const link = chanUrl(x);
      const status = isBlockedCh(x) ? el('span', { className: 'tag', textContent: 'Blocked' })
        : isAllowedCh(x) ? el('span', { className: 'tag', textContent: 'Allowed' })
          : el('button', { textContent: 'Block', title: 'Block this channel completely', onclick: () => blockChannel(x) });
      return el('li', {},
        el('a', { className: 'nm', textContent: x.n, href: '#', title: 'Show only this channel’s videos below',
          onclick: (e) => { e.preventDefault(); $('chan-filter').value = x.key; shown = 50; renderVideos(); $('q').scrollIntoView({ behavior: 'smooth', block: 'center' }); } }),
        el('span', { className: 'ct', textContent: `${x.videos} video${x.videos === 1 ? '' : 's'}` }),
        link ? el('a', { href: link, target: '_blank', rel: 'noopener', className: 'tag', textContent: 'Open' }) : null,
        status);
    }) : [el('p', { className: 'empty', textContent: 'No data yet.' })]));

    const sel = $('chan-filter');
    const cur = sel.value;
    sel.replaceChildren(el('option', { value: '', textContent: 'All channels' }),
      ...groups.map((x) => el('option', { value: x.key, textContent: `${x.n} (${x.videos})` })));
    sel.value = groups.some((x) => x.key === cur) ? cur : '';
  };

  // --------------------------------------------------------------- searches
  const renderSearches = () => {
    const rows = Object.entries(D.searchLog)
      .filter(([, s]) => s.ai > 0)
      .sort((a, b) => b[1].ai - a[1].ai || (b[1].last || 0) - (a[1].last || 0))
      .slice(0, 15);
    const total = Object.keys(D.searchLog).length;
    $('search-note').textContent = total ? `${rows.length ? 'Top ' + rows.length + ' of ' : ''}${total} different searches tracked` : '';
    $('searches').tBodies[0].replaceChildren(...(rows.length ? rows.map(([q, s]) => el('tr', {},
      el('td', {}, el('a', { className: 'chan-link', href: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, target: '_blank', rel: 'noopener', textContent: q })),
      el('td', { className: 'num', textContent: fmt(s.searches) }),
      el('td', { className: 'num', textContent: fmt(s.ai) }),
      el('td', { className: 'num', textContent: fmt(s.blocked || 0) }),
      el('td', { textContent: fmtDate(s.last) })))
      : [el('tr', {}, el('td', { colSpan: 5, className: 'empty', textContent: 'No searches with AI results yet.' }))]));
  };

  // ----------------------------------------------------------------- videos
  const filteredVideos = () => {
    const q = $('q').value.trim().toLowerCase();
    const ch = $('chan-filter').value;
    let list = Object.entries(D.aiLog).map(([id, e]) => ({ id, ...e }));
    if (ch) list = list.filter((e) => chanKey(e) === ch);
    if (q) list = list.filter((e) => [e.t, e.n, e.h, e.id, url(e.id), ...(e.q || [])].some((v) => (v || '').toLowerCase().includes(q)));
    const s = $('sort').value;
    list.sort(s === 'seen' ? (a, b) => (b.seen || 0) - (a.seen || 0)
      : s === 'first' ? (a, b) => (a.first || 0) - (b.first || 0)
        : s === 'title' ? (a, b) => (a.t || '').localeCompare(b.t || '')
          : (a, b) => (b.last || 0) - (a.last || 0));
    return list;
  };

  const renderVideos = () => {
    const list = filteredVideos();
    $('vid-count').textContent = fmt(list.length);
    const rows = list.slice(0, shown).map((e) => {
      const allowed = !!D.allowedVideos[e.id] || isAllowedCh(e);
      const blocked = isBlockedCh(e);
      const where = Object.entries(e.where || {}).sort((a, b) => b[1] - a[1])
        .map(([w, n]) => el('span', { className: 'chip', textContent: `${WHERE[w] || w} ${n > 1 ? '×' + n : ''}`.trim() }));
      const copyBtn = el('button', { textContent: 'Copy', title: 'Copy URL' });
      copyBtn.onclick = async () => { await navigator.clipboard.writeText(url(e.id)); copyBtn.textContent = 'Copied'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1200); };
      return el('tr', {},
        el('td', {}, el('img', { src: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`, alt: '', loading: 'lazy', onerror() { this.style.visibility = 'hidden'; } })),
        el('td', {},
          el('a', { className: 'ttl', href: url(e.id), target: '_blank', rel: 'noopener', textContent: e.t || '(title unavailable)', title: e.t || '' }),
          el('div', { className: 'url' }, el('code', { textContent: `youtube.com/watch?v=${e.id}`, title: url(e.id) }), copyBtn),
          e.q?.length ? el('div', {}, ...e.q.slice(0, 3).map((q) => el('span', { className: 'chip', textContent: `🔍 ${q}` }))) : null),
        el('td', {}, el('a', { className: 'chan-link', textContent: e.n || e.h || '—', href: '#',
          onclick: (ev) => { ev.preventDefault(); $('chan-filter').value = chanKey(e); shown = 50; renderVideos(); } })),
        el('td', { className: 'num', textContent: fmt(e.seen) }),
        el('td', {}, ...where),
        el('td', { className: 'nowrap', textContent: fmtDate(e.first) }),
        el('td', { className: 'actions' },
          allowed ? el('span', { className: 'tag', textContent: 'Allowed' })
            : el('button', { textContent: 'Allow', title: 'Always show this video, even though it’s AI-labeled', onclick: () => allowVideo(e) }),
          blocked ? el('span', { className: 'tag', textContent: 'Channel blocked' })
            : el('button', { textContent: 'Block channel', onclick: () => blockChannel(e) })));
    });
    $('videos').replaceChildren(...rows);
    const total = Object.keys(D.aiLog).length;
    $('vid-empty').hidden = list.length > 0;
    $('vid-empty').textContent = total ? 'Nothing matches.' : 'No AI videos caught yet. Browse YouTube and they’ll show up here.';
    $('more').hidden = list.length <= shown;
    $('more').textContent = `Show more (${fmt(list.length - shown)} left)`;
  };

  const render = () => {
    renderTiles();
    renderDaily();
    renderWhere();
    renderChannels(channelGroups());
    renderSearches();
    renderVideos();
  };

  // ---------------------------------------------------------------- actions
  const blockChannel = async (e) => {
    const key = e.c || (e.h || '').toLowerCase();
    if (!key) { toast('Can’t identify this channel.'); return; }
    const got = await chrome.storage.local.get('blockedChannels');
    const bc = got.blockedChannels || {};
    bc[key] = { id: e.c || null, handle: e.h || null, name: e.n || e.h || e.c, addedAt: Date.now() };
    await chrome.storage.local.set({ blockedChannels: bc });
    toast(`Blocked channel ${bc[key].name}`, async () => {
      const g = await chrome.storage.local.get('blockedChannels');
      const b = g.blockedChannels || {};
      delete b[key];
      await chrome.storage.local.set({ blockedChannels: b });
    });
  };

  const allowVideo = async (e) => {
    const got = await chrome.storage.local.get('allowedVideos');
    const av = got.allowedVideos || {};
    av[e.id] = { title: e.t || e.id, channel: e.n || '', addedAt: Date.now() };
    await chrome.storage.local.set({ allowedVideos: av });
    toast(`“${(e.t || e.id).slice(0, 50)}” will always show`, async () => {
      const g = await chrome.storage.local.get('allowedVideos');
      const a = g.allowedVideos || {};
      delete a[e.id];
      await chrome.storage.local.set({ allowedVideos: a });
    });
  };

  $('range').onclick = (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    days = +b.dataset.days;
    $('range').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
    renderDaily();
  };
  $('q').oninput = () => { shown = 50; renderVideos(); };
  $('chan-filter').onchange = () => { shown = 50; renderVideos(); };
  $('sort').onchange = renderVideos;
  $('more').onclick = () => { shown += 100; renderVideos(); };

  $('copy-urls').onclick = async () => {
    const list = filteredVideos();
    await navigator.clipboard.writeText(list.map((e) => url(e.id)).join('\n'));
    msg(`Copied ${list.length} URL${list.length === 1 ? '' : 's'}${list.length !== Object.keys(D.aiLog).length ? ' (matching your filter)' : ''}.`);
  };

  $('csv').onclick = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['url', 'title', 'channel', 'channel_url', 'first_seen', 'last_seen', 'times_hidden', 'where', 'searches']];
    for (const e of filteredVideos()) {
      rows.push([url(e.id), e.t, e.n, chanUrl(e), e.first ? new Date(e.first).toISOString() : '',
        e.last ? new Date(e.last).toISOString() : '', e.seen,
        Object.entries(e.where || {}).map(([w, n]) => `${WHERE[w] || w}: ${n}`).join('; '), (e.q || []).join('; ')]);
    }
    const blob = new Blob(['﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `ai-videos-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  $('export').onclick = async () => {
    const n = await Backup.exportAll();
    msg(`Backup saved: ${n.channels} channels, ${n.videos} videos blocked, ${n.ai} AI videos in the log.`);
  };
  $('import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      msg(Backup.summary(await Backup.importAll(await file.text())));
      await load();
    } catch (err) {
      msg('Couldn’t read that file. Use a backup exported from this extension.', true);
    }
  };

  $('clear').onclick = async () => {
    if (!confirm('Clear the AI videos log and statistics? Your blocked and allowed lists are kept.')) return;
    const before = await chrome.storage.local.get(['aiLog', 'aiDaily', 'searchLog']);
    await chrome.storage.local.set({ aiLog: {}, aiDaily: {}, searchLog: {} });
    toast('Log cleared', async () => { await chrome.storage.local.set(before); });
  };

  load();
})();
