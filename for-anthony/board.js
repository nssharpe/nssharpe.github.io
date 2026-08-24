/* For Anthony — shared board core.
 *
 * Storage: Firebase Realtime Database over plain REST (no SDK, no accounts for contributors).
 *  - Notes live at   <DB>/board/notes/<id>.json   (one record per note; deletes are tombstone
 *    records {id, del:1, mod} so they replicate and never resurrect).
 *  - Uploaded images (compressed on-device to data URIs) live at <DB>/board/imgs/<imgId>.json,
 *    write-once, fetched lazily and cached.
 *  - Durability: a scheduled GitHub Action snapshots the database into data/snapshot.json and
 *    data/images.json in this repo; pages fall back to those if the database is unreachable.
 *  - Self-heal: each contributor's own notes/images are mirrored in their localStorage and
 *    quietly re-published if the shared view is ever missing them.
 * Conflict rule: last-write-wins per note id by `mod` timestamp.
 */
'use strict';

const FA = (() => {
  const CONFIG = {
    DB: 'https://ucg-for-anthony-default-rtdb.firebaseio.com',
    SNAPSHOT_URL: 'data/snapshot.json',  // committed fallback: { notes: {id: note} }
    IMAGES_URL: 'data/images.json',      // committed fallback: { imgs: {id: dataUri} }
    BOARD_W: 2200,
    BOARD_MIN_H: 1500,
    POLL_MS: 25000,
  };

  const FONTS = {
    caveat:  { label: 'Handwritten', css: "'Caveat', cursive",          size: 27 },
    kalam:   { label: 'Marker',      css: "'Kalam', cursive",           size: 19 },
    dancing: { label: 'Script',      css: "'Dancing Script', cursive",  size: 24 },
    lora:    { label: 'Serif',       css: "'Lora', Georgia, serif",     size: 17 },
    nunito:  { label: 'Simple',      css: "'Nunito', sans-serif",       size: 17 },
  };

  const COLORS = {
    ivory: '#fffcf3',
    blush: '#f9e8e2',
    sage:  '#e9efe1',
    mist:  '#e3edf2',
    sand:  '#f7eed7',
    lilac: '#ede8f4',
  };

  const BOARD_BG = '#ece3cf';

  /* ---------------- local (per-device) persistence ---------------- */

  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  const MINE_KEY = 'fa_mine_v3';   // id -> note (mirror of my notes, latest saved version)
  const IMGS_KEY = 'fa_imgs_v3';   // imgId -> data URI (my uploads)
  const NAME_KEY = 'fa_name_v1';

  const getMine = () => store.get(MINE_KEY, {});
  const setMine = m => store.set(MINE_KEY, m);
  const rememberMine = n => { const m = getMine(); m[n.id] = n; setMine(m); };
  const forgetMine = id => { const m = getMine(); delete m[id]; setMine(m); };
  const isMine = id => !!getMine()[id];

  const getMyImages = () => store.get(IMGS_KEY, {});
  const rememberImage = (id, dataUri) => { const m = getMyImages(); m[id] = dataUri; store.set(IMGS_KEY, m); };

  const getSavedName = () => store.get(NAME_KEY, '');
  const setSavedName = n => store.set(NAME_KEY, n);

  /* ---------------- validation ---------------- */

  const clamp = (v, lo, hi, dflt) => {
    v = Number(v);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
  };

  // Returns a clean note, a tombstone {id, del:1, mod}, or null.
  function sanitizeNote(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
    const id = raw.id.slice(0, 48);
    const mod = clamp(raw.mod, 0, 9e12, 0);
    if (raw.del) return { id, del: 1, mod };
    const n = {
      id,
      text: typeof raw.text === 'string' ? raw.text.slice(0, 600) : '',
      name: typeof raw.name === 'string' ? raw.name.slice(0, 60) : '',
      font: FONTS[raw.font] ? raw.font : 'caveat',
      color: COLORS[raw.color] ? raw.color : 'ivory',
      x: clamp(raw.x, -200, CONFIG.BOARD_W, 100),
      y: clamp(raw.y, 0, 12000, 100),
      w: clamp(raw.w, 180, 420, 260),
      fs: clamp(raw.fs, 0.75, 1.6, 1),
      rot: clamp(raw.rot, -15, 15, 0),
      z: clamp(raw.z, 0, 100000, 0),
      created: clamp(raw.created, 0, 9e12, 0),
      mod,
      img: null,
    };
    const img = raw.img;
    if (img && typeof img === 'object') {
      if (img.type === 'url' && typeof img.src === 'string' && /^https:\/\//i.test(img.src) && img.src.length < 2000) {
        n.img = { type: 'url', src: img.src };
      } else if (img.type === 'up' && typeof img.id === 'string') {
        n.img = { type: 'up', id: img.id.slice(0, 48) };
      }
    }
    if (!n.text && !n.img) return null;
    return n;
  }

  const isImageDataUri = s => typeof s === 'string' && /^data:image\//.test(s) && s.length < 900000;

  /* ---------------- remote io ---------------- */

  const configured = () => !CONFIG.DB.includes('__FIREBASE');
  const dbUrl = path => CONFIG.DB.replace(/\/+$/, '') + '/board/' + path + '.json';

  async function dbGet(path) {
    const res = await fetch(dbUrl(path), { cache: 'no-store' });
    if (!res.ok) throw new Error('db get ' + res.status);
    return res.json();
  }

  async function dbPut(path, value) {
    const res = await fetch(dbUrl(path), { method: 'PUT', body: JSON.stringify(value) });
    if (!res.ok) {
      const err = new Error('db put ' + res.status);
      err.status = res.status;
      throw err;
    }
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch ' + res.status);
    return res.json();
  }

  /* ---------------- board store (shared by both pages) ---------------- */

  function createStore() {
    const notes = new Map();      // id -> note (live, no tombstones)
    const deleted = new Map();    // id -> mod  (tombstones)
    const images = new Map();     // imgId -> data URI
    const remoteMods = new Map(); // id -> newest mod seen from the shared side (for heal)
    const fetchingImgs = new Set();
    let imagesFallbackTried = false;
    let changeCb = null;
    let statusCb = null;
    let source = 'none';
    const outbox = [];            // [{path, value}] awaiting (re)send
    let flushing = false;

    function notify() { if (changeCb) changeCb(); }
    function status(s) { if (statusCb) statusCb(s); }

    function applyRecord(raw, fromRemote) {
      const n = sanitizeNote(raw);
      if (!n) return false;
      if (fromRemote) {
        const prev = remoteMods.get(n.id) || 0;
        if (n.mod > prev) remoteMods.set(n.id, n.mod);
      }
      if (n.del) {
        const prev = deleted.get(n.id) || 0;
        if (n.mod <= prev && deleted.has(n.id)) return false;
        deleted.set(n.id, Math.max(prev, n.mod));
        return notes.delete(n.id) || prev === 0;
      }
      if (deleted.has(n.id)) return false;
      const cur = notes.get(n.id);
      if (cur && (cur.mod || 0) >= n.mod) return false;
      notes.set(n.id, n);
      return true;
    }

    function applyNotesObject(obj, fromRemote) {
      let changed = false;
      if (obj && typeof obj === 'object') {
        for (const raw of Object.values(obj)) {
          if (applyRecord(raw, fromRemote)) changed = true;
        }
      }
      return changed;
    }

    // my localStorage mirrors, folded in last (they win ties for my own notes)
    function applyMirrors() {
      let changed = false;
      for (const [id, uri] of Object.entries(getMyImages())) {
        if (!images.has(id) && isImageDataUri(uri)) { images.set(id, uri); changed = true; }
      }
      for (const n of Object.values(getMine())) {
        if (applyRecord(n, false)) changed = true;
        else {
          const cur = notes.get(n.id);
          if (cur && (cur.mod || 0) > (n.mod || 0)) rememberMine(cur); // adopt newer remote edit
          if (deleted.has(n.id)) forgetMine(n.id);
        }
      }
      return changed;
    }

    // re-publish anything of mine the shared side is missing or has stale
    function heal() {
      if (!configured() || source !== 'live') return;
      const myImgs = getMyImages();
      for (const n of Object.values(getMine())) {
        if (deleted.has(n.id) && !n.del) continue;
        if ((remoteMods.get(n.id) || 0) < (n.mod || 0)) {
          enqueue('notes/' + n.id, n);
        }
        if (n.img && n.img.type === 'up' && myImgs[n.img.id]) {
          ensureImagePublished(n.img.id, myImgs[n.img.id]);
        }
      }
      flush();
    }

    const checkedImgs = new Set();
    async function ensureImagePublished(imgId, dataUri) {
      if (checkedImgs.has(imgId)) return;
      checkedImgs.add(imgId);
      try {
        const existing = await dbGet('imgs/' + imgId);
        if (existing == null) { enqueue('imgs/' + imgId, dataUri); flush(); }
      } catch { /* offline; next heal retries */ checkedImgs.delete(imgId); }
    }

    /* ---- outbox ---- */

    function enqueue(path, value) {
      const i = outbox.findIndex(o => o.path === path);
      if (i >= 0) outbox[i] = { path, value };
      else outbox.push({ path, value });
    }

    async function flush() {
      if (flushing || !outbox.length || !configured()) return;
      flushing = true;
      status('saving');
      try {
        while (outbox.length) {
          const { path, value } = outbox[0];
          try {
            await dbPut(path, value);
            outbox.shift();
          } catch (e) {
            // write-once images: a 4xx here means it already exists — treat as done
            if (path.startsWith('imgs/') && e.status && e.status < 500) { outbox.shift(); continue; }
            status('offline');
            setTimeout(flush, 15000);
            flushing = false;
            return;
          }
        }
        status('saved');
      } finally { flushing = false; }
    }

    function fetchImage(imgId) {
      if (fetchingImgs.has(imgId)) return;
      fetchingImgs.add(imgId);
      (async () => {
        if (configured()) {
          try {
            const uri = await dbGet('imgs/' + imgId);
            if (isImageDataUri(uri)) { images.set(imgId, uri); notify(); return; }
          } catch { /* fall through */ }
        }
        if (!imagesFallbackTried) {
          imagesFallbackTried = true;
          try {
            const snap = await fetchJson(CONFIG.IMAGES_URL);
            let found = false;
            if (snap && snap.imgs && typeof snap.imgs === 'object') {
              for (const [id, uri] of Object.entries(snap.imgs)) {
                if (isImageDataUri(uri) && !images.has(id)) { images.set(id, uri); found = true; }
              }
            }
            if (found) notify();
          } catch { /* nothing more to try */ }
        }
      })().finally(() => fetchingImgs.delete(imgId));
    }

    /* ---- public api ---- */

    const api = {
      get notes() { return [...notes.values()]; },
      getNote(id) { return notes.get(id); },
      onChange(cb) { changeCb = cb; },
      onStatus(cb) { statusCb = cb; },
      get source() { return source; },
      get pendingCount() { return outbox.length; },

      imageSrc(imgRef) {
        if (!imgRef) return null;
        if (imgRef.type === 'url') return imgRef.src;
        if (imgRef.type === 'up') {
          const uri = images.get(imgRef.id);
          if (uri) return uri;
          fetchImage(imgRef.id);
          return null;
        }
        return null;
      },

      async init() {
        try {
          const snap = await fetchJson(CONFIG.SNAPSHOT_URL);
          if (snap && snap.notes) { applyNotesObject(snap.notes, true); source = 'snapshot'; }
        } catch { /* fine on first deploy */ }
        if (configured()) {
          try {
            const live = await dbGet('notes');
            applyNotesObject(live, true);
            source = 'live';
          } catch { /* offline — snapshot/mirrors only */ }
        }
        applyMirrors();
        heal();
        notify();
      },

      async poll() {
        if (!configured()) return;
        try {
          const live = await dbGet('notes');
          const changed = applyNotesObject(live, true);
          if (source !== 'live') { source = 'live'; heal(); }
          if (changed) { applyMirrors(); notify(); }
        } catch { /* keep the last good view */ }
      },

      putNote(note) {
        note = { ...note, mod: Date.now() };
        const clean = sanitizeNote(note);
        if (!clean || clean.del) return;
        notes.set(clean.id, clean);
        rememberMine(clean);
        enqueue('notes/' + clean.id, clean);
        flush();
        notify();
      },

      deleteNote(id) {
        const tomb = { id, del: 1, mod: Date.now() };
        deleted.set(id, tomb.mod);
        notes.delete(id);
        rememberMine(tomb);   // mirror the tombstone so heal re-publishes it if lost
        enqueue('notes/' + id, tomb);
        flush();
        notify();
      },

      // Store an uploaded image; returns the imgRef to put on the note.
      addImage(dataUri) {
        const imgId = 'img_' + Math.random().toString(36).slice(2, 12);
        rememberImage(imgId, dataUri);
        images.set(imgId, dataUri);
        checkedImgs.add(imgId);
        enqueue('imgs/' + imgId, dataUri);
        flush();
        return { type: 'up', id: imgId };
      },

      maxZ() {
        let m = 0;
        for (const n of notes.values()) m = Math.max(m, n.z || 0);
        return m;
      },
    };
    return api;
  }

  /* ---------------- note factory ---------------- */

  function newId() {
    if (window.crypto && crypto.randomUUID) return 'n_' + crypto.randomUUID().slice(0, 13);
    return 'n_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  }

  function createNote(boardStore, fields) {
    const w = 260;
    return {
      id: newId(),
      text: fields.text || '',
      name: fields.name || '',
      font: FONTS[fields.font] ? fields.font : 'caveat',
      color: COLORS[fields.color] ? fields.color : 'ivory',
      img: fields.img || null,
      x: Math.round(CONFIG.BOARD_W / 2 - w / 2 + (Math.random() * 700 - 350)),
      y: Math.round(430 + Math.random() * 520),
      w,
      fs: 1,
      rot: Math.round(Math.random() * 12 - 6),
      z: boardStore.maxZ() + 1,
      created: Date.now(),
      mod: Date.now(),
    };
  }

  /* ---------------- rendering ---------------- */

  function boardHeight(notes) {
    let bottom = 0;
    for (const n of notes) bottom = Math.max(bottom, (n.y || 0) + 520);
    return Math.max(CONFIG.BOARD_MIN_H, bottom);
  }

  function buildPlaque() {
    const el = document.createElement('div');
    el.className = 'plaque';
    el.innerHTML =
      '<img class="plaque-mark" src="assets/ucg-mark.svg" alt="">' +
      '<div class="kicker">With sympathy · from your UCG family</div>' +
      '<h2>Anthony,</h2>' +
      '<p>We’re so sorry for your loss, and just wanted you to know that we’re thinking of you.</p>' +
      '<div class="rule"></div>' +
      '<img class="plaque-logotype" src="assets/ucg-logotype.svg" alt="UCG — United Club Gymnastics">';
    return el;
  }

  function applyNoteStyle(el, n) {
    const font = FONTS[n.font] || FONTS.caveat;
    el.style.left = (n.x || 0) + 'px';
    el.style.top = (n.y || 0) + 'px';
    el.style.width = (n.w || 260) + 'px';
    el.style.transform = 'rotate(' + (n.rot || 0) + 'deg)';
    el.style.zIndex = String(10 + (n.z || 0));
    el.style.background = COLORS[n.color] || COLORS.ivory;
    const text = el.querySelector('.note-text');
    if (text) {
      text.style.fontFamily = font.css;
      text.style.fontSize = Math.round(font.size * (n.fs || 1)) + 'px';
    }
  }

  function fillNoteContent(el, n, opts) {
    el.innerHTML = '';
    el.classList.remove('export-missing-img');
    const tape = document.createElement('div');
    tape.className = 'tape';
    el.appendChild(tape);

    if (n.img) {
      const src = opts.imageSrc ? opts.imageSrc(n.img) : (n.img.src || null);
      const blocked = opts.blockedImages && src && opts.blockedImages.has(src);
      if (src && !blocked) {
        const img = document.createElement('img');
        img.alt = '';
        img.draggable = false;
        img.src = src;
        el.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'img-placeholder';
        ph.textContent = blocked ? '[ image ]' : 'photo on its way…';
        el.classList.add('export-missing-img');
        el.appendChild(ph);
      }
    }

    const t = document.createElement('div');
    t.className = 'note-text';
    if (n.text) t.textContent = n.text;
    el.appendChild(t);

    if (n.name) {
      const nm = document.createElement('div');
      nm.className = 'note-name';
      nm.textContent = '— ' + n.name;
      el.appendChild(nm);
    }
  }

  // Keyed reconcile so re-renders don't destroy in-progress interactions.
  function renderBoard(boardEl, notesList, opts) {
    opts = opts || {};
    boardEl.style.width = CONFIG.BOARD_W + 'px';
    boardEl.style.height = boardHeight(notesList) + 'px';

    if (!boardEl.querySelector('.plaque')) boardEl.appendChild(buildPlaque());

    const seen = new Set();
    for (const n of notesList) {
      seen.add(n.id);
      let el = boardEl.querySelector('.note[data-id="' + n.id + '"]');
      const src = n.img && opts.imageSrc ? opts.imageSrc(n.img) : null;
      const stamp = String(n.mod || 0) + (n.img ? (src ? ':i' : ':p') : '');
      if (!el) {
        el = document.createElement('div');
        el.className = 'note';
        el.dataset.id = n.id;
        el.dataset.stamp = '';
        boardEl.appendChild(el);
      }
      if (el.dataset.stamp !== stamp) {
        fillNoteContent(el, n, opts);
        el.dataset.stamp = stamp;
      }
      applyNoteStyle(el, n);
      const mine = opts.canEdit ? opts.canEdit(n.id) : false;
      el.classList.toggle('mine', !!mine);
    }
    for (const el of [...boardEl.querySelectorAll('.note')]) {
      if (!seen.has(el.dataset.id)) el.remove();
    }
  }

  /* ---------------- viewport (fit / zoom) ---------------- */

  function initViewport(scrollEl, stageEl, boardEl) {
    let scale = 1;

    function apply() {
      const w = CONFIG.BOARD_W;
      const h = boardEl.offsetHeight || CONFIG.BOARD_MIN_H;
      stageEl.style.width = Math.round(w * scale) + 'px';
      stageEl.style.height = Math.round(h * scale) + 'px';
      boardEl.style.transform = 'scale(' + scale + ')';
    }

    function fit() {
      const w = scrollEl.clientWidth;
      scale = Math.min(1, w / CONFIG.BOARD_W);
      // On phones, fit-to-width makes notes unreadably small; zoom in and let touch panning do the rest.
      if (w < 700) scale = Math.max(scale, 0.4);
      scale = Math.max(scale, 0.12);
      apply();
      scrollEl.scrollLeft = Math.max(0, (CONFIG.BOARD_W * scale - w) / 2);
      scrollEl.scrollTop = 0;
    }

    function zoom(factor) {
      const prev = scale;
      scale = Math.min(2, Math.max(0.12, scale * factor));
      const cx = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
      const cy = scrollEl.scrollTop + scrollEl.clientHeight / 2;
      apply();
      scrollEl.scrollLeft = cx * (scale / prev) - scrollEl.clientWidth / 2;
      scrollEl.scrollTop = cy * (scale / prev) - scrollEl.clientHeight / 2;
    }

    window.addEventListener('resize', apply);
    return { fit, zoom, apply, get scale() { return scale; } };
  }

  /* ---------------- export (gift view) ---------------- */

  async function preloadForExport(notesList, imageSrc) {
    const failed = new Set();
    const jobs = [];
    for (const n of notesList) {
      if (!n.img || n.img.type !== 'url') continue;
      const src = imageSrc(n.img);
      if (!src) continue;
      jobs.push(new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const timer = setTimeout(() => { failed.add(src); resolve(); }, 12000);
        img.onload = () => { clearTimeout(timer); resolve(); };
        img.onerror = () => { clearTimeout(timer); failed.add(src); resolve(); };
        img.src = src;
      }));
    }
    await Promise.all(jobs);
    return failed;
  }

  async function exportCanvas(notesList, imageSrc, onStatus) {
    if (typeof html2canvas !== 'function') throw new Error('html2canvas missing');
    if (onStatus) onStatus('Preparing images…');
    await document.fonts.ready;
    const blocked = await preloadForExport(notesList, imageSrc);

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-100000px;top:0;';
    const board = document.createElement('div');
    board.className = 'board';
    board.style.position = 'relative';
    holder.appendChild(board);
    document.body.appendChild(holder);

    renderBoard(board, notesList, { imageSrc, blockedImages: blocked });
    for (const img of board.querySelectorAll('.note img')) {
      if (/^https:/.test(img.src)) img.crossOrigin = 'anonymous';
    }

    if (onStatus) onStatus('Rendering the board…');
    try {
      const canvas = await html2canvas(board, {
        scale: 2,
        backgroundColor: BOARD_BG,
        useCORS: true,
        logging: false,
      });
      return { canvas, failedImages: blocked.size };
    } finally {
      holder.remove();
    }
  }

  return {
    CONFIG, FONTS, COLORS, BOARD_BG,
    isMine, getSavedName, setSavedName,
    configured, createStore, createNote,
    renderBoard, initViewport, exportCanvas,
  };
})();
