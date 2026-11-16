/* Lookup layer for My DVDs.
   Barcode -> title and title -> cover/year go through this one module.

   Cloudflare Worker API (dvd-relay):
     GET {RELAY_URL}/upc?code=...
       -> { title, brand? }
     GET {RELAY_URL}/movie?title=...&year=...
       -> { title, year, posterUrl, tmdbId }

   Fallback order: relay (TMDB) first, then Wikipedia. If the relay is
   unreachable or a barcode isn't found, the app asks Daniel to type the title.

   Expected live URL: https://dvd-relay.williamsdan94.workers.dev
   (workers.dev subdomain exists; the Worker script is not live until
   Daniel verifies his Cloudflare email and the TMDB secret is set).

   The About screen shows the TMDB credit line when TMDB_ENABLED is true. */
(function (global) {
  'use strict';

  var RELAY_URL = 'https://dvd-relay.williamsdan94.workers.dev';
  var TMDB_ENABLED = true;

  var WIKI_SEARCH = 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=';
  var WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
  var POSTER_MAX_WIDTH = 400;
  var POSTER_HOSTS = { 'upload.wikimedia.org': true, 'en.wikipedia.org': true, 'image.tmdb.org': true };

  function relayOrigin() {
    return String(RELAY_URL || '').replace(/\/+$/, '');
  }

  function apiHeaders() {
    return { 'Accept': 'application/json', 'Api-User-Agent': 'MyDVDs/1.0 (personal DVD collection app)' };
  }

  // ----- Relay (stubbed while RELAY_URL is empty) -----

  // Relay requests must stay "simple" CORS requests: only safelisted headers.
  // (v1-4 sent Api-User-Agent here, the relay's preflight refused it, and
  // every barcode lookup from the phone failed.)
  function relayHeaders() {
    return { 'Accept': 'application/json' };
  }

  // Looks up a barcode. Returns { ok, title } or { ok:false, reason, code }.
  // reason is 'no-relay' | 'offline' | 'not_found' | 'busy' | 'upstream_busy' | 'daily_limit' |
  //           'invalid' | 'upstream' | 'http'.
  function lookupBarcode(code) {
    var digits = String(code || '').replace(/\D/g, '');
    var origin = relayOrigin();
    if (!origin) {
      return Promise.resolve({ ok: false, reason: 'no-relay', code: digits });
    }
    var url = origin + '/upc?code=' + encodeURIComponent(digits);
    return fetch(url, { headers: relayHeaders() }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) {
          if (!data || !data.title) return { ok: false, reason: 'not_found', code: digits };
          return { ok: true, title: String(data.title) };
        }
        var err = data && data.error;
        // The relay says who refused: UPCitemdb's shared free limit, or our own limiter.
        if (err === 'busy' && data && data.cause === 'upstream_busy') err = 'upstream_busy';
        var known = { not_found: 1, busy: 1, upstream_busy: 1, daily_limit: 1, invalid: 1, upstream: 1 };
        return { ok: false, reason: known[err] ? err : 'http', status: res.status, code: digits };
      });
    }).catch(function () {
      return { ok: false, reason: 'offline', code: digits };
    });
  }

  // Plain-English reason for the "Couldn't find it" screen.
  function barcodeReasonText(reason) {
    switch (reason) {
      case 'not_found': return 'This barcode isn\'t in the free barcode database.';
      case 'busy': return 'Too many scans in the last minute. Wait a minute and scan again.';
      case 'upstream_busy': return 'The free barcode database is busy right now. Wait a minute, then tap Try the lookup again, or type the title.';
      case 'daily_limit': return 'Daily lookup limit reached. Type the title, or scan again tomorrow.';
      case 'invalid': return 'That barcode number doesn\'t look valid. Check it against the case.';
      case 'upstream': return 'The barcode database had a problem. Try again in a minute.';
      case 'offline': return 'No connection to the lookup service. Check your internet and try again.';
      case 'no-relay': return 'Barcode lookup isn\'t set up.';
      default: return 'Lookup failed. Try again in a minute.';
    }
  }

  // Looks up cover art and year for a title. Tries the relay (TMDB) first
  // when configured, then Wikipedia (no key). Returns:
  // { ok, title, year, posterUrl, posterBlob, tmdbId, source }
  function lookupMovie(title, year) {
    var origin = relayOrigin();
    var typed = String(title || '').trim();
    if (!typed) return Promise.resolve({ ok: false, reason: 'empty', title: '', year: year || null });

    var start = Promise.resolve(null);
    if (origin) {
      var url = origin + '/movie?title=' + encodeURIComponent(typed);
      if (year) url += '&year=' + encodeURIComponent(year);
      start = fetch(url, { headers: relayHeaders() }).then(function (res) {
        if (!res.ok) return null;
        return res.json().then(function (data) {
          if (!data || !data.title) return null;
          return {
            ok: true,
            title: String(data.title),
            year: data.year ? String(data.year) : (year || null),
            posterUrl: data.posterUrl || null,
            tmdbId: data.tmdbId || null,
            source: 'tmdb'
          };
        });
      }).catch(function () { return null; });
    }

    return start.then(function (hit) {
      if (hit) {
        return downloadPoster(hit.posterUrl).then(function (blob) {
          hit.posterBlob = blob;
          return hit;
        });
      }
      return lookupWikipedia(typed, year);
    });
  }

  // ----- Wikipedia (no key, used now and as a backup later) -----

  function lookupWikipedia(title, yearHint) {
    var q = String(title || '').trim();
    var searchUrl = WIKI_SEARCH + encodeURIComponent(q + ' film') + '&limit=5';
    return fetch(searchUrl, { headers: apiHeaders() }).then(function (res) {
      if (!res.ok) throw new Error('search');
      return res.json();
    }).then(function (data) {
      var page = pickFilmPage((data && data.pages) || [], q);
      var key = page ? (page.key || page.title) : q;
      var summaryUrl = WIKI_SUMMARY + encodeURIComponent(String(key).replace(/ /g, '_'));
      return fetch(summaryUrl, { headers: apiHeaders() }).then(function (res) {
        if (!res.ok) throw new Error('summary');
        return res.json();
      });
    }).then(function (sum) {
      var year = yearFromText(sum.description, sum.extract) || yearHint || null;
      var posterUrl = (sum.originalimage && sum.originalimage.source) ||
        (sum.thumbnail && sum.thumbnail.source) || null;
      return downloadPoster(posterUrl).then(function (blob) {
        return {
          ok: true,
          title: (sum.title || q),
          year: year,
          posterUrl: posterUrl,
          posterBlob: blob,
          tmdbId: null,
          source: 'wikipedia',
          description: sum.description || ''
        };
      });
    }).catch(function () {
      // Offline or no match: still add the typed title; cover can fill in later.
      return {
        ok: false,
        reason: 'unavailable',
        title: q,
        year: yearHint || null,
        posterUrl: null,
        posterBlob: null,
        tmdbId: null,
        source: 'manual'
      };
    });
  }

  function pickFilmPage(pages, query) {
    if (!pages.length) return null;
    var want = String(query || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    function isFilm(p) {
      var d = ((p.description || '') + ' ' + (p.excerpt || '')).toLowerCase();
      if (/\b(soundtrack|album|disambiguation|song|novel|episode)\b/.test(d) && !/\bfilm\b/.test(d)) return false;
      if (/\b(may refer to|topics referred)\b/.test(d)) return false;
      return /\bfilm\b/.test(d) || /\b(19|20)\d{2}\b/.test(d);
    }
    var films = pages.filter(isFilm);
    var pool = films.length ? films : pages;
    for (var i = 0; i < pool.length; i++) {
      var t = String(pool[i].title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (t === want) return pool[i];
    }
    return pool[0];
  }

  // "2010 film by Christopher Nolan" or "Inception is a 2010 science fiction..."
  function yearFromText(description, extract) {
    var text = ((description || '') + ' ' + (extract || '')).replace(/\s+/g, ' ');
    var m = text.match(/\b((?:19|20)\d{2})\s+(?:[A-Za-z]+\s+){0,4}film\b/i) ||
      text.match(/\bfilm\b[^.]*?\b((?:19|20)\d{2})\b/i);
    if (m) return m[1];
    m = (description || '').match(/\b((?:19|20)\d{2})\b/);
    return m ? m[1] : null;
  }

  function allowedPosterUrl(url) {
    if (!url) return null;
    try {
      var u = new URL(url, 'https://en.wikipedia.org');
      if (u.protocol !== 'https:') return null;
      return POSTER_HOSTS[u.hostname] ? u.href : null;
    } catch (e) {
      return null;
    }
  }

  // Fetch a poster and store a downscaled JPEG blob (~400px wide) so the
  // cover grid still works offline.
  function downloadPoster(url) {
    var safe = allowedPosterUrl(url);
    if (!safe) return Promise.resolve(null);
    return fetch(safe).then(function (res) {
      if (!res.ok) return null;
      return res.blob();
    }).then(function (blob) {
      if (!blob) return null;
      return downscaleJpeg(blob, POSTER_MAX_WIDTH);
    }).catch(function () { return null; });
  }

  function loadImage(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('image')); };
      img.src = url;
    });
  }

  function downscaleJpeg(blob, maxW) {
    return loadImage(blob).then(function (got) {
      var img = got.img, w = img.naturalWidth, h = img.naturalHeight;
      var s = w > maxW ? (maxW / w) : 1;
      if (s > 1) s = 1;
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * s));
      c.height = Math.max(1, Math.round(h * s));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(got.url);
      return new Promise(function (resolve) {
        c.toBlob(function (out) { resolve(out || blob); }, 'image/jpeg', 0.85);
      });
    }).catch(function () { return blob && blob.type ? blob : null; });
  }

  // Also used when Daniel snaps the cover himself.
  function downscaleFile(file, maxW) {
    return downscaleJpeg(file, maxW || POSTER_MAX_WIDTH);
  }

  global.DvdLookup = {
    RELAY_URL: RELAY_URL,
    TMDB_ENABLED: TMDB_ENABLED,
    lookupBarcode: lookupBarcode,
    barcodeReasonText: barcodeReasonText,
    lookupMovie: lookupMovie,
    lookupWikipedia: lookupWikipedia,
    downloadPoster: downloadPoster,
    downscaleFile: downscaleFile,
    yearFromText: yearFromText,
    pickFilmPage: pickFilmPage
  };
})(window);
