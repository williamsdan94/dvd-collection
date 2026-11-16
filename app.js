/* My DVDs ("Do I own it?") — the app itself.
   Screens: Home (search + cover grid), Scan, Batch scan, Queue, Missed
   (type the title), Found (add / already own), Detail, Edit, Settings.
   The list, covers, and the batch-scan queue live in this phone's IndexedDB.
   A GitHub key, when pasted in Settings, is also stored only here — never
   in the public site or in a backup file. The scan queue stays on this
   phone and is not part of the GitHub backup. */
(function () {
  'use strict';

  var app = document.getElementById('app');
  var coverInput = document.getElementById('cover-input');
  var importInput = document.getElementById('import-input');

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function niceDate(iso) {
    // Date-only values are shown as written (no time-zone shift).
    // Full timestamps are shown in the phone's local time.
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (m) return MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  function isoNow() { return new Date().toISOString(); }

  var toastTimer;
  function toast(text) {
    var t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2200);
  }

  // Title match: ignore case, punctuation, extra spaces, and a leading "The".
  function normalizeTitle(s) {
    var t = String(s || '').toLowerCase().replace(/['’`]/g, '');
    t = t.replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
    t = t.replace(/^the\s+/, '');
    return t;
  }
  // Drop edition / format suffixes so "The Matrix (Widescreen Edition)" matches "Matrix".
  function stripEdition(s) {
    var t = String(s || '');
    t = t.replace(/\s*[\[(][^)\]]*(?:DVD|Blu-?ray|4K|UHD|HD[\s-]?DVD|Digital|Widescreen|Full[\s-]?Screen|Special\s+Edition|Collector'?s?\s+Edition|Extended(?:\s+Edition)?|Director'?s?\s+Cut|Theatrical|Unrated|Remastered|Anniversary|Edition)[^)\]]*[)\]]\s*/gi, ' ');
    t = t.replace(/\s*[-–—:|,/]\s*(?:Widescreen(?:\s+Edition)?|Full[\s-]?Screen|Special\s+Edition|Collector'?s?\s+Edition|Extended(?:\s+Edition)?|Director'?s?\s+Cut|Theatrical(?:\s+Cut)?|Unrated|Remastered|Anniversary(?:\s+Edition)?|(?:4K\s*)?UHD|Blu-?ray|DVD)\s*$/gi, '');
    t = t.replace(/\s+(?:Widescreen(?:\s+Edition)?|Full[\s-]?Screen|Special\s+Edition|Blu-?ray|DVD)\s*$/gi, '');
    return t.trim();
  }
  function coreTitle(s) {
    return normalizeTitle(stripEdition(s));
  }
  function yearsCompatible(a, b) {
    var ya = String(a || '').trim();
    var yb = String(b || '').trim();
    if (/^\d{4}$/.test(ya) && /^\d{4}$/.test(yb)) return ya === yb;
    return true;
  }
  // UPC-A (12 digits) compares equal to the same code as EAN-13 (leading 0).
  function normalizeBarcode(s) {
    var d = String(s || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.length === 12) d = '0' + d;
    return d;
  }

  // ---------- Storage (IndexedDB, on this phone only) ----------
  // dvds: the list. covers: JPEG blobs. settings: githubToken, githubOwner,
  // githubRepo, lastBackupAt, lastRestoreAt, backupPending (the key lives only
  // in this settings store, never in the public site or a backup file).
  // scanQueue: barcodes waiting to be looked up in Batch scan. Kept on this
  // phone only — not included in the GitHub backup (in-progress state would
  // fight with restore and the shrink guards).
  var dbPromise = null;
  var DB_VERSION = 2;
  var dbClosedByVersionChange = false;
  function attachDbLifecycle(d) {
    d.onversionchange = function () {
      d.close();
      dbClosedByVersionChange = true;
      dbPromise = null;
    };
  }
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open('my-dvds', DB_VERSION);
        req.onupgradeneeded = function () {
          var d = req.result;
          attachDbLifecycle(d);
          if (!d.objectStoreNames.contains('dvds')) d.createObjectStore('dvds', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('covers')) d.createObjectStore('covers', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
          if (!d.objectStoreNames.contains('scanQueue')) d.createObjectStore('scanQueue', { keyPath: 'id' });
        };
        req.onsuccess = function () {
          var d = req.result;
          attachDbLifecycle(d);
          resolve(d);
        };
        req.onerror = function () { reject(req.error); };
        req.onblocked = function () {
          toast('Close other My DVDs tabs and reopen.');
        };
      });
    }
    return dbPromise;
  }
  function tx(stores, mode, work) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(stores, mode), result;
        t.oncomplete = function () { resolve(result); };
        t.onerror = t.onabort = function () { reject(t.error); };
        result = work(t);
        if (result && typeof result === 'object' && 'onsuccess' in result) {
          var r = result; r.onsuccess = function () { result = r.result; };
        }
      });
    });
  }
  function getAllDvds() { return tx(['dvds'], 'readonly', function (t) { return t.objectStore('dvds').getAll(); }); }
  function getCover(id) {
    return tx(['covers'], 'readonly', function (t) { return t.objectStore('covers').get(id); })
      .then(function (row) { return row ? row.blob : null; });
  }
  function saveDvd(rec, coverBlob, coverChanged) {
    return tx(['dvds', 'covers'], 'readwrite', function (t) {
      t.objectStore('dvds').put(rec);
      if (coverChanged && coverBlob) t.objectStore('covers').put({ id: rec.id, blob: coverBlob });
    });
  }
  function deleteDvd(id) {
    return tx(['dvds', 'covers'], 'readwrite', function (t) {
      t.objectStore('dvds').delete(id);
      t.objectStore('covers').delete(id);
    });
  }
  function getSetting(key) {
    return tx(['settings'], 'readonly', function (t) { return t.objectStore('settings').get(key); })
      .then(function (row) { return row ? row.value : null; });
  }
  function setSetting(key, value) {
    return tx(['settings'], 'readwrite', function (t) {
      t.objectStore('settings').put({ key: key, value: value });
    });
  }
  function getAllQueue() { return tx(['scanQueue'], 'readonly', function (t) { return t.objectStore('scanQueue').getAll(); }); }
  function putQueueItem(item) {
    return tx(['scanQueue'], 'readwrite', function (t) { t.objectStore('scanQueue').put(item); });
  }
  function deleteQueueItem(id) {
    return tx(['scanQueue'], 'readwrite', function (t) { t.objectStore('scanQueue').delete(id); });
  }

  // ---------- App state ----------
  var dvds = [];
  var view = 'home';
  var query = '';
  var currentId = null;
  var draft = null;       // found / edit / type-title
  var scanError = '';
  var lastBackupAt = null;
  var lastRestoreAt = null;
  var githubToken = '';   // kept only in memory + IndexedDB, never exported
  var githubOwner = 'williamsdan94';
  var githubRepo = 'dvd-backup';
  var backupPending = false;
  var backupStatus = '';
  var backupBusy = false;
  var changedDuringUpload = false;
  var failNextReplace = false;
  var backupTimer = null;
  var restorePreview = null;
  var ghHelpOpen = false;
  var tokenDraft = '';
  var objectUrls = [];
  var queueItems = [];
  var batchStatus = '';
  var batchFlashTimer = null;
  var audioCtx = null;
  var queueTimer = null;
  var queueRunning = false;
  var queuePaused = false;
  var lastMissAt = 0;
  var busyStrike = 0;
  var pausedUntil = 0;
  var pauseReason = '';
  var dailyResetAt = null;
  var QUEUE_MISS_GAP = 15000;
  var QUEUE_BUSY = [30000, 60000, 120000, 300000];
  var DEFAULT_OWNER = 'williamsdan94';
  var DEFAULT_REPO = 'dvd-backup';
  var GH_API = 'https://api.github.com';

  function sortDvds() {
    dvds.sort(function (a, b) {
      return (a.addedAt || '') < (b.addedAt || '') ? 1 : -1;
    });
  }
  function photoUrl(blob) {
    var u = URL.createObjectURL(blob); objectUrls.push(u); return u;
  }
  function show(next) {
    if ((view === 'scan' || view === 'batch-scan') && next !== view && window.DvdScan) DvdScan.stopCamera();
    objectUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    objectUrls = [];
    view = next;
    render();
    window.scrollTo(0, 0);
  }

  // Returns { item, kind: 'barcode'|'title' } or null.
  // Barcode is an exact ownership hit. Title + year (after coreTitle) is a softer maybe.
  // Same title with a different four-digit year is not a duplicate.
  function findDuplicate(title, year, barcode, exceptId) {
    var ct = coreTitle(title);
    var nb = normalizeBarcode(barcode);
    var i, d, barcodeHit = null, titleHit = null;
    for (i = 0; i < dvds.length; i++) {
      d = dvds[i];
      if (exceptId && d.id === exceptId) continue;
      if (nb && normalizeBarcode(d.barcode) === nb) { barcodeHit = d; break; }
      if (ct && coreTitle(d.title) === ct && yearsCompatible(year, d.year)) {
        if (!titleHit) titleHit = d;
      }
    }
    if (barcodeHit) return { item: barcodeHit, kind: 'barcode' };
    if (titleHit) return { item: titleHit, kind: 'title' };
    return null;
  }

  function levenshtein(a, b) {
    var i, j, prev, cur, al = a.length, bl = b.length;
    if (a === b) return 0;
    if (!al) return bl;
    if (!bl) return al;
    prev = [];
    for (j = 0; j <= bl; j++) prev[j] = j;
    for (i = 1; i <= al; i++) {
      cur = [i];
      for (j = 1; j <= bl; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[bl];
  }
  // 0 for 1–2 letter tokens, 1 for 3–5, 2 for 6+.
  function typoBudget(n) {
    if (n <= 2) return 0;
    if (n <= 5) return 1;
    return 2;
  }

  // 2 = II = two. Years are four-digit and are handled separately.
  var NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20
  };
  var ROMAN_NUM = {
    i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
    xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20
  };

  function parseNumberToken(tok) {
    if (!tok) return null;
    if (/^\d{4}$/.test(tok)) return { n: +tok, yearish: true };
    if (/^\d+$/.test(tok)) return { n: +tok, yearish: false };
    if (Object.prototype.hasOwnProperty.call(ROMAN_NUM, tok)) return { n: ROMAN_NUM[tok], yearish: false };
    if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, tok)) return { n: NUMBER_WORDS[tok], yearish: false };
    return null;
  }
  function titleTokens(d) {
    return coreTitle(d && d.title).split(/\s+/).filter(Boolean);
  }
  function titleNumbers(d) {
    var out = [];
    titleTokens(d).forEach(function (tok) {
      var num = parseNumberToken(tok);
      if (num) out.push(num.n);
    });
    return out;
  }
  function titleYear(d) {
    var y = String((d && d.year) || '').trim();
    return /^\d{4}$/.test(y) ? y : '';
  }
  function titleWords(d) {
    return titleTokens(d).filter(function (tok) { return !parseNumberToken(tok); });
  }
  function isPluralInflection(qt, ht) {
    return qt === ht + 's' || qt === ht + 'es';
  }

  // Word match only — numbers and years are handled in matchQuality.
  // Prefixes need 2+ letters (1-letter queries only match a 1-letter word exactly).
  // A longer query word is no longer a hit just because it starts with the title word.
  // Typos use edit distance; adding 's'/'es' (aliens vs alien) is never a strong typo.
  function wordQuality(qt, ht) {
    if (!qt || !ht) return null;
    if (qt === ht) return 'strong';
    if (ht.indexOf(qt) === 0) {
      if (qt.length >= 3) return 'strong';
      if (qt.length === 2) return 'weak';
      return null;
    }
    var budget = typoBudget(Math.min(qt.length, ht.length));
    if (budget && levenshtein(qt, ht) <= budget) {
      if (isPluralInflection(qt, ht)) return 'weak';
      return 'strong';
    }
    if (ht.length > qt.length && qt.length >= 3) {
      if (levenshtein(qt, ht.slice(0, qt.length)) <= typoBudget(qt.length)) return 'weak';
    }
    return null;
  }

  // Returns 'strong', 'weak', or null. Duplicate detection does not use this.
  function matchQuality(d, q) {
    var raw = String(q || '').trim();
    var tokens = normalizeTitle(raw).split(/\s+/).filter(Boolean);
    var digits = raw.replace(/\D/g, '');
    if (!tokens.length && !digits) return 'strong';
    var nb = normalizeBarcode(d.barcode);
    var barcodeHit = !!(digits && nb && (normalizeBarcode(digits) === nb || (digits.length >= 8 && nb.indexOf(digits) !== -1)));
    if (!tokens.length) return barcodeHit ? 'strong' : null;

    var nums = titleNumbers(d);
    var year = titleYear(d);
    var words = titleWords(d);
    var weakest = 'strong';
    var i, qt, num, best, wq;
    for (i = 0; i < tokens.length; i++) {
      qt = tokens[i];
      num = parseNumberToken(qt);
      if (num) {
        if (!num.yearish && String(num.n).length >= 8) {
          if (barcodeHit || (nb && (nb === String(num.n) || nb === normalizeBarcode(String(num.n))))) continue;
          return null;
        }
        if (num.yearish) {
          if ((year && num.n === +year) || nums.indexOf(num.n) !== -1) continue;
          return null;
        }
        // Sequel numbers (2 = II = two) must appear in the title, never as a year prefix.
        if (nums.indexOf(num.n) !== -1) continue;
        return null;
      }
      best = null;
      words.forEach(function (ht) {
        wq = wordQuality(qt, ht);
        if (wq === 'strong') best = 'strong';
        else if (wq && best !== 'strong') best = 'weak';
      });
      if (!best) return null;
      if (best === 'weak') weakest = 'weak';
    }
    return weakest;
  }

  function matches(d, q) {
    return !!matchQuality(d, q);
  }

  // ---------- Screens ----------
  function render() {
    if (view === 'home') return renderHome();
    if (view === 'scan') return renderScan();
    if (view === 'batch-scan') return renderBatchScan();
    if (view === 'queue') return renderQueue();
    if (view === 'looking') return renderLooking();
    if (view === 'missed') return renderMissed();
    if (view === 'found') return renderFound();
    if (view === 'detail') return renderDetail();
    if (view === 'edit') return renderEdit();
    if (view === 'settings') return renderSettings();
    if (view === 'restore') return renderRestore();
  }

  function niceDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return niceDate(iso) || '';
    var mins = ('0' + d.getMinutes()).slice(-2);
    var hours = d.getHours();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    var h12 = hours % 12 || 12;
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ', ' + h12 + ':' + mins + ' ' + ampm;
  }
  function backupLabel() {
    return lastBackupAt ? ('Last backup: ' + niceDateTime(lastBackupAt)) : 'Last backup: never';
  }
  function statusLine() {
    return backupStatus || backupLabel();
  }

  function renderHome() {
    app.innerHTML =
      '<div class="topbar"><h1>My DVDs</h1>' +
      '<button type="button" class="link backup-link" data-action="settings" aria-label="Backup and settings">' +
      '<span class="backup-title">Backup</span>' +
      '<span class="backup-meta" id="backup-meta">' + esc(backupLabel()) + '</span></button></div>' +
      '<div class="search-wrap"><input id="search" class="search" type="search" enterkeyhint="search" autocomplete="off" ' +
      'placeholder="Do I own it?" aria-label="Do I own it?" value="' + esc(query) + '">' +
      '<button type="button" class="search-clear" data-action="clear-search" aria-label="Clear search"' + (query ? '' : ' hidden') + '>✕</button></div>' +
      '<div id="results" class="results"></div>' +
      '<div class="scanbar"><div class="scanbar-inner">' +
      '<button type="button" class="btn-big" data-action="scan">📷 Scan barcode</button>' +
      '<button type="button" class="btn-small" data-action="batch-scan">Batch scan</button>' +
      '<button type="button" class="btn-small" data-action="queue" id="home-queue-btn">' + esc(queueButtonLabel()) + '</button>' +
      '</div></div>';
    renderResults();
  }

  // Only the results redraw while typing, so the search box (and keyboard) stay put.
  // Do not autofocus the search box: on iPhone that pops the keyboard.
  function renderResults() {
    var box = document.getElementById('results');
    if (!box) return;
    if (query.trim()) {
      var scored = dvds.map(function (d) { return { d: d, q: matchQuality(d, query) }; }).filter(function (x) { return x.q; });
      if (!scored.length) {
        box.innerHTML = '<p class="no-match">Not in your collection.</p>';
        return;
      }
      var strong = scored.filter(function (x) { return x.q === 'strong'; });
      var weak = scored.filter(function (x) { return x.q === 'weak'; });
      function hitList(list) {
        return '<ul class="hit-list">' + list.map(function (x) {
          var d = x.d;
          return '<li class="hit"><button type="button" class="hit-btn" data-action="open" data-id="' + esc(d.id) + '">' +
            (d.hasCover
              ? '<img class="hit-thumb" alt="" data-cover="' + esc(d.id) + '">'
              : '<span class="hit-placeholder">' + esc((d.title || '?').slice(0, 1).toUpperCase()) + '</span>') +
            '<span class="hit-main"><span class="hit-title">' + (esc(d.title) || 'Untitled') + '</span>' +
            '<span class="hit-year">' + esc(d.year || '') + '</span></span></button></li>';
        }).join('') + '</ul>';
      }
      box.innerHTML =
        (strong.length ? '<p class="yes-own" role="status">Yes, you own it</p>' + hitList(strong) : '') +
        (weak.length ? '<p class="close-match" role="status">Close match, check the title:</p>' + hitList(weak) : '');
      fillCovers(box);
      return;
    }
    if (!dvds.length) {
      box.innerHTML = '<p class="empty">No DVDs yet. Scan a barcode to add your first one.</p>';
      return;
    }
    box.innerHTML = '<div class="grid">' + dvds.map(function (d) {
      return '<button type="button" class="grid-btn" data-action="open" data-id="' + esc(d.id) + '" aria-label="' + esc(d.title || 'DVD') + '">' +
        (d.hasCover
          ? '<img class="grid-cover" alt="' + esc(d.title || '') + '" data-cover="' + esc(d.id) + '">'
          : '<span class="grid-placeholder">' + esc(d.title || '') + '</span>') +
        '</button>';
    }).join('') + '</div>';
    fillCovers(box);
  }

  function fillCovers(root) {
    var imgs = root.querySelectorAll('[data-cover]');
    Array.prototype.forEach.call(imgs, function (img) {
      var id = img.getAttribute('data-cover');
      getCover(id).then(function (blob) {
        if (blob && img.isConnected) img.src = photoUrl(blob);
      });
    });
  }

  function renderScan() {
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button>' +
      '<h2>Scan</h2><span class="spacer"></span></div>' +
      '<div class="scan-screen">' +
      '<div class="viewfinder">' +
      '<video id="cam" playsinline muted autoplay></video>' +
      '<div class="guide-box" aria-hidden="true"></div>' +
      '<p class="scan-hint">Line the barcode up in the box</p>' +
      '</div>' +
      '<p class="scan-error" id="scan-error"' + (scanError ? '' : ' hidden') + '>' + esc(scanError) + '</p>' +
      '<div class="scan-actions">' +
      '<button type="button" class="btn-small" data-action="snap-cover">Snap cover instead</button>' +
      '<button type="button" class="btn-small" data-action="type-title">Type title</button>' +
      '</div></div>';
    var video = document.getElementById('cam');
    if (!window.DvdScan) {
      setScanError('Scanner library failed to load.');
      return;
    }
    DvdScan.startCamera(video, function (hit) {
      if (!hit || !hit.text) return;
      onBarcode(hit.text);
    }).catch(function (err) {
      if (err && err.kind === 'library') {
        setScanError('The barcode scanner didn\'t load. Close the app, open it again, and retry. You can also type the title.');
      } else if (err && err.name === 'NotAllowedError') {
        setScanError('Camera access is off. Allow the camera for this app in Settings, or type the title.');
      } else {
        setScanError('Camera is not available. Snap the cover or type the title.');
      }
    });
  }

  function setScanError(msg) {
    scanError = msg || '';
    var el = document.getElementById('scan-error');
    if (!el) return;
    el.textContent = scanError;
    el.hidden = !scanError;
  }

  function queueButtonLabel() {
    var n = queueCounts().waiting;
    if (n > 0) return 'Queue (' + n + ' waiting)';
    if (queueItems.length) return 'Queue (' + queueItems.length + ')';
    return 'Queue';
  }

  function queueCounts() {
    var c = { waiting: 0, found: 0, not_found: 0, duplicate: 0, error: 0, total: queueItems.length };
    queueItems.forEach(function (i) { if (c[i.status] != null) c[i.status] += 1; });
    return c;
  }

  function queueStatusLabel(st) {
    if (st === 'waiting') return 'Waiting';
    if (st === 'found') return 'Found (added)';
    if (st === 'not_found') return 'Not found';
    if (st === 'duplicate') return 'Duplicate (skipped)';
    if (st === 'error') return 'Error';
    return st || '';
  }

  function nextUtcMidnightIso(now) {
    var d = new Date(now || Date.now());
    var next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0);
    return new Date(next).toISOString();
  }

  function unlockAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
    } catch (e) {}
  }

  function beepQueue() {
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
    try {
      if (!audioCtx || audioCtx.state === 'suspended') return;
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.08, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.09);
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.1);
    } catch (e) {}
  }

  function setBatchStatus(msg) {
    batchStatus = msg || '';
    var el = document.getElementById('batch-status');
    if (el) { el.textContent = batchStatus; el.hidden = !batchStatus; }
    clearTimeout(batchFlashTimer);
    if (batchStatus) {
      batchFlashTimer = setTimeout(function () {
        if (batchStatus === msg) {
          batchStatus = '';
          var e2 = document.getElementById('batch-status');
          if (e2) { e2.textContent = ''; e2.hidden = true; }
        }
      }, 2500);
    }
  }

  function renderBatchScan() {
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button>' +
      '<h2>Batch scan</h2>' +
      '<button type="button" class="link" data-action="queue">Queue</button></div>' +
      '<div class="scan-screen">' +
      '<div class="viewfinder">' +
      '<video id="cam" playsinline muted autoplay></video>' +
      '<div class="guide-box" aria-hidden="true"></div>' +
      '<p class="scan-hint">Keep lining up barcodes. Each good one is added to the Queue.</p>' +
      '</div>' +
      '<p class="batch-status" id="batch-status"' + (batchStatus ? '' : ' hidden') + '>' + esc(batchStatus) + '</p>' +
      '<p class="scan-error" id="scan-error"' + (scanError ? '' : ' hidden') + '>' + esc(scanError) + '</p>' +
      '<div class="scan-actions">' +
      '<button type="button" class="btn-small" data-action="queue">View queue</button>' +
      '</div></div>';
    var video = document.getElementById('cam');
    if (!window.DvdScan) {
      setScanError('Scanner library failed to load.');
      return;
    }
    DvdScan.startCamera(video, function (hit) {
      if (!hit || !hit.text) return;
      if (view !== 'batch-scan') return;
      enqueueBarcode(hit.text);
    }).catch(function (err) {
      if (err && err.kind === 'library') {
        setScanError('The barcode scanner didn\'t load. Close the app, open it again, and retry.');
      } else if (err && err.name === 'NotAllowedError') {
        setScanError('Camera access is off. Allow the camera for this app in Settings.');
      } else {
        setScanError('Camera is not available.');
      }
    });
  }

  function queuePauseMessage() {
    if (pauseReason === 'daily_limit') {
      var when = niceDateTime(dailyResetAt || (pausedUntil ? new Date(pausedUntil).toISOString() : ''));
      return when ? ('Daily lookup limit reached. Lookups pause until ' + when + '.') : 'Daily lookup limit reached. Lookups pause until the reset.';
    }
    if ((pauseReason === 'busy' || pauseReason === 'temp') && pausedUntil > Date.now()) {
      var secs = Math.max(1, Math.round((pausedUntil - Date.now()) / 1000));
      if (pauseReason === 'temp') {
        return 'Couldn\'t look it up right now. Trying again in about ' + secs + ' second' + (secs === 1 ? '' : 's') + '.';
      }
      return 'The barcode database is busy. Trying again in about ' + secs + ' second' + (secs === 1 ? '' : 's') + '.';
    }
    return '';
  }

  function renderQueue() {
    var c = queueCounts();
    var items = queueItems.slice().sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1; });
    var pause = queuePauseMessage();
    var finished = c.found + c.duplicate;
    var body;
    if (!items.length) {
      body = '<p class="empty">No barcodes in the queue yet. Tap Batch scan to add some.</p>';
    } else {
      body = '<ul class="queue-list">' + items.map(function (i) {
        var actions = '<div class="queue-actions">';
        if (i.status === 'not_found') {
          actions += '<button type="button" class="btn-small" data-action="queue-type-title" data-id="' + esc(i.id) + '">Type the title</button>';
        }
        if (i.status === 'not_found' || i.status === 'error' || i.status === 'waiting') {
          actions += '<button type="button" class="btn-small" data-action="queue-retry" data-id="' + esc(i.id) + '">Retry</button>';
        }
        actions += '<button type="button" class="btn-small" data-action="queue-remove" data-id="' + esc(i.id) + '">Remove</button>';
        actions += '</div>';
        return '<li class="queue-item" data-queue-id="' + esc(i.id) + '" data-status="' + esc(i.status) + '">' +
          '<p class="queue-code">Barcode ' + esc(i.barcode || '') + '</p>' +
          '<p class="queue-status">' + esc(queueStatusLabel(i.status)) + (i.ownedLabel ? (' · ' + i.ownedLabel) : (i.title ? (' · ' + i.title) : '')) + '</p>' +
          actions + '</li>';
      }).join('') + '</ul>';
    }
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button>' +
      '<h2>Queue</h2>' +
      '<button type="button" class="link" data-action="batch-scan">Scan</button></div>' +
      '<div class="queue-counts" id="queue-counts">' +
      'Waiting ' + c.waiting + ' · Found ' + c.found + ' · Not found ' + c.not_found +
      ' · Duplicate ' + c.duplicate + ' · Error ' + c.error + '</div>' +
      (pause ? '<p class="msg queue-pause" id="queue-pause">' + esc(pause) + '</p>' : '') +
      body +
      '<div class="footer"><div>' +
      (finished ? '<button type="button" class="btn-small" data-action="clear-finished">Clear finished</button>' : '') +
      '<button type="button" class="btn-big" data-action="batch-scan">Batch scan</button>' +
      '</div></div>';
  }

  function refreshQueueChrome() {
    if (view === 'queue') renderQueue();
    else if (view === 'home') {
      var btn = document.getElementById('home-queue-btn');
      if (btn) btn.textContent = queueButtonLabel();
    } else if (view === 'batch-scan') {
      var el = document.getElementById('batch-status');
      if (el && batchStatus) { el.textContent = batchStatus; el.hidden = false; }
    }
  }

  function findQueueItem(id) {
    for (var i = 0; i < queueItems.length; i++) if (queueItems[i].id === id) return queueItems[i];
    return null;
  }

  function enqueueBarcode(raw, opts) {
    opts = opts || {};
    var code = String(raw || '').replace(/\D/g, '');
    if (window.DvdScan && typeof DvdScan.normalizeRead === 'function') {
      var norm = DvdScan.normalizeRead(code, '');
      if (!norm) {
        if (!opts.fromTest) toast('That barcode number doesn\'t look valid.');
        setBatchStatus('That barcode number doesn\'t look valid.');
        return Promise.resolve({ ok: false, reason: 'invalid' });
      }
      code = norm;
    } else if (!code) {
      return Promise.resolve({ ok: false, reason: 'invalid' });
    }
    var nb = normalizeBarcode(code);
    var existing = null, i;
    for (i = 0; i < queueItems.length; i++) {
      if (normalizeBarcode(queueItems[i].barcode) === nb) { existing = queueItems[i]; break; }
    }
    if (existing) {
      toast('That barcode is already in the queue');
      setBatchStatus('Already in the queue');
      return Promise.resolve({ ok: false, reason: 'in_queue', id: existing.id });
    }
    var owned = findDuplicate('', '', code, null);
    var item = {
      id: newId(),
      barcode: code,
      status: owned ? 'duplicate' : 'waiting',
      title: owned ? owned.item.title : '',
      year: owned ? (owned.item.year || '') : '',
      addedId: owned ? owned.item.id : null,
      ownedLabel: owned ? ('Already own: ' + owned.item.title) : '',
      createdAt: isoNow(),
      updatedAt: isoNow()
    };
    queueItems.push(item);
    return putQueueItem(item).then(function () {
      beepQueue();
      if (owned) {
        toast('You already own “' + owned.item.title + '”. Skipped.');
        setBatchStatus('Already owned — skipped');
      } else {
        setBatchStatus('Added to the queue');
        kickQueue();
      }
      refreshQueueChrome();
      return { ok: true, item: item, skipped: !!owned };
    });
  }

  function setQueueTimingInternal(opts) {
    if (!opts) return;
    if (opts.missGap != null) QUEUE_MISS_GAP = Number(opts.missGap);
    if (opts.busyBackoffs) QUEUE_BUSY = opts.busyBackoffs.slice();
  }

  function kickQueue() {
    if (queuePaused) return;
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    var now = Date.now();
    var delay = 0;
    if (pausedUntil > now) delay = pausedUntil - now;
    else if (lastMissAt && now - lastMissAt < QUEUE_MISS_GAP) delay = QUEUE_MISS_GAP - (now - lastMissAt);
    queueTimer = setTimeout(function () { queueTimer = null; runQueueTick(); }, delay);
  }

  function resumeQueue(why) {
    queuePaused = false;
    var now = Date.now();
    if (pauseReason === 'daily_limit' && dailyResetAt && now < Date.parse(dailyResetAt)) {
      pausedUntil = Date.parse(dailyResetAt);
    } else if (pauseReason === 'daily_limit' && dailyResetAt && now >= Date.parse(dailyResetAt)) {
      pauseReason = '';
      pausedUntil = 0;
      dailyResetAt = null;
    }
    kickQueue();
    if (view === 'queue') renderQueue();
  }

  function runQueueTick() {
    if (queuePaused || queueRunning) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    var now = Date.now();
    if (pauseReason === 'daily_limit' && dailyResetAt) {
      var resetMs = Date.parse(dailyResetAt);
      if (isFinite(resetMs) && now < resetMs) {
        pausedUntil = resetMs;
        kickQueue();
        if (view === 'queue') renderQueue();
        return;
      }
      pauseReason = '';
      pausedUntil = 0;
      dailyResetAt = null;
    }
    if (pausedUntil > now) { kickQueue(); return; }
    if (lastMissAt && now - lastMissAt < QUEUE_MISS_GAP) { kickQueue(); return; }

    var waiting = queueItems.filter(function (q) { return q.status === 'waiting'; })
      .sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1; });
    var item = waiting[0];
    if (!item) return;

    var owned = findDuplicate('', '', item.barcode, null);
    if (owned) {
      markQueueDuplicate(item, owned);
      putQueueItem(item).then(function () { refreshQueueChrome(); kickQueue(); });
      return;
    }

    queueRunning = true;
    item.updatedAt = isoNow();
    DvdLookup.lookupBarcode(item.barcode).then(function (res) {
      // A cache hit is free. Everything else (a miss, or a response with no
      // x-relay-cache header: 502, 429, invalid, offline) uses the miss gap
      // so items are not looked up back to back during an outage.
      if (!(res && res.cache === 'hit')) lastMissAt = Date.now();
      if (res && res.ok) {
        busyStrike = 0;
        if (pauseReason === 'busy' || pauseReason === 'temp') { pauseReason = ''; pausedUntil = 0; }
        return DvdLookup.lookupMovie(res.title, null).then(function (movie) {
          var title = (movie && movie.title) || res.title;
          var year = (movie && movie.year) || '';
          var dup = findDuplicate(title, year, item.barcode, null);
          if (dup) {
            markQueueDuplicate(item, dup, title, year);
            return putQueueItem(item);
          }
          return saveNewMovie({
            title: title,
            year: year,
            barcode: item.barcode,
            coverBlob: movie && movie.posterBlob,
            posterUrl: movie && movie.posterUrl,
            source: (movie && movie.source) || 'lookup',
            tmdbId: movie && movie.tmdbId
          }).then(function (rec) {
            item.status = 'found';
            item.title = rec.title;
            item.year = rec.year;
            item.addedId = rec.id;
            item.updatedAt = isoNow();
            return putQueueItem(item);
          });
        });
      }
      if (res && (res.reason === 'busy' || res.reason === 'upstream_busy')) {
        applyQueueBackoff('busy');
        return;
      }
      if (res && (res.reason === 'upstream' || res.reason === 'http' || res.reason === 'offline')) {
        applyQueueBackoff('temp');
        return;
      }
      if (res && res.reason === 'daily_limit') {
        dailyResetAt = res.resetAt || nextUtcMidnightIso();
        var ms = Date.parse(dailyResetAt);
        pausedUntil = isFinite(ms) ? ms : Date.now() + 60 * 60 * 1000;
        pauseReason = 'daily_limit';
        return;
      }
      busyStrike = 0;
      if (res && res.reason === 'not_found') {
        item.status = 'not_found';
        item.errorReason = 'not_found';
      } else {
        // Truly invalid barcodes (and other terminal failures) stay Error.
        item.status = 'error';
        item.errorReason = (res && res.reason) || 'http';
      }
      item.updatedAt = isoNow();
      return putQueueItem(item);
    }).then(function () {
      queueRunning = false;
      refreshQueueChrome();
      kickQueue();
    }).catch(function () {
      queueRunning = false;
      if (item.status === 'waiting') applyQueueBackoff('temp');
      refreshQueueChrome();
      kickQueue();
    });
  }

  function applyQueueBackoff(reason) {
    var dly = QUEUE_BUSY[Math.min(busyStrike, QUEUE_BUSY.length - 1)];
    busyStrike += 1;
    pausedUntil = Date.now() + dly;
    pauseReason = reason || 'busy';
  }

  function markQueueDuplicate(item, owned, foundTitle, foundYear) {
    var name = (owned && owned.item && owned.item.title) || foundTitle || item.title || '';
    item.status = 'duplicate';
    item.title = name;
    item.year = (owned && owned.item && owned.item.year) || foundYear || item.year || '';
    item.addedId = owned && owned.item ? owned.item.id : item.addedId;
    item.ownedLabel = name ? ('Already own: ' + name) : 'Already own this';
    item.updatedAt = isoNow();
  }

  function markQueueFound(id, rec) {
    var item = findQueueItem(id);
    if (!item) return Promise.resolve();
    item.status = 'found';
    item.title = rec && rec.title || item.title;
    item.year = rec && rec.year || item.year;
    item.addedId = rec && rec.id || item.addedId;
    item.updatedAt = isoNow();
    return putQueueItem(item);
  }

  function clearFinishedQueue() {
    var keep = [];
    var drop = [];
    queueItems.forEach(function (i) {
      if (i.status === 'found' || i.status === 'duplicate') drop.push(i.id);
      else keep.push(i);
    });
    queueItems = keep;
    return tx(['scanQueue'], 'readwrite', function (t) {
      var store = t.objectStore('scanQueue');
      drop.forEach(function (id) { store.delete(id); });
    }).then(function () { refreshQueueChrome(); });
  }

  function retryQueueItem(id) {
    var item = findQueueItem(id);
    if (!item) return;
    item.status = 'waiting';
    item.errorReason = '';
    item.updatedAt = isoNow();
    return putQueueItem(item).then(function () {
      refreshQueueChrome();
      kickQueue();
    });
  }

  function removeQueueItem(id) {
    queueItems = queueItems.filter(function (i) { return i.id !== id; });
    return deleteQueueItem(id).then(function () { refreshQueueChrome(); });
  }

  function typeTitleForQueue(id) {
    var item = findQueueItem(id);
    if (!item) return;
    draft = blankDraft({
      barcode: item.barcode,
      fromQueueId: item.id,
      missed: true,
      missKind: 'not_found',
      missReason: (window.DvdLookup && DvdLookup.barcodeReasonText) ? DvdLookup.barcodeReasonText('not_found') : ''
    });
    show('missed');
  }

  function renderLooking() {
    app.innerHTML =
      '<div class="looking" role="status" aria-live="polite">' +
      '<p>Looking it up…</p>' +
      '<button type="button" class="btn-small" data-action="cancel-lookup">Cancel</button>' +
      '</div>';
  }

  function renderMissed() {
    var d = draft || {};
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="' + (d.fromQueueId ? 'queue' : 'scan') + '">Back</button>' +
      '<h2>Add a title</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      '<p class="msg">' + (d.missed ? (d.missKind && d.missKind !== 'not_found' ? 'Couldn\'t look it up right now. Type the title and we\'ll add it.' : 'Couldn\'t find it. Type the title and we\'ll add it.') : 'Type the title and we\'ll add it.') + '</p>' +
      (d.missed && d.missReason ? '<p class="miss-reason" id="miss-reason">' + esc(d.missReason) + '</p>' : '') +
      (d.missed && d.barcode ? '<p class="miss-code" id="miss-code">Barcode ' + esc(d.barcode) + '</p>' : '') +
      (d.missed && d.canRetry ? '<button type="button" class="btn-small" data-action="retry-barcode">Try the lookup again</button>' : '') +
      (d.coverBlob ? '<div class="cover-lg"><img id="draft-cover" alt="Cover photo"></div>' : '') +
      '<div class="field"><label for="f-title">Title</label>' +
      '<input id="f-title" class="inp" type="text" autocomplete="off" enterkeyhint="done" value="' + esc(d.title || '') + '"></div>' +
      '<div class="field"><label for="f-year">Year (optional)</label>' +
      '<input id="f-year" class="inp" type="text" inputmode="numeric" maxlength="4" value="' + esc(d.year || '') + '"></div>' +
      '<div class="field"><label for="f-barcode">Barcode</label>' +
      '<input id="f-barcode" class="inp" type="text" inputmode="numeric" value="' + esc(d.barcode || '') + '"></div>' +
      '</div>' +
      '<div class="footer"><div><button type="button" class="btn-big" data-action="lookup-title">Continue</button></div></div>';
    if (d.coverBlob) document.getElementById('draft-cover').src = photoUrl(d.coverBlob);
  }

  function renderFound() {
    var d = draft || {};
    var dup = findDuplicate(d.title, d.year, d.barcode, d.id);
    var existing = dup && dup.item;
    var kind = dup && dup.kind;
    var coverHtml = d.coverBlob
      ? '<div class="cover-lg"><img id="draft-cover" alt="Cover"></div>'
      : '<div class="cover-lg"><span class="grid-placeholder">' + esc(d.title || '') + '</span></div>';
    var banner = '';
    if (existing) {
      if (kind === 'barcode') {
        banner = '<div class="own-banner" role="status">You already own this<span class="own-date">Added ' + esc(niceDate(existing.addedAt) || '') + '</span></div>';
      } else {
        banner = '<div class="own-banner" role="status">You may already own this: ' + esc(existing.title) + (existing.year ? ' (' + esc(existing.year) + ')' : '') + '</div>';
      }
      banner += '<button type="button" class="own-copy" data-action="open" data-id="' + esc(existing.id) + '" aria-label="View ' + esc(existing.title || 'DVD') + ' in your collection">' +
        (existing.hasCover
          ? '<img class="hit-thumb" alt="" data-existing-cover="' + esc(existing.id) + '">'
          : '<span class="hit-placeholder">' + esc((existing.title || '?').slice(0, 1).toUpperCase()) + '</span>') +
        '<span class="hit-main"><span class="hit-title">' + (esc(existing.title) || 'Untitled') + '</span>' +
        '<span class="hit-year">' + esc([existing.year || '', existing.addedAt ? ('Added ' + niceDate(existing.addedAt)) : ''].filter(Boolean).join(' · ')) + '</span></span></button>';
    }
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="' + (d.id ? 'detail' : 'home') + '">Back</button>' +
      '<h2>' + (existing ? 'Already owned' : 'Found') + '</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      banner +
      coverHtml +
      '<p class="found-title">' + (esc(d.title) || 'Untitled') + '</p>' +
      '<p class="found-year">' + esc(d.year || '') + '</p>' +
      '<button type="button" class="edit-link" data-action="edit-found">Not right? Edit</button>' +
      '</div>' +
      '<div class="footer"><div>' +
      (existing
        ? '<button type="button" class="btn-big" data-action="dont-add">Don&#39;t add</button>' +
          '<button type="button" class="btn-small" data-action="add-anyway">Add anyway</button>'
        : '<button type="button" class="btn-big" data-action="add">Add to collection</button>') +
      '</div></div>';
    if (d.coverBlob) document.getElementById('draft-cover').src = photoUrl(d.coverBlob);
    if (existing && existing.hasCover) {
      getCover(existing.id).then(function (blob) {
        var img = app.querySelector('[data-existing-cover]');
        if (img && blob) img.src = photoUrl(blob);
      });
    }
  }

  function renderDetail() {
    var r = dvds.filter(function (x) { return x.id === currentId; })[0];
    if (!r) return show('home');
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button><h2>DVD</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      '<div class="cover-lg">' + (r.hasCover ? '<img id="detail-cover" alt="Cover">' : '<span class="grid-placeholder">' + esc(r.title || '') + '</span>') + '</div>' +
      '<p class="found-title">' + (esc(r.title) || 'Untitled') + '</p>' +
      '<p class="found-year">' + esc(r.year || '') + '</p>' +
      '<div class="ro"><span class="k">Date added</span><span class="v">' + (esc(niceDate(r.addedAt)) || '—') + '</span></div>' +
      '<div class="ro"><span class="k">Barcode</span><span class="v">' + (esc(r.barcode) || '—') + '</span></div>' +
      '</div>' +
      '<div class="footer split"><div>' +
      '<button type="button" class="btn-small btn-danger" data-action="delete">Delete</button>' +
      '<button type="button" class="btn-big" data-action="edit-saved">Edit</button>' +
      '</div></div>';
    if (r.hasCover) {
      getCover(r.id).then(function (blob) {
        var img = document.getElementById('detail-cover');
        if (blob && img && view === 'detail' && currentId === r.id) img.src = photoUrl(blob);
      });
    }
  }

  function renderEdit() {
    var d = draft || {};
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="cancel-edit">Cancel</button>' +
      '<h2>Edit</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      (d.coverBlob ? '<div class="cover-lg"><img id="draft-cover" alt="Cover"></div>' : '') +
      '<div class="field"><label for="f-title">Title</label>' +
      '<input id="f-title" class="inp" type="text" autocomplete="off" value="' + esc(d.title || '') + '"></div>' +
      '<div class="field"><label for="f-year">Year</label>' +
      '<input id="f-year" class="inp" type="text" inputmode="numeric" maxlength="4" value="' + esc(d.year || '') + '"></div>' +
      '<div class="field"><label for="f-barcode">Barcode</label>' +
      '<input id="f-barcode" class="inp" type="text" inputmode="numeric" value="' + esc(d.barcode || '') + '"></div>' +
      '</div>' +
      '<div class="footer"><div><button type="button" class="btn-big" data-action="save-edit">Save</button></div></div>';
    if (d.coverBlob) document.getElementById('draft-cover').src = photoUrl(d.coverBlob);
  }

  function renderSettings() {
    var tmdbLine = '';
    // Show the TMDB credit only once TMDB is enabled (DvdLookup.TMDB_ENABLED).
    if (window.DvdLookup && DvdLookup.TMDB_ENABLED) {
      tmdbLine = '<p class="tmdb-credit">This product uses the TMDB API but is not endorsed or certified by TMDB.</p>';
    }
    var keyHint = githubToken ? 'Key saved on this phone. Paste a new one to replace it.' : 'Paste your key';
    var help = ghHelpOpen
      ? ('<ol class="gh-steps">' +
        '<li>On GitHub, open Settings, then Developer settings, then Fine-grained tokens, then Generate.</li>' +
        '<li>Under Repository access, choose Only select repositories and pick <strong>dvd-backup</strong>.</li>' +
        '<li>Under Repository permissions, set Contents to Read and write.</li>' +
        '<li>Set expiration to 1 year, then generate the key and copy it (GitHub only shows it once).</li>' +
        '<li>Paste the key here and tap Save.</li>' +
        '</ol>')
      : '';
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="home">Back</button>' +
      '<h2>Settings</h2><span class="spacer"></span></div>' +
      '<div class="settings">' +
      '<p class="note-line" id="backup-meta">' + esc(backupLabel()) + '</p>' +
      '<p class="note-line">' + dvds.length + (dvds.length === 1 ? ' DVD' : ' DVDs') + ' in your collection.</p>' +
      '<button type="button" class="btn-big" data-action="export-json">Export JSON backup</button>' +
      '<button type="button" class="btn-small" data-action="import-json">Import JSON</button>' +
      '<p class="note-line">Import adds titles you don\'t already have (matched by barcode or title) and leaves the ones already on this phone alone.</p>' +
      '<div class="gh-backup">' +
      '<h3>Back up to GitHub</h3>' +
      '<p class="note-line">Saves your list (not cover photos) to your private dvd-backup folder. Cover art is looked up again from the saved picture link. The key stays only on this phone, never in the public site.</p>' +
      '<button type="button" class="edit-link" data-action="toggle-gh-help">' + (ghHelpOpen ? 'Hide key steps' : 'How to make a key') + '</button>' +
      help +
      '<div class="field"><label for="gh-owner">Owner</label>' +
      '<input id="gh-owner" class="inp" type="text" autocomplete="off" spellcheck="false" value="' + esc(githubOwner || DEFAULT_OWNER) + '"></div>' +
      '<div class="field"><label for="gh-repo">Repository</label>' +
      '<input id="gh-repo" class="inp" type="text" autocomplete="off" spellcheck="false" value="' + esc(githubRepo || DEFAULT_REPO) + '"></div>' +
      '<div class="field"><label for="github-token">GitHub key</label>' +
      '<input id="github-token" class="inp" type="password" autocomplete="off" spellcheck="false" placeholder="' + esc(keyHint) + '" value="' + esc(tokenDraft) + '"></div>' +
      '<button type="button" class="btn-big" data-action="save-github">Save</button>' +
      '<button type="button" class="btn-small" data-action="github-backup">Back up now</button>' +
      '<button type="button" class="btn-small" data-action="github-restore">Restore from GitHub</button>' +
      '<button type="button" class="btn-small" data-action="forget-github">Forget key</button>' +
      '<p class="note-line' + (backupStatus ? ' gh-status-err' : '') + '" id="gh-status">' + esc(statusLine()) + '</p>' +
      '</div>' +
      '<div class="about">' +
      '<p>My DVDs keeps your list on this phone. Cover art and year may be looked up on Wikipedia.</p>' +
      tmdbLine +
      '</div></div>';
  }

  function renderRestore() {
    var movies = (restorePreview && restorePreview.movies) || [];
    var valid = !!(restorePreview && restorePreview.valid !== false);
    var n = movies.length;
    var canReplace = valid && n > 0;
    app.innerHTML =
      '<div class="topbar"><button type="button" class="link" data-action="settings">Back</button>' +
      '<h2>Restore</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      '<p class="msg">This backup has ' + n + ' movie' + (n === 1 ? '' : 's') + '.</p>' +
      '<p class="note-line">Merge keeps the movies already on this phone and adds any missing ones.' +
      (canReplace ? ' Replace uses the backup as the full list (movies only on this phone would be removed).' : '') +
      '</p>' +
      '</div>' +
      '<div class="footer"><div>' +
      '<button type="button" class="btn-big" data-action="restore-merge">Merge</button>' +
      (canReplace ? '<button type="button" class="btn-small" data-action="restore-replace">Replace</button>' : '') +
      '</div></div>';
  }


  // ---------- Actions ----------
  function blankDraft(extra) {
    return Object.assign({
      id: null,
      title: '',
      year: '',
      barcode: '',
      coverBlob: null,
      posterUrl: null,
      source: 'manual',
      tmdbId: null,
      addedAt: null,
      fromFound: false
    }, extra || {});
  }

  var lookupGen = 0;

  function onBarcode(code, force) {
    if (view !== 'scan' && !force) return;
    if (window.DvdScan) DvdScan.stopCamera();
    draft = blankDraft({ barcode: String(code || '').trim() });
    lookupGen += 1;
    var gen = lookupGen;
    show('looking');
    DvdLookup.lookupBarcode(draft.barcode).then(function (res) {
      if (gen !== lookupGen) return;
      if (!res || !res.ok) {
        var reason = (res && res.reason) || 'http';
        draft.missed = true;
        draft.missKind = reason;
        draft.missReason = DvdLookup.barcodeReasonText ? DvdLookup.barcodeReasonText(reason) : '';
        draft.canRetry = reason !== 'not_found' && reason !== 'invalid' && reason !== 'daily_limit';
        show('missed');
        return;
      }
      return lookupTitle(res.title, null, gen);
    });
  }

  function lookupTitle(title, year, gen) {
    if (gen && gen !== lookupGen) return Promise.resolve();
    if (view !== 'looking') show('looking');
    var keptCover = draft && draft.coverBlob;
    var barcode = draft && draft.barcode;
    var fromQueueId = draft && draft.fromQueueId;
    return DvdLookup.lookupMovie(title, year).then(function (res) {
      if (gen && gen !== lookupGen) return;
      draft = blankDraft({
        title: (res && res.title) || title,
        year: (res && res.year) || year || '',
        barcode: barcode || '',
        coverBlob: keptCover || (res && res.posterBlob) || null,
        posterUrl: res && res.posterUrl,
        source: (res && res.source) || 'manual',
        tmdbId: res && res.tmdbId,
        fromQueueId: fromQueueId || null
      });
      show('found');
    });
  }

  function readFormIntoDraft() {
    if (!draft) return;
    var t = document.getElementById('f-title');
    var y = document.getElementById('f-year');
    var b = document.getElementById('f-barcode');
    if (t) draft.title = t.value.trim();
    if (y) draft.year = y.value.trim();
    if (b) draft.barcode = b.value.trim();
  }

  function addDraft() {
    if (!draft || !draft.title) { toast('Please type a title'); return; }
    var dup = findDuplicate(draft.title, draft.year, draft.barcode, draft.id);
    if (dup && !draft.addAnyway) {
      show('found');
      return;
    }
    var fromQueueId = draft.fromQueueId;
    return saveNewMovie({
      title: draft.title,
      year: draft.year || '',
      barcode: draft.barcode || '',
      coverBlob: draft.coverBlob,
      source: draft.source || 'manual',
      tmdbId: draft.tmdbId || null,
      posterUrl: draft.posterUrl || null
    }).then(function (rec) {
      currentId = rec.id;
      toast('Added to your collection');
      if (fromQueueId) {
        return markQueueFound(fromQueueId, rec).then(function () { show('queue'); });
      }
      show('home');
    });
  }

  function saveNewMovie(fields) {
    var rec = {
      id: newId(),
      title: fields.title,
      year: fields.year || '',
      barcode: fields.barcode || '',
      addedAt: isoNow(),
      hasCover: !!fields.coverBlob,
      source: fields.source || 'manual',
      tmdbId: fields.tmdbId || null,
      posterUrl: fields.posterUrl || null
    };
    return saveDvd(rec, fields.coverBlob, !!fields.coverBlob).then(function () {
      dvds.push(rec);
      sortDvds();
      scheduleBackup();
      return rec;
    });
  }

  function saveEdit() {
    readFormIntoDraft();
    if (!draft || !draft.title) { toast('Please type a title'); return; }
    if (!draft.id) {
      draft.fromFound = true;
      show('found');
      return;
    }
    var dup = findDuplicate(draft.title, draft.year, draft.barcode, draft.id);
    if (dup) {
      toast('You already own “' + dup.item.title + '”');
      return;
    }
    var rec = dvds.filter(function (x) { return x.id === draft.id; })[0];
    if (!rec) return show('home');
    rec.title = draft.title;
    rec.year = draft.year || '';
    rec.barcode = draft.barcode || '';
    rec.hasCover = rec.hasCover || !!draft.coverBlob;
    return saveDvd(rec, draft.coverBlob, false).then(function () {
      currentId = rec.id;
      toast('Saved');
      scheduleBackup();
      show('detail');
    });
  }

  function confirmDelete() {
    var r = dvds.filter(function (x) { return x.id === currentId; })[0];
    if (!r) return;
    if (!window.confirm('Delete “' + r.title + '” from your collection?')) return;
    deleteDvd(r.id).then(function () {
      dvds = dvds.filter(function (x) { return x.id !== r.id; });
      toast('Deleted');
      scheduleBackup();
      show('home');
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
  function dataUrlToBlob(url) {
    return fetch(url).then(function (r) { return r.blob(); });
  }

  function exportJson() {
    var payload = { app: 'my-dvds', exportedAt: isoNow(), dvds: [] };
    var jobs = dvds.map(function (d) {
      var row = { id: d.id, title: d.title, year: d.year || '', barcode: d.barcode || '', addedAt: d.addedAt, source: d.source || '', tmdbId: d.tmdbId || null, posterUrl: d.posterUrl || null, cover: null };
      if (!d.hasCover) {
        payload.dvds.push(row);
        return Promise.resolve();
      }
      return getCover(d.id).then(function (blob) {
        if (!blob) { payload.dvds.push(row); return; }
        return blobToDataUrl(blob).then(function (url) {
          row.cover = url;
          payload.dvds.push(row);
        });
      });
    });
    return Promise.all(jobs).then(function () {
      // Keep the same order as the on-screen list.
      var order = {};
      dvds.forEach(function (d, i) { order[d.id] = i; });
      payload.dvds.sort(function (a, b) { return (order[a.id] || 0) - (order[b.id] || 0); });
      var text = JSON.stringify(payload, null, 2);
      var file = new File([text], 'dvds-' + todayIso() + '.json', { type: 'application/json' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: 'My DVDs backup' }).catch(function () { downloadFile(file); });
      }
      downloadFile(file);
    });
  }

  function downloadFile(file) {
    var a = document.createElement('a');
    var url = URL.createObjectURL(file);
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function importJson(file) {
    return file.text().then(function (text) {
      var data = JSON.parse(text);
      var rows = Array.isArray(data) ? data : (data && data.dvds) || [];
      var added = 0, skipped = 0, chain = Promise.resolve();
      rows.forEach(function (row) {
        chain = chain.then(function () {
          if (!row || !row.title) { skipped++; return; }
          if (findDuplicate(row.title, row.year, row.barcode, null)) { skipped++; return; }
          var rec = {
            id: (row.id && !dvds.some(function (d) { return d.id === row.id; })) ? row.id : newId(),
            title: String(row.title),
            year: row.year ? String(row.year) : '',
            barcode: row.barcode ? String(row.barcode) : '',
            addedAt: row.addedAt || isoNow(),
            hasCover: false,
            source: row.source || 'import',
            tmdbId: row.tmdbId || null,
            posterUrl: row.posterUrl || null
          };
          var coverP = Promise.resolve(null);
          if (row.cover && /^data:/i.test(row.cover)) coverP = dataUrlToBlob(row.cover);
          else if (row.posterUrl && window.DvdLookup && DvdLookup.downloadPoster) {
            coverP = DvdLookup.downloadPoster(row.posterUrl);
          }
          return coverP.then(function (blob) {
            rec.hasCover = !!blob;
            return saveDvd(rec, blob, !!blob).then(function () {
              dvds.push(rec);
              added++;
            });
          });
        });
      });
      return chain.then(function () {
        sortDvds();
        toast('Imported ' + added + (skipped ? (', skipped ' + skipped + ' already owned') : ''));
        if (added) scheduleBackup();
        show('settings');
      });
    }).catch(function () {
      toast('That file could not be read.');
    });
  }

  // ---------- GitHub backup (browser -> api.github.com, key only in Authorization) ----------
  function tokenLooksValid(t) {
    return /^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(String(t || '').trim());
  }
  function repoPathOk(s) {
    return /^[A-Za-z0-9_.-]+$/.test(String(s || ''));
  }
  function contentsUrl(owner, repo) {
    return GH_API + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/contents/dvds.json';
  }
  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var chunk = 0x8000, bin = '', i;
    for (i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    var clean = String(b64 || '').replace(/\s+/g, '');
    var bin = atob(clean);
    var bytes = new Uint8Array(bin.length), i;
    for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function isRateLimited(res) {
    if (!res) return false;
    if (res.status === 429) return true;
    if (res.status === 403) {
      var left = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
      if (left === '0') return true;
    }
    return false;
  }
  function githubErrorText(status, kind) {
    if (kind === 'offline') return "You're offline. Connect and try again.";
    if (kind === 'pending-offline') return "You're offline. We'll back up when you're back online.";
    if (kind === 'no-key') return 'Paste your key and tap Save first.';
    if (kind === 'bad-key') return 'That doesn\'t look like a GitHub key. It should start with github_pat_ or ghp_.';
    if (kind === 'bad-repo') return 'Check the owner and repository names.';
    if (status === 401) return 'Key expired or wrong, make a new one';
    if (kind === 'rate') return 'GitHub is asking us to wait. Try again in a few minutes.';
    if (status === 403 || status === 404) return "Key can't see the dvd-backup folder, check it's selected";
    return "Couldn't reach GitHub. Try again in a minute.";
  }
  function githubFetch(url, opts) {
    if (String(url).indexOf(GH_API + '/') !== 0) {
      return Promise.reject(new Error('bad-url'));
    }
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + githubToken
    };
    if (opts && opts.json) headers['Content-Type'] = 'application/json';
    return fetch(url, {
      method: (opts && opts.method) || 'GET',
      headers: headers,
      body: opts && opts.body ? opts.body : undefined
    });
  }
  function buildBackupPayload() {
    return {
      app: 'my-dvds',
      exportedAt: isoNow(),
      dvds: dvds.map(function (d) {
        return {
          id: d.id,
          title: d.title,
          year: d.year || '',
          barcode: d.barcode || '',
          addedAt: d.addedAt,
          source: d.source || '',
          tmdbId: d.tmdbId || null,
          posterUrl: d.posterUrl || null
        };
      })
    };
  }
  function setStatusAndRefresh(text) {
    backupStatus = text || '';
    var el = document.getElementById('gh-status');
    if (el) {
      el.textContent = statusLine();
      if (backupStatus) el.classList.add('gh-status-err');
      else el.classList.remove('gh-status-err');
    }
    var meta = document.getElementById('backup-meta');
    if (meta) meta.textContent = backupLabel();
  }
  function markPending(yes) {
    backupPending = !!yes;
    return setSetting('backupPending', backupPending).catch(function () {});
  }
  function scheduleBackup() {
    if (!githubToken) return;
    markPending(true);
    if (backupBusy) {
      changedDuringUpload = true;
      return;
    }
    clearTimeout(backupTimer);
    backupTimer = setTimeout(function () {
      runBackup({ auto: true });
    }, 5000);
  }
  function getRemoteBackup() {
    return githubFetch(contentsUrl(githubOwner, githubRepo)).then(function (res) {
      if (res.status === 404) return { missing: true, res: res };
      if (!res.ok) return { error: true, res: res };
      return res.json().then(function (data) {
        try {
          var parsed = JSON.parse(base64ToUtf8(data.content || ''));
          var movies = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.dvds) ? parsed.dvds : null);
          if (!movies) return { invalid: true, sha: data.sha, res: res };
          return { sha: data.sha, payload: parsed, movies: movies, res: res };
        } catch (e) {
          return { invalid: true, sha: data && data.sha, res: res };
        }
      });
    });
  }
  function putRemoteBackup(payload, sha) {
    var body = {
      message: 'Backup: ' + payload.dvds.length + ' movie' + (payload.dvds.length === 1 ? '' : 's'),
      content: utf8ToBase64(JSON.stringify(payload, null, 2))
    };
    if (sha) body.sha = sha;
    return githubFetch(contentsUrl(githubOwner, githubRepo), {
      method: 'PUT',
      json: true,
      body: JSON.stringify(body)
    });
  }
  function failFromRes(res) {
    return { status: res && res.status, kind: isRateLimited(res) ? 'rate' : '' };
  }
  function isVirginDevice() {
    return !lastBackupAt && !lastRestoreAt;
  }
  function wouldShrinkRemote(localN, remoteN) {
    if (remoteN == null || remoteN < 0) return false;
    if (remoteN > 0 && localN === 0) return true;
    return (remoteN - localN) > 3;
  }
  function restoreFirstMessage(n) {
    return 'Your backup on GitHub has ' + n + ' movie' + (n === 1 ? '' : 's') + '. Tap Restore, then Merge, first.';
  }
  function shrinkAutoMessage(localN, remoteN) {
    return 'This phone has ' + localN + ' movie' + (localN === 1 ? '' : 's') + ', but GitHub has ' + remoteN + '. Tap Back up now if you want to replace the backup.';
  }
  function putWithRetry(payload, sha) {
    return putRemoteBackup(payload, sha).then(function (res) {
      if (res.status === 409 || res.status === 422) {
        return getRemoteBackup().then(function (again) {
          if (again.error) throw failFromRes(again.res);
          if (again.missing) throw { status: 422 };
          return putRemoteBackup(payload, again.sha).then(function (res2) {
            if (!res2.ok) throw failFromRes(res2);
            return res2;
          });
        });
      }
      if (!res.ok) throw failFromRes(res);
      return res;
    });
  }
  function finishBusy(keepPending) {
    backupBusy = false;
    var needsAgain = changedDuringUpload;
    changedDuringUpload = false;
    if (needsAgain) keepPending = true;
    var p = markPending(!!keepPending);
    if (needsAgain) scheduleBackup();
    return p;
  }
  function runBackup(opts) {
    opts = opts || {};
    if (backupBusy) {
      markPending(true);
      changedDuringUpload = true;
      return Promise.resolve();
    }
    if (!githubToken) {
      if (!opts.auto) setStatusAndRefresh(githubErrorText(0, 'no-key'));
      return Promise.resolve();
    }
    if (!tokenLooksValid(githubToken)) {
      if (!opts.auto) setStatusAndRefresh(githubErrorText(0, 'bad-key'));
      return Promise.resolve();
    }
    if (!repoPathOk(githubOwner) || !repoPathOk(githubRepo)) {
      if (!opts.auto) setStatusAndRefresh(githubErrorText(0, 'bad-repo'));
      return Promise.resolve();
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      markPending(true);
      setStatusAndRefresh(githubErrorText(0, opts.auto ? 'pending-offline' : 'offline'));
      return Promise.resolve();
    }
    backupBusy = true;
    changedDuringUpload = false;
    if (!opts.auto) setStatusAndRefresh('');
    var payload = buildBackupPayload();
    var localN = payload.dvds.length;
    return getRemoteBackup().then(function (got) {
      if (got.error) throw failFromRes(got.res);
      var remoteN = got.missing ? 0 : (got.invalid ? null : (got.movies || []).length);
      if (!got.missing && !got.invalid && isVirginDevice() && remoteN > 0) {
        var freshMsg = restoreFirstMessage(remoteN);
        return finishBusy(false).then(function () {
          setStatusAndRefresh(freshMsg);
          toast(freshMsg);
        });
      }
      if (opts.auto && wouldShrinkRemote(localN, remoteN)) {
        return finishBusy(false).then(function () {
          setStatusAndRefresh(shrinkAutoMessage(localN, remoteN));
        });
      }
      if (!opts.auto && wouldShrinkRemote(localN, remoteN)) {
        backupBusy = false;
        var ok = window.confirm('GitHub has ' + remoteN + ' movies, this phone has ' + localN + '. Replace the backup with ' + localN + '?');
        if (!ok) {
          return finishBusy(false).then(function () {
            setStatusAndRefresh('Backup cancelled. Your GitHub backup was left as it was.');
          });
        }
        backupBusy = true;
      }
      var sha = got.missing ? null : got.sha;
      return putWithRetry(payload, sha);
    }).then(function (res) {
      if (!res) return;
      lastBackupAt = isoNow();
      backupStatus = '';
      return Promise.all([
        setSetting('lastBackupAt', lastBackupAt),
        finishBusy(false)
      ]).then(function () {
        setStatusAndRefresh('');
        if (view === 'settings') renderSettings();
        if (!opts.auto) toast('Backup saved');
      });
    }).catch(function (err) {
      var noStatus = !err || !err.status;
      var kind = (err && err.kind) || '';
      var keep = false;
      if (noStatus || kind === 'offline') {
        keep = true;
        kind = opts.auto ? 'pending-offline' : 'offline';
      }
      var msg = githubErrorText(err && err.status, kind);
      return finishBusy(keep).then(function () {
        setStatusAndRefresh(msg);
        if (!opts.auto) toast(msg);
      });
    });
  }
  function readGithubFields() {
    var o = document.getElementById('gh-owner');
    var r = document.getElementById('gh-repo');
    var t = document.getElementById('github-token');
    if (o && o.value.trim()) githubOwner = o.value.trim();
    if (r && r.value.trim()) githubRepo = r.value.trim();
    if (t) tokenDraft = t.value;
    if (t && t.value.trim()) return t.value.trim();
    return null;
  }
  function saveGithubSettings() {
    var typed = readGithubFields();
    if (!repoPathOk(githubOwner) || !repoPathOk(githubRepo)) {
      setStatusAndRefresh(githubErrorText(0, 'bad-repo'));
      return;
    }
    if (typed !== null) {
      if (!tokenLooksValid(typed)) {
        setStatusAndRefresh(githubErrorText(0, 'bad-key'));
        return;
      }
      githubToken = typed;
      tokenDraft = '';
    }
    if (!githubToken) {
      setStatusAndRefresh(githubErrorText(0, 'no-key'));
      return;
    }
    Promise.all([
      setSetting('githubToken', githubToken),
      setSetting('githubOwner', githubOwner),
      setSetting('githubRepo', githubRepo)
    ]).then(function () {
      backupStatus = '';
      toast('Key saved on this phone');
      renderSettings();
    });
  }
  function forgetGithubKey() {
    githubToken = '';
    tokenDraft = '';
    backupPending = false;
    backupStatus = '';
    changedDuringUpload = false;
    clearTimeout(backupTimer);
    Promise.all([
      setSetting('githubToken', ''),
      setSetting('backupPending', false)
    ]).then(function () {
      toast('Key forgotten on this phone');
      renderSettings();
    });
  }
  function startRestore() {
    readGithubFields();
    if (!githubToken) {
      setStatusAndRefresh(githubErrorText(0, 'no-key'));
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatusAndRefresh(githubErrorText(0, 'offline'));
      return;
    }
    setStatusAndRefresh('');
    getRemoteBackup().then(function (got) {
      if (got.missing) throw { status: 404 };
      if (got.error) throw failFromRes(got.res);
      if (got.invalid) {
        var invalidMsg = "This backup file doesn't look valid.";
        setStatusAndRefresh(invalidMsg);
        toast(invalidMsg);
        return;
      }
      restorePreview = { movies: got.movies || [], sha: got.sha, valid: true };
      show('restore');
    }).catch(function (err) {
      var kind = (err && err.kind) || (!err || !err.status ? 'offline' : '');
      var msg = githubErrorText(err && err.status, kind);
      setStatusAndRefresh(msg);
      toast(msg);
    });
  }
  function findLocalForRestore(row) {
    if (row && row.id) {
      var byId = dvds.filter(function (d) { return d.id === row.id; })[0];
      if (byId) return byId;
    }
    var nb = normalizeBarcode(row && row.barcode);
    if (!nb) return null;
    return dvds.filter(function (d) { return normalizeBarcode(d.barcode) === nb; })[0] || null;
  }
  function coverForRow(row, rec, keepLocalCover) {
    if (keepLocalCover) {
      return getCover(rec.id).then(function (blob) {
        if (blob) {
          rec.hasCover = true;
          return { rec: rec, blob: blob, coverChanged: false };
        }
        return fetchRestoreCover(row, rec);
      });
    }
    return fetchRestoreCover(row, rec);
  }
  function fetchRestoreCover(row, rec) {
    if (row && row.cover && /^data:/i.test(row.cover)) {
      return dataUrlToBlob(row.cover).then(function (blob) {
        rec.hasCover = !!blob;
        return { rec: rec, blob: blob, coverChanged: !!blob };
      });
    }
    if (row && row.posterUrl && window.DvdLookup && DvdLookup.downloadPoster) {
      return DvdLookup.downloadPoster(row.posterUrl).then(function (blob) {
        rec.hasCover = !!blob;
        return { rec: rec, blob: blob, coverChanged: !!blob };
      });
    }
    return Promise.resolve({ rec: rec, blob: null, coverChanged: false });
  }
  function buildRestoreRec(row, usedIds) {
    if (!row || !String(row.title || '').trim()) return null;
    var id;
    if (row.id && !usedIds[row.id]) id = String(row.id);
    else id = newId();
    usedIds[id] = true;
    return {
      id: id,
      title: String(row.title).trim(),
      year: row.year ? String(row.year) : '',
      barcode: row.barcode ? String(row.barcode) : '',
      addedAt: row.addedAt || isoNow(),
      hasCover: false,
      source: row.source || 'restore',
      tmdbId: row.tmdbId || null,
      posterUrl: row.posterUrl || null
    };
  }
  function prepareRestoreRows(movies) {
    var usedIds = {};
    var recs = [];
    var i, rec;
    for (i = 0; i < movies.length; i++) {
      rec = buildRestoreRec(movies[i], usedIds);
      if (!rec) return Promise.reject(new Error('invalid-record'));
      recs.push({ row: movies[i], rec: rec });
    }
    return Promise.all(recs.map(function (item) {
      return fetchRestoreCover(item.row, item.rec).then(function (got) {
        got.rec.hasCover = !!got.blob;
        return { rec: got.rec, blob: got.blob || null };
      });
    }));
  }
  function replaceAllDvds(rows) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(['dvds', 'covers'], 'readwrite');
        var dvdStore = t.objectStore('dvds');
        var coverStore = t.objectStore('covers');
        var settled = false;
        t.oncomplete = function () { if (!settled) { settled = true; resolve(); } };
        t.onerror = t.onabort = function () {
          if (!settled) { settled = true; reject(t.error || new Error('replace-aborted')); }
        };
        dvdStore.clear();
        coverStore.clear();
        rows.forEach(function (row) {
          dvdStore.put(row.rec);
          if (row.blob) coverStore.put({ id: row.rec.id, blob: row.blob });
        });
        if (failNextReplace) {
          failNextReplace = false;
          try { t.abort(); } catch (e) {}
        }
      });
    });
  }
  function markRestored() {
    lastRestoreAt = isoNow();
    return setSetting('lastRestoreAt', lastRestoreAt).catch(function () {});
  }
  function applyRestore(mode) {
    var movies = (restorePreview && restorePreview.movies) || [];
    var valid = !!(restorePreview && restorePreview.valid !== false);
    if (mode === 'replace') {
      if (!valid || !movies.length) {
        toast("That backup couldn't be used. Your list on this phone was not changed.");
        return;
      }
      var x = dvds.length;
      var n = movies.length;
      if (!window.confirm('Remove all ' + x + ' movies on this phone and use the ' + n + ' from the backup?')) {
        return;
      }
      return prepareRestoreRows(movies).then(function (rows) {
        return replaceAllDvds(rows).then(function () {
          dvds = rows.map(function (r) { return r.rec; });
          sortDvds();
          restorePreview = null;
          return markRestored().then(function () {
            toast('Replaced from backup');
            show('home');
          });
        });
      }).catch(function (err) {
        var msg = (err && err.message === 'invalid-record')
          ? "That backup couldn't be used. Your list on this phone was not changed."
          : "Replace didn't finish. Your list on this phone was left as it was.";
        toast(msg);
        backupStatus = msg;
        show('settings');
      });
    }
    // Merge: never deletes local items. Apply one-by-one; a mid-way
    // failure leaves everything already on this phone in place.
    var chain = Promise.resolve();
    movies.forEach(function (row) {
      chain = chain.then(function () {
        if (!row || !String(row.title || '').trim()) return;
        var existing = findLocalForRestore(row);
        if (existing) {
          existing.title = existing.title || String(row.title);
          existing.year = existing.year || (row.year ? String(row.year) : '');
          existing.barcode = existing.barcode || (row.barcode ? String(row.barcode) : '');
          existing.posterUrl = existing.posterUrl || row.posterUrl || null;
          existing.tmdbId = existing.tmdbId || row.tmdbId || null;
          return coverForRow(row, existing, true).then(function (got) {
            return saveDvd(got.rec, got.blob, got.coverChanged);
          });
        }
        var used = {};
        dvds.forEach(function (d) { used[d.id] = true; });
        var rec = buildRestoreRec(row, used);
        if (!rec) return;
        return coverForRow(row, rec, false).then(function (got) {
          return saveDvd(got.rec, got.blob, got.coverChanged).then(function () {
            dvds.push(got.rec);
          });
        });
      });
    });
    return chain.then(function () {
      sortDvds();
      restorePreview = null;
      return markRestored().then(function () {
        toast('Merged from backup');
        show('home');
      });
    }).catch(function () {
      toast("Merge didn't finish. Movies already on this phone were kept.");
      show('settings');
    });
  }

  // ---------- Events ----------
  app.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || !app.contains(btn)) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    if (action === 'home') return show('home');
    if (action === 'settings') return show('settings');
    if (action === 'scan') { scanError = ''; draft = null; return show('scan'); }
    if (action === 'batch-scan') { scanError = ''; batchStatus = ''; unlockAudio(); return show('batch-scan'); }
    if (action === 'queue') return show('queue');
    if (action === 'clear-finished') return clearFinishedQueue();
    if (action === 'queue-retry') return retryQueueItem(id);
    if (action === 'queue-remove') return removeQueueItem(id);
    if (action === 'queue-type-title') return typeTitleForQueue(id);
    if (action === 'clear-search') { query = ''; var s = document.getElementById('search'); if (s) s.value = ''; return renderResults(); }
    if (action === 'open') { currentId = id; return show('detail'); }
    if (action === 'type-title') {
      if (window.DvdScan) DvdScan.stopCamera();
      draft = blankDraft(draft && draft.barcode ? { barcode: draft.barcode } : {});
      return show('missed');
    }
    if (action === 'snap-cover') {
      if (window.DvdScan) DvdScan.stopCamera();
      coverInput.click();
      return;
    }
    if (action === 'retry-barcode') {
      if (draft && draft.barcode) return onBarcode(draft.barcode, true);
      return;
    }
    if (action === 'cancel-lookup') { lookupGen += 1; return show('home'); }
    if (action === 'lookup-title') {
      readFormIntoDraft();
      if (!draft || !draft.title) { toast('Please type a title'); return; }
      lookupGen += 1;
      return lookupTitle(draft.title, draft.year, lookupGen);
    }
    if (action === 'add') return addDraft();
    if (action === 'dont-add') { draft = null; return show('home'); }
    if (action === 'add-anyway') {
      if (draft) draft.addAnyway = true;
      return addDraft();
    }
    if (action === 'edit-found') { if (draft) draft.fromFound = true; return show('edit'); }
    if (action === 'edit-saved') {
      var r = dvds.filter(function (x) { return x.id === currentId; })[0];
      if (!r) return;
      draft = blankDraft({
        id: r.id, title: r.title, year: r.year, barcode: r.barcode, addedAt: r.addedAt,
        source: r.source, tmdbId: r.tmdbId, posterUrl: r.posterUrl
      });
      if (r.hasCover) {
        return getCover(r.id).then(function (blob) { draft.coverBlob = blob; show('edit'); });
      }
      return show('edit');
    }
    if (action === 'cancel-edit') {
      if (draft && draft.id) return show('detail');
      return show('found');
    }
    if (action === 'save-edit') return saveEdit();
    if (action === 'delete') return confirmDelete();
    if (action === 'detail') { if (draft && draft.id) currentId = draft.id; return show('detail'); }
    if (action === 'export-json') return exportJson();
    if (action === 'import-json') { importInput.click(); return; }
    if (action === 'toggle-gh-help') {
      readGithubFields();
      ghHelpOpen = !ghHelpOpen;
      return renderSettings();
    }
    if (action === 'save-github') return saveGithubSettings();
    if (action === 'github-backup') {
      readGithubFields();
      return runBackup({ auto: false });
    }
    if (action === 'github-restore') return startRestore();
    if (action === 'forget-github') return forgetGithubKey();
    if (action === 'restore-merge') return applyRestore('merge');
    if (action === 'restore-replace') return applyRestore('replace');
  });

  app.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'search') {
      query = e.target.value;
      var clear = document.querySelector('.search-clear');
      if (clear) clear.hidden = !query;
      renderResults();
    }
    if (e.target && e.target.id === 'github-token') {
      tokenDraft = e.target.value;
    }
  });

  app.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && (e.target.id === 'f-title' || e.target.id === 'f-year' || e.target.id === 'f-barcode')) {
      e.preventDefault();
      if (view === 'missed') {
        readFormIntoDraft();
        if (draft && draft.title) { lookupGen += 1; lookupTitle(draft.title, draft.year, lookupGen); }
      } else if (view === 'edit') {
        saveEdit();
      }
    }
  });

  coverInput.addEventListener('change', function () {
    var file = coverInput.files && coverInput.files[0];
    coverInput.value = '';
    if (!file) return;
    DvdLookup.downscaleFile(file, 400).then(function (blob) {
      draft = blankDraft({
        barcode: (draft && draft.barcode) || '',
        coverBlob: blob,
        source: 'snap'
      });
      show('missed');
    }).catch(function () { toast('Could not open that photo'); });
  });

  importInput.addEventListener('change', function () {
    var file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (file) importJson(file);
  });

  // ---------- Boot ----------
  function boot() {
    Promise.all([
      getAllDvds(),
      getSetting('lastBackupAt'),
      getSetting('githubToken'),
      getSetting('githubOwner'),
      getSetting('githubRepo'),
      getSetting('backupPending'),
      getSetting('lastRestoreAt'),
      getAllQueue().catch(function () { return []; })
    ]).then(function (got) {
      dvds = got[0] || [];
      sortDvds();
      lastBackupAt = got[1] || null;
      githubToken = got[2] || '';
      githubOwner = got[3] || DEFAULT_OWNER;
      githubRepo = got[4] || DEFAULT_REPO;
      backupPending = !!got[5];
      lastRestoreAt = got[6] || null;
      queueItems = got[7] || [];
      show('home');
      kickQueue();
      if (backupPending && githubToken) runBackup({ auto: true });
    }).catch(function () {
      dvds = [];
      show('home');
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }
  boot();
  window.addEventListener('online', function () {
    if (backupPending && githubToken) runBackup({ auto: true });
    resumeQueue('online');
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) resumeQueue('visible');
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
  }

  // Test hooks.
  window.DvdApp = {
    normalizeTitle: normalizeTitle,
    normalizeBarcode: normalizeBarcode,
    coreTitle: coreTitle,
    findDuplicate: findDuplicate,
    matches: matches,
    matchQuality: matchQuality,
    simulateBarcode: function (code) { return onBarcode(code, true); },
    enqueueBarcode: function (code) { return enqueueBarcode(code, { fromTest: true }); },
    setQueueTiming: function (opts) {
      if (!opts) return;
      if (opts.missGap != null) QUEUE_MISS_GAP = Number(opts.missGap);
      if (opts.busyBackoffs) QUEUE_BUSY = opts.busyBackoffs.slice();
    },
    pauseQueue: function () { queuePaused = true; if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; } },
    resumeQueue: function () { resumeQueue('test'); },
    getQueue: function () { return queueItems.map(function (i) { return Object.assign({}, i); }); },
    removeQueueItem: function (id) { return removeQueueItem(id); },
    clearFinishedQueue: function () { return clearFinishedQueue(); },
    dbClosedByVersionChange: function () { return dbClosedByVersionChange; },
    getQueueState: function () {
      return {
        pauseReason: pauseReason,
        pausedUntil: pausedUntil,
        dailyResetAt: dailyResetAt,
        lastMissAt: lastMissAt,
        busyStrike: busyStrike,
        running: queueRunning,
        paused: queuePaused,
        missGap: QUEUE_MISS_GAP,
        busyBackoffs: QUEUE_BUSY.slice(),
        waiting: queueCounts().waiting
      };
    },
    buildBackupPayload: buildBackupPayload,
    runBackup: function () { return runBackup({ auto: false }); },
    scheduleBackup: scheduleBackup,
    githubErrorText: githubErrorText,
    tokenLooksValid: tokenLooksValid,
    getBackupState: function () {
      return {
        owner: githubOwner,
        repo: githubRepo,
        hasToken: !!githubToken,
        lastBackupAt: lastBackupAt,
        lastRestoreAt: lastRestoreAt,
        backupPending: backupPending,
        backupStatus: backupStatus,
        backupBusy: backupBusy,
        changedDuringUpload: changedDuringUpload
      };
    },
    failNextReplace: function () { failNextReplace = true; }
  };
})();
