(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let videos = {};
  let channels = {};
  let allowedV = {};
  let allowedC = {};
  let tab = 'channels';
  let toastTimer = null;

  // ---------------------------------------------------------------- storage
  const load = async () => {
    const got = await chrome.storage.local.get(['blockedVideos', 'blockedChannels', 'allowedVideos', 'allowedChannels']);
    videos = got.blockedVideos || {};
    channels = got.blockedChannels || {};
    allowedV = got.allowedVideos || {};
    allowedC = got.allowedChannels || {};
    render();
  };
  const save = () => chrome.storage.local.set({ blockedVideos: videos, blockedChannels: channels,
    allowedVideos: allowedV, allowedChannels: allowedC });

  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.blockedVideos) videos = c.blockedVideos.newValue || {};
    if (c.blockedChannels) channels = c.blockedChannels.newValue || {};
    if (c.allowedVideos) allowedV = c.allowedVideos.newValue || {};
    if (c.allowedChannels) allowedC = c.allowedChannels.newValue || {};
    if (c.blockedVideos || c.blockedChannels || c.allowedVideos || c.allowedChannels) {
      if (editing && document.activeElement?.closest('.note-editor')) return; // don't wipe what you're typing
      render();
    }
  });

  // ---------------------------------------------------------------- helpers
  const fmtDate = (t) => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  const channelUrl = (r) => r.handle ? `https://www.youtube.com/${encodeURIComponent(r.handle).replace('%40', '@')}`
    : r.id ? `https://www.youtube.com/channel/${r.id}` : '#';

  const toast = (msg, undo) => {
    const t = $('toast');
    t.querySelector('span').textContent = msg;
    t.querySelector('button').hidden = !undo;
    t.querySelector('button').onclick = async () => { t.hidden = true; await undo(); };
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    Object.assign(n, props);
    for (const k of kids) if (k != null) n.append(k);
    return n;
  };

  // ----------------------------------------------------------------- render
  const rows = () => {
    const q = $('search').value.trim().toLowerCase();
    let list;
    if (tab === 'allowed') {
      list = [...Object.entries(allowedC).map(([key, r]) => ({ key, kind: 'channel', ...r })),
        ...Object.entries(allowedV).map(([key, r]) => ({ key, kind: 'video', ...r }))];
    } else {
      list = Object.entries(tab === 'channels' ? channels : videos).map(([key, r]) => ({ key, ...r }));
    }
    if (q) {
      list = list.filter((r) => [r.name, r.handle, r.id, r.title, r.channel, r.key, r.note]
        .some((v) => (v || '').toLowerCase().includes(q)));
    }
    const sort = $('sort').value;
    const label = (r) => (r.name || r.title || r.key || '').toLowerCase();
    list.sort(sort === 'az' ? (a, b) => label(a).localeCompare(label(b))
      : sort === 'old' ? (a, b) => (a.addedAt || 0) - (b.addedAt || 0)
        : (a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    return list;
  };

  // ------------------------------------------------- reasons (notes)
  const NOTE_MAX = 500;
  let editing = null; // `${tab}:${key}` of the row whose note is open for editing

  const setNote = async (kind, key, text) => {
    const store = kind === 'channels' ? channels : videos;
    const rec = store[key];
    if (!rec) return;
    const t = (text || '').trim().slice(0, NOTE_MAX);
    if (t) { rec.note = t; rec.noteAt = Date.now(); } else { delete rec.note; delete rec.noteAt; }
    editing = null;
    await save();
    render();
    toast(t ? 'Reason saved' : 'Reason removed');
  };

  const noteBlock = (kind, r) => {
    const id = `${kind}:${r.key}`;
    if (editing === id) {
      const ta = el('textarea', { value: r.note || '', maxLength: NOTE_MAX, rows: 2,
        placeholder: 'Why did you block this? (e.g. AI voice-over, clickbait, spam)' });
      const form = el('form', { className: 'note-editor' }, ta,
        el('div', { className: 'note-actions' },
          el('span', { className: 'note-hint', textContent: 'Enter to save · Shift+Enter for a new line · Esc to cancel' }),
          el('button', { type: 'button', textContent: 'Cancel', onclick: () => { editing = null; render(); } }),
          el('button', { type: 'submit', className: 'primary', textContent: 'Save' })));
      form.onsubmit = (e) => { e.preventDefault(); setNote(kind, r.key, ta.value); };
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
        else if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); }
      };
      return form;
    }
    if (!r.note) return null;
    return el('div', { className: 'note', title: r.noteAt ? `Edited ${fmtDate(r.noteAt)}` : '' }, r.note);
  };

  const noteButton = (kind, r) => el('button', {
    className: 'note-btn', textContent: r.note ? 'Edit reason' : 'Add reason',
    title: r.note ? 'Edit why you blocked this' : 'Write down why you blocked this',
    onclick: () => { editing = `${kind}:${r.key}`; render(); }
  });

  const render = () => {
    $('count-channels').textContent = Object.keys(channels).length;
    $('count-videos').textContent = Object.keys(videos).length;
    $('count-allowed').textContent = Object.keys(allowedC).length + Object.keys(allowedV).length;
    document.querySelectorAll('[role=tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    const list = $('list');
    list.textContent = '';
    const items = rows();
    for (const r of items) {
      let li;
      if (tab === 'allowed') {
        const isCh = r.kind === 'channel';
        const name = isCh ? (r.name || r.handle || r.id) : (r.title || r.key);
        li = el('li', {},
          isCh ? el('div', { className: 'avatar', textContent: (name.replace(/^@/, '')[0] || '?').toUpperCase() })
            : el('img', { className: 'thumb', src: `https://i.ytimg.com/vi/${r.key}/mqdefault.jpg`, alt: '', loading: 'lazy' }),
          el('div', { className: 'info' },
            el('a', { className: 'title', href: isCh ? channelUrl(r) : `https://www.youtube.com/watch?v=${r.key}`, target: '_blank', rel: 'noopener', textContent: name }),
            el('div', { className: 'meta', textContent: [isCh ? 'Channel' : 'Video', r.channel, `Allowed ${fmtDate(r.addedAt)}`].filter(Boolean).join(' · ') })),
          el('button', { textContent: 'Remove', title: 'Hide its AI-labeled videos again', onclick: () => unblock(isCh ? 'allowedC' : 'allowedV', r.key) }));
      } else if (tab === 'channels') {
        const name = r.name || r.handle || r.id;
        li = el('li', {},
          el('div', { className: 'avatar', textContent: (name.replace(/^@/, '')[0] || '?').toUpperCase() }),
          el('div', { className: 'info' },
            el('a', { className: 'title', href: channelUrl(r), target: '_blank', rel: 'noopener', textContent: name }),
            el('div', { className: 'meta', textContent: [r.handle !== name ? r.handle : null, `Blocked ${fmtDate(r.addedAt)}`].filter(Boolean).join(' · ') }),
            noteBlock('channels', r)),
          el('div', { className: 'row-btns' }, noteButton('channels', r),
            el('button', { textContent: 'Unblock', onclick: () => unblock('channels', r.key) })));
      } else {
        li = el('li', {},
          el('img', { className: 'thumb', src: `https://i.ytimg.com/vi/${r.key}/mqdefault.jpg`, alt: '', loading: 'lazy' }),
          el('div', { className: 'info' },
            el('a', { className: 'title', href: `https://www.youtube.com/watch?v=${r.key}`, target: '_blank', rel: 'noopener', textContent: r.title || r.key }),
            el('div', { className: 'meta', textContent: [r.channel, `Blocked ${fmtDate(r.addedAt)}`].filter(Boolean).join(' · ') }),
            noteBlock('videos', r)),
          el('div', { className: 'row-btns' }, noteButton('videos', r),
            el('button', { textContent: 'Unblock', onclick: () => unblock('videos', r.key) })));
      }
      list.append(li);
    }
    const total = tab === 'allowed' ? Object.keys(allowedC).length + Object.keys(allowedV).length
      : Object.keys(tab === 'channels' ? channels : videos).length;
    const ta = list.querySelector('.note-editor textarea');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    $('empty').hidden = items.length > 0;
    $('empty').textContent = total === 0
      ? tab === 'allowed' ? 'Nothing allowed yet. AI-labeled videos you allow (from the “AI videos caught” page, or “Always allow this channel” on YouTube) appear here.'
      : (tab === 'channels'
        ? 'No blocked channels yet. On YouTube, open a video’s ⋮ menu and choose “Block this channel”.'
        : 'No blocked videos yet. On YouTube, open a video’s ⋮ menu and choose “Block this video”.')
      : 'Nothing matches your search.';
    $('unblock-all').disabled = total === 0;
    $('unblock-all').textContent = tab === 'allowed' ? 'Remove all allowed' : 'Unblock all in this tab';
  };

  // ---------------------------------------------------------------- actions
  const unblock = async (kind, key) => {
    const store = { channels, videos, allowedC, allowedV }[kind];
    const rec = store[key];
    delete store[key];
    await save();
    render();
    toast(`${kind.startsWith('allowed') ? 'Removed' : 'Unblocked'} ${rec.name || rec.title || key}`, async () => { store[key] = rec; await save(); render(); });
  };

  $('unblock-all').onclick = async () => {
    const kind = tab;
    const before = { channels: { ...channels }, videos: { ...videos }, allowedC: { ...allowedC }, allowedV: { ...allowedV } };
    const n = kind === 'allowed' ? Object.keys(allowedC).length + Object.keys(allowedV).length
      : Object.keys(before[kind]).length;
    const what = kind === 'allowed' ? 'allowed items' : kind;
    if (!n || !confirm(`${kind === 'allowed' ? 'Remove' : 'Unblock'} all ${n} ${what}?`)) return;
    if (kind === 'channels') channels = {};
    else if (kind === 'videos') videos = {};
    else { allowedC = {}; allowedV = {}; }
    await save();
    render();
    toast(`${kind === 'allowed' ? 'Removed' : 'Unblocked'} ${n} ${what}`, async () => {
      ({ channels, videos, allowedC, allowedV } = before);
      await save(); render();
    });
  };

  document.querySelectorAll('[role=tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; editing = null; render(); }; });
  $('search').oninput = render;
  $('sort').onchange = render;

  // ------------------------------------------------- add by link or handle
  const showMsg = (text, err) => { const m = $('add-msg'); m.textContent = text; m.className = 'msg' + (err ? ' err' : ''); m.hidden = false; };

  const fetchVideoInfo = async (id) => {
    try {
      const r = await fetch('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20260101.00.00' } }, videoId: id })
      });
      const j = await r.json();
      const cs = j?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
      const txt = (t) => t?.simpleText ?? (t?.runs || []).map((x) => x.text).join('');
      const out = {};
      for (const c of cs) {
        if (c.videoPrimaryInfoRenderer) out.title = txt(c.videoPrimaryInfoRenderer.title);
        const o = c.videoSecondaryInfoRenderer?.owner?.videoOwnerRenderer;
        if (o) out.channel = txt(o.title);
      }
      return out;
    } catch (e) { return {}; }
  };

  $('add').onsubmit = async (e) => {
    e.preventDefault();
    const raw = $('add-input').value.trim();
    if (!raw) return;
    const vid = raw.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/)?.[1] ||
      (/^[A-Za-z0-9_-]{11}$/.test(raw) && !raw.startsWith('@') ? raw : null);
    const handle = raw.match(/(?:^|youtube\.com\/)(@[^/?#\s]+)/)?.[1];
    const cid = raw.match(/\/channel\/(UC[\w-]{22})/)?.[1] || (/^UC[\w-]{22}$/.test(raw) ? raw : null);

    const note = $('add-note').value.trim().slice(0, NOTE_MAX);
    const withNote = (rec, prev) => {
      const n = note || prev?.note;
      if (n) { rec.note = n; rec.noteAt = note ? Date.now() : prev.noteAt; }
      return rec;
    };
    if (vid) {
      showMsg('Looking up video…');
      const info = await fetchVideoInfo(vid);
      videos[vid] = withNote({ title: info.title || vid, channel: info.channel || '', addedAt: Date.now() }, videos[vid]);
      tab = 'videos';
      showMsg(`Blocked video: ${info.title || vid}`);
    } else if (handle || cid) {
      const h = handle ? decodeURIComponent(handle) : null;
      const key = cid || h.toLowerCase();
      channels[key] = withNote({ id: cid, handle: h, name: h || cid, addedAt: Date.now() }, channels[key]);
      tab = 'channels';
      showMsg(`Blocked channel: ${h || cid}`);
    } else {
      showMsg('That doesn’t look like a YouTube video link, channel link or @handle.', true);
      return;
    }
    $('add-input').value = '';
    $('add-note').value = '';
    await save();
    render();
  };

  // ------------------------------------------------------- backup / restore
  $('export').onclick = async () => {
    const n = await Backup.exportAll();
    showMsg(`Backup saved: ${n.channels} channels, ${n.videos} videos blocked, ${n.ai} AI videos in the log.`);
  };

  $('import').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      showMsg(Backup.summary(await Backup.importAll(await file.text())));
      await load();
    } catch (err) {
      showMsg('Couldn’t read that file. Use a backup exported from this extension.', true);
    }
  };

  if (['#videos', '#allowed', '#channels'].includes(location.hash)) tab = location.hash.slice(1);
  load();
})();
