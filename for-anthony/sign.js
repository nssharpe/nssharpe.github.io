/* For Anthony — contribute page: add/edit notes, drag, sliders, live sync. */
'use strict';

(() => {
  const ADMIN = location.hash === '#admin';

  const boardEl = document.getElementById('board');
  const scrollEl = document.querySelector('.board-scroll');
  const stageEl = document.querySelector('.board-stage');
  const banner = document.getElementById('state-banner');
  const toastEl = document.getElementById('toast');
  const controls = document.getElementById('note-controls');

  const bstore = FA.createStore();
  let selectedId = null;

  const viewport = FA.initViewport(scrollEl, stageEl, boardEl);
  const canEdit = id => ADMIN || FA.isMine(id);

  /* ---------------- ui helpers ---------------- */

  let toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 3200);
  }

  function showBanner(msg, isError) {
    banner.textContent = msg;
    banner.classList.toggle('error', !!isError);
    banner.hidden = false;
  }
  function hideBanner() { banner.hidden = true; }

  let drag = null;

  function render() {
    FA.renderBoard(boardEl, bstore.notes, { canEdit, imageSrc: bstore.imageSrc });
    viewport.apply();
    const sel = selectedId && boardEl.querySelector('.note[data-id="' + selectedId + '"]');
    for (const el of boardEl.querySelectorAll('.note.selected')) el.classList.remove('selected');
    if (sel) sel.classList.add('selected');
    else if (selectedId) { selectedId = null; controls.hidden = true; }
  }

  bstore.onChange(() => { if (!drag) render(); });

  bstore.onStatus(s => {
    if (s === 'saving') showBanner('saving…');
    else if (s === 'saved') { hideBanner(); }
    else if (s === 'rate-limited') showBanner('taking a short breather — your note will finish saving in a moment', true);
    else if (s === 'offline') showBanner('offline — your note is kept on this device and will retry', true);
  });

  /* ---------------- selection + drag ---------------- */

  const sliders = {
    w: document.getElementById('slider-w'),
    fs: document.getElementById('slider-fs'),
    rot: document.getElementById('slider-rot'),
  };

  function select(id) {
    selectedId = id;
    const n = bstore.getNote(id);
    if (!n) return;
    sliders.w.value = n.w || 260;
    sliders.fs.value = n.fs || 1;
    sliders.rot.value = n.rot || 0;
    controls.hidden = false;
    render();
  }

  function deselect() {
    selectedId = null;
    controls.hidden = true;
    render();
  }

  for (const [prop, input] of Object.entries(sliders)) {
    input.addEventListener('input', () => {
      const n = selectedId && bstore.getNote(selectedId);
      if (!n) return;
      n[prop] = parseFloat(input.value);
      const el = boardEl.querySelector('.note[data-id="' + n.id + '"]');
      if (el) {
        el.style.width = n.w + 'px';
        el.style.transform = 'rotate(' + (n.rot || 0) + 'deg)';
        const t = el.querySelector('.note-text');
        const font = FA.FONTS[n.font] || FA.FONTS.caveat;
        if (t) t.style.fontSize = Math.round(font.size * (n.fs || 1)) + 'px';
      }
    });
    input.addEventListener('change', () => {
      const n = selectedId && bstore.getNote(selectedId);
      if (n) bstore.putNote({ ...n });
    });
  }

  document.getElementById('btn-edit-note').addEventListener('click', () => {
    const n = selectedId && bstore.getNote(selectedId);
    if (n) openDialog(n);
  });

  document.getElementById('btn-delete-note').addEventListener('click', () => {
    const n = selectedId && bstore.getNote(selectedId);
    if (!n) return;
    if (!confirm('Remove this note from the board?')) return;
    bstore.deleteNote(n.id);
    deselect();
  });

  document.getElementById('btn-done-note').addEventListener('click', deselect);

  boardEl.addEventListener('pointerdown', ev => {
    const noteEl = ev.target.closest('.note');
    if (!noteEl) return;
    const id = noteEl.dataset.id;
    if (!canEdit(id)) return;
    const n = bstore.getNote(id);
    if (!n) return;
    drag = {
      id,
      el: noteEl,
      startX: ev.clientX,
      startY: ev.clientY,
      origX: n.x,
      origY: n.y,
      moved: false,
    };
    noteEl.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  boardEl.addEventListener('pointermove', ev => {
    if (!drag) return;
    const dx = (ev.clientX - drag.startX) / viewport.scale;
    const dy = (ev.clientY - drag.startY) / viewport.scale;
    if (!drag.moved && Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) > 6) {
      drag.moved = true;
      drag.el.classList.add('dragging');
      const n = bstore.getNote(drag.id);
      if (n) { n.z = bstore.maxZ() + 1; drag.el.style.zIndex = String(10 + n.z); }
    }
    if (drag.moved) {
      const n = bstore.getNote(drag.id);
      if (!n) return;
      n.x = Math.round(Math.min(FA.CONFIG.BOARD_W - 60, Math.max(60 - (n.w || 260), drag.origX + dx)));
      n.y = Math.round(Math.min(boardEl.offsetHeight - 80, Math.max(0, drag.origY + dy)));
      drag.el.style.left = n.x + 'px';
      drag.el.style.top = n.y + 'px';
    }
  });

  function endDrag() {
    if (!drag) return;
    const { id, el, moved } = drag;
    drag = null;
    el.classList.remove('dragging');
    const n = bstore.getNote(id);
    if (!n) return;
    if (moved) {
      bstore.putNote({ ...n });
      if (selectedId !== id) select(id);
    } else {
      select(id);
    }
  }
  boardEl.addEventListener('pointerup', endDrag);
  boardEl.addEventListener('pointercancel', () => {
    if (drag) { drag.el.classList.remove('dragging'); drag = null; render(); }
  });

  scrollEl.addEventListener('pointerdown', ev => {
    if (!ev.target.closest('.note') && !ev.target.closest('.note-controls')) deselect();
  });

  /* ---------------- dialog (add / edit) ---------------- */

  const overlay = document.getElementById('note-overlay');
  const dlgTitle = document.getElementById('dlg-title');
  const inText = document.getElementById('in-text');
  const inName = document.getElementById('in-name');
  const inUrl = document.getElementById('in-url');
  const inFile = document.getElementById('in-file');
  const fontRow = document.getElementById('font-row');
  const colorRow = document.getElementById('color-row');
  const imgPreview = document.getElementById('img-preview');
  const imgPreviewImg = imgPreview.querySelector('img');
  const imgError = document.getElementById('img-error');
  const formError = document.getElementById('form-error');

  // dlgState.img: existing imgRef ({type:'url'|'chunked'}) kept as-is;
  // dlgState.pendingUpload: freshly-chosen data URI, published only on save.
  let dlgState = null;

  function buildPickers() {
    for (const [key, f] of Object.entries(FA.FONTS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'font-chip';
      b.dataset.font = key;
      b.textContent = f.label;
      b.style.fontFamily = f.css;
      b.addEventListener('click', () => { dlgState.font = key; refreshPickers(); });
      fontRow.appendChild(b);
    }
    for (const [key, hex] of Object.entries(FA.COLORS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.color = key;
      b.style.background = hex;
      b.setAttribute('aria-label', key);
      b.addEventListener('click', () => { dlgState.color = key; refreshPickers(); });
      colorRow.appendChild(b);
    }
  }

  function previewSrc() {
    if (!dlgState) return null;
    if (dlgState.pendingUpload) return dlgState.pendingUpload;
    if (dlgState.img) return bstore.imageSrc(dlgState.img);
    return null;
  }

  function refreshPickers() {
    for (const b of fontRow.children) b.classList.toggle('selected', b.dataset.font === dlgState.font);
    for (const b of colorRow.children) b.classList.toggle('selected', b.dataset.color === dlgState.color);
    const src = previewSrc();
    imgPreview.hidden = !src;
    if (src) imgPreviewImg.src = src;
  }

  function openDialog(note) {
    dlgState = {
      editingId: note ? note.id : null,
      font: note ? note.font : 'caveat',
      color: note ? note.color : ['ivory', 'blush', 'sage', 'mist', 'sand', 'lilac'][Math.floor(Math.random() * 6)],
      img: note && note.img ? { ...note.img } : null,
      pendingUpload: null,
    };
    dlgTitle.textContent = note ? 'Edit your note' : 'Leave a note for Anthony';
    inText.value = note ? note.text : '';
    inName.value = note ? note.name : FA.getSavedName();
    inUrl.value = '';
    inFile.value = '';
    imgError.hidden = true;
    formError.hidden = true;
    refreshPickers();
    overlay.hidden = false;
    setTimeout(() => inText.focus(), 60);
  }

  function closeDialog() { overlay.hidden = true; dlgState = null; }

  document.getElementById('btn-add').addEventListener('click', () => openDialog(null));
  document.getElementById('btn-dlg-cancel').addEventListener('click', closeDialog);
  overlay.addEventListener('pointerdown', ev => { if (ev.target === overlay) closeDialog(); });

  document.getElementById('btn-img-remove').addEventListener('click', () => {
    dlgState.img = null;
    dlgState.pendingUpload = null;
    inUrl.value = '';
    inFile.value = '';
    refreshPickers();
  });

  /* image via URL */
  document.getElementById('btn-url-add').addEventListener('click', async () => {
    const url = inUrl.value.trim();
    imgError.hidden = true;
    if (!url) return;
    if (!/^https:\/\//i.test(url)) {
      imgError.textContent = 'Please paste a full https:// image or GIF link.';
      imgError.hidden = false;
      return;
    }
    const ok = await new Promise(resolve => {
      const img = new Image();
      const timer = setTimeout(() => resolve(false), 8000);
      img.onload = () => { clearTimeout(timer); resolve(true); };
      img.onerror = () => { clearTimeout(timer); resolve(false); };
      img.src = url;
    });
    if (!ok) {
      imgError.textContent = 'That link didn’t load as an image. On GIPHY or Tenor, right-click the GIF and copy the image address.';
      imgError.hidden = false;
      return;
    }
    dlgState.img = { type: 'url', src: url };
    dlgState.pendingUpload = null;
    refreshPickers();
  });

  /* image via upload (downscaled + compressed on-device) */
  inFile.addEventListener('change', async () => {
    const file = inFile.files && inFile.files[0];
    imgError.hidden = true;
    if (!file) return;
    try {
      if (file.type === 'image/gif') {
        if (file.size > 600000) {
          throw new Error('That GIF is too large to upload here — paste a GIF link instead (see the tip below).');
        }
        dlgState.pendingUpload = await readAsDataURL(file);
      } else if (/^image\//.test(file.type)) {
        dlgState.pendingUpload = await compressImage(file);
      } else {
        throw new Error('Please choose an image file.');
      }
      dlgState.img = null;
      refreshPickers();
    } catch (e) {
      imgError.textContent = e.message || 'Couldn’t read that file.';
      imgError.hidden = false;
    }
  });

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Couldn’t read that file.'));
      r.readAsDataURL(file);
    });
  }

  async function compressImage(file) {
    const dataUrl = await readAsDataURL(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Couldn’t read that image.'));
      i.src = dataUrl;
    });
    let scale = Math.min(1, 800 / Math.max(img.width, img.height));
    let quality = 0.82;
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.length < 250000) return out;
      scale *= 0.78;
      quality = Math.max(0.6, quality - 0.08);
    }
    throw new Error('That photo couldn’t be shrunk enough — try a smaller image.');
  }

  /* save */
  document.getElementById('btn-dlg-save').addEventListener('click', () => {
    const text = inText.value.trim().slice(0, 600);
    const name = inName.value.trim().slice(0, 60);
    formError.hidden = true;
    if (!text && !dlgState.img && !dlgState.pendingUpload) {
      formError.textContent = 'Write a few words, or add a photo or GIF.';
      formError.hidden = false;
      return;
    }
    if (name) FA.setSavedName(name);

    let imgRef = dlgState.img;
    if (dlgState.pendingUpload) imgRef = bstore.addImage(dlgState.pendingUpload);

    if (dlgState.editingId) {
      const n = bstore.getNote(dlgState.editingId);
      if (n) {
        bstore.putNote({ ...n, text, name, font: dlgState.font, color: dlgState.color, img: imgRef });
      }
      closeDialog();
    } else {
      const n = FA.createNote(bstore, { text, name, font: dlgState.font, color: dlgState.color, img: imgRef });
      bstore.putNote(n);
      closeDialog();
      render();
      select(n.id);
      const el = boardEl.querySelector('.note[data-id="' + n.id + '"]');
      if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      toast('Your note is on the board — drag it anywhere you like.', 4200);
    }
  });

  /* ---------------- zoom controls ---------------- */

  document.getElementById('btn-zoom-in').addEventListener('click', () => viewport.zoom(1.25));
  document.getElementById('btn-zoom-out').addEventListener('click', () => viewport.zoom(0.8));

  /* ---------------- intro (first visit) ---------------- */

  const introOverlay = document.getElementById('intro-overlay');
  try {
    if (!localStorage.getItem('fa_intro_seen')) introOverlay.hidden = false;
  } catch { /* ignore */ }
  document.getElementById('btn-intro-ok').addEventListener('click', () => {
    introOverlay.hidden = true;
    try { localStorage.setItem('fa_intro_seen', '1'); } catch { /* ignore */ }
  });

  /* ---------------- boot + polling ---------------- */

  (async function boot() {
    showBanner('loading the board…');
    await bstore.init();
    hideBanner();
    if (bstore.source !== 'live' && FA.configured()) {
      showBanner('offline — showing the last saved copy', true);
    }
    render();
    viewport.fit();
    if (ADMIN) toast('Admin mode: you can move, edit, or remove any note.', 4200);
  })();

  setInterval(() => {
    if (document.visibilityState === 'visible' && overlay.hidden && !drag) bstore.poll();
  }, FA.CONFIG.POLL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && overlay.hidden && !drag) bstore.poll();
  });

  buildPickers();
})();
