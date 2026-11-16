/* My DVDs ("Do I own it?") — the app itself.
   Screens: Home (search + cover grid), Scan, Missed (type the title),
   Found (add / already own), Detail, Edit, Settings.
   The list and covers live in this phone's IndexedDB. A GitHub token, when
   pasted later, is also stored only here — never in the public site. */
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
  // dvds: the list. covers: JPEG blobs. settings: githubToken, lastBackupAt
  // (a token would live only in this settings store, never in the public site).
  var dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve, reject) {
        var req = indexedDB.open('my-dvds', 1);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('dvds')) d.createObjectStore('dvds', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('covers')) d.createObjectStore('covers', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings', { keyPath: 'key' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
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

  // ---------- App state ----------
  var dvds = [];
  var view = 'home';
  var query = '';
  var currentId = null;
  var draft = null;       // found / edit / type-title
  var scanError = '';
  var lastBackupAt = null;
  var githubToken = '';   // kept only in memory + IndexedDB, never exported
  var objectUrls = [];

  function sortDvds() {
    dvds.sort(function (a, b) {
      return (a.addedAt || '') < (b.addedAt || '') ? 1 : -1;
    });
  }
  function photoUrl(blob) {
    var u = URL.createObjectURL(blob); objectUrls.push(u); return u;
  }
  function show(next) {
    if (view === 'scan' && next !== 'scan' && window.DvdScan) DvdScan.stopCamera();
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
    if (view === 'looking') return renderLooking();
    if (view === 'missed') return renderMissed();
    if (view === 'found') return renderFound();
    if (view === 'detail') return renderDetail();
    if (view === 'edit') return renderEdit();
    if (view === 'settings') return renderSettings();
  }

  function backupLabel() {
    return lastBackupAt ? ('Last backed up: ' + niceDate(lastBackupAt)) : 'Last backed up: never';
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
    }).catch(function () {
      setScanError('Camera is not available. Snap the cover or type the title.');
    });
  }

  function setScanError(msg) {
    scanError = msg || '';
    var el = document.getElementById('scan-error');
    if (!el) return;
    el.textContent = scanError;
    el.hidden = !scanError;
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
      '<div class="topbar"><button type="button" class="link" data-action="scan">Back</button>' +
      '<h2>Add a title</h2><span class="spacer"></span></div>' +
      '<div class="form">' +
      '<p class="msg">' + (d.missed ? 'Couldn\'t find it. Type the title and we\'ll add it.' : 'Type the title and we\'ll add it.') + '</p>' +
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
      '<p class="soon">Coming soon. This will save your list to a private GitHub repository. The token stays only on this phone, never in the public site.</p>' +
      '<div class="field"><label for="github-token">GitHub token</label>' +
      '<input id="github-token" class="inp" type="password" autocomplete="off" spellcheck="false" placeholder="Paste token later" value="' + esc(githubToken || '') + '"></div>' +
      '<button type="button" class="btn-big" data-action="github-backup" disabled>Back up to GitHub</button>' +
      '</div>' +
      '<div class="about">' +
      '<p>My DVDs keeps your list on this phone. Cover art and year may be looked up on Wikipedia.</p>' +
      tmdbLine +
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
        draft.missed = true;
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
    return DvdLookup.lookupMovie(title, year).then(function (res) {
      if (gen && gen !== lookupGen) return;
      draft = blankDraft({
        title: (res && res.title) || title,
        year: (res && res.year) || year || '',
        barcode: barcode || '',
        coverBlob: keptCover || (res && res.posterBlob) || null,
        posterUrl: res && res.posterUrl,
        source: (res && res.source) || 'manual',
        tmdbId: res && res.tmdbId
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
    var rec = {
      id: newId(),
      title: draft.title,
      year: draft.year || '',
      barcode: draft.barcode || '',
      addedAt: isoNow(),
      hasCover: !!draft.coverBlob,
      source: draft.source || 'manual',
      tmdbId: draft.tmdbId || null
    };
    return saveDvd(rec, draft.coverBlob, !!draft.coverBlob).then(function () {
      dvds.push(rec);
      sortDvds();
      currentId = rec.id;
      toast('Added to your collection');
      show('home');
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
      var row = { id: d.id, title: d.title, year: d.year || '', barcode: d.barcode || '', addedAt: d.addedAt, source: d.source || '', tmdbId: d.tmdbId || null, cover: null };
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
            tmdbId: row.tmdbId || null
          };
          var coverP = Promise.resolve(null);
          if (row.cover && /^data:/i.test(row.cover)) coverP = dataUrlToBlob(row.cover);
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
        show('settings');
      });
    }).catch(function () {
      toast('That file could not be read.');
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
        source: r.source, tmdbId: r.tmdbId
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
    if (action === 'github-backup') return; // disabled placeholder; no GitHub calls
  });

  app.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'search') {
      query = e.target.value;
      var clear = document.querySelector('.search-clear');
      if (clear) clear.hidden = !query;
      renderResults();
    }
    if (e.target && e.target.id === 'github-token') {
      githubToken = e.target.value;
      // Persist on this phone only. Never written to the public site or the JSON export.
      setSetting('githubToken', githubToken).catch(function () {});
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
    Promise.all([getAllDvds(), getSetting('lastBackupAt'), getSetting('githubToken')]).then(function (got) {
      dvds = got[0] || [];
      sortDvds();
      lastBackupAt = got[1] || null;
      githubToken = got[2] || '';
      show('home');
    }).catch(function () {
      dvds = [];
      show('home');
    });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }
  boot();

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
    simulateBarcode: function (code) { return onBarcode(code, true); }
  };
})();
