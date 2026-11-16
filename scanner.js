/* Barcode scanner for My DVDs.
   iPhone Safari has no BarcodeDetector, so we vendor zxing-wasm in ./vendor/
   and always load the .wasm from this same site (never a CDN). */
(function (global) {
  'use strict';

  var WASM_URL = new URL('./vendor/zxing_reader.wasm', document.baseURI).href;
  // DVDs use UPC-A (12) or EAN-13 (13); small cases sometimes UPC-E or EAN-8.
  var FORMATS = ['EAN-13', 'UPC-A', 'UPC-E', 'EAN-8'];
  var prepared = null;
  var stream = null;
  var video = null;
  var running = false;
  var busy = false;
  var raf = 0;
  var canvas = null;
  var onFound = null;
  var lastText = '';
  var lastAt = 0;

  function zx() {
    if (!global.ZXingWASM) return Promise.reject(new Error('Scanner library failed to load'));
    if (prepared) return prepared;
    // Override the library's default jsDelivr path so the wasm comes from ./vendor/.
    prepared = global.ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          if (/\.wasm$/.test(path)) return WASM_URL;
          return prefix + path;
        }
      },
      fireImmediately: true
    }).then(function () { return global.ZXingWASM; });
    return prepared;
  }

  // GS1 check digit (UPC-A, EAN-13, EAN-8 all use the same rule).
  function gs1Valid(d) {
    if (!/^\d{8}$|^\d{12,13}$/.test(d)) return false;
    var sum = 0, i, n, w;
    for (i = d.length - 2, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) {
      n = d.charCodeAt(i) - 48;
      sum += n * w;
    }
    return (10 - (sum % 10)) % 10 === d.charCodeAt(d.length - 1) - 48;
  }

  // UPC-E (8 digits: number system, 6 digits, check) -> 12-digit UPC-A.
  function upcEtoA(e) {
    if (!/^[01]\d{7}$/.test(e)) return '';
    var ns = e[0], d = e.slice(1, 7), ck = e[7], last = d[5], body;
    if (last <= '2') body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
    else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
    else body = d.slice(0, 5) + '0000' + last;
    return ns + body + ck;
  }

  // Turns a raw read into the barcode to look up, or '' if the check digit
  // is wrong (a misread: keep scanning instead of looking it up).
  // EAN-13 starting with 0 is the same product as its 12-digit UPC-A.
  function normalizeRead(text, format) {
    var d = String(text || '').replace(/\D/g, '');
    var f = String(format || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    // zxing usually reports UPC-E already expanded (12/13 digits); expand the
    // 8-digit form ourselves if it ever comes through short.
    if (d.length === 8 && (f === 'UPCE' || (/^[01]/.test(d) && f !== 'EAN8'))) {
      var a = upcEtoA(d);
      if (a && gs1Valid(a)) return a;
      if (f === 'UPCE') return '';
    }
    if (!gs1Valid(d)) return '';
    if (d.length === 13 && d[0] === '0') return d.slice(1);
    return d;
  }

  function asImageSource(source) {
    if (!source) return Promise.reject(new Error('No image'));
    if (typeof ImageData !== 'undefined' && source instanceof ImageData) return Promise.resolve(source);
    if (source instanceof Blob || (typeof File !== 'undefined' && source instanceof File)) return Promise.resolve(source);
    if (source instanceof HTMLCanvasElement) {
      var ctx = source.getContext('2d');
      return Promise.resolve(ctx.getImageData(0, 0, source.width, source.height));
    }
    if (source instanceof HTMLImageElement || (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap)) {
      var w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(source, 0, 0, w, h);
      return Promise.resolve(c.getContext('2d').getImageData(0, 0, w, h));
    }
    return Promise.resolve(source);
  }

  // Public entry used by the live camera and by tests (feed an EAN-13 image).
  function decodeFromImage(source) {
    return zx().then(function (mod) {
      return asImageSource(source).then(function (img) {
        return mod.readBarcodes(img, {
          formats: FORMATS,
          tryHarder: true,
          maxNumberOfSymbols: 1
        });
      });
    }).then(function (results) {
      var i, r, text, format;
      for (i = 0; i < (results || []).length; i++) {
        r = results[i];
        text = (r && (r.text || r.rawValue) || '').trim();
        if (r && r.isValid !== false && text) {
          format = r.format || r.symbology || '';
          var code = normalizeRead(text, format);
          if (!code) continue; // bad check digit: ignore this read
          return { text: code, raw: text, format: format };
        }
      }
      return null;
    });
  }

  function startCamera(videoEl, foundFn) {
    stopCamera();
    video = videoEl;
    onFound = foundFn;
    lastText = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var noCam = new Error('Camera not supported');
      noCam.kind = 'camera';
      return Promise.reject(noCam);
    }
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.setAttribute('playsinline', '');
      video.muted = true;
      return video.play();
    }, function (err) {
      var e = new Error((err && err.name) || 'Camera error');
      e.kind = 'camera';
      e.name = (err && err.name) || 'Error';
      throw e;
    }).then(function () {
      running = true;
      return zx().catch(function (err) {
        prepared = null; // allow a retry next time
        var e = new Error('Scanner library failed to load');
        e.kind = 'library';
        throw e;
      });
    }).then(function () {
      loop();
    });
  }

  function stopCamera() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    if (video) {
      try { video.pause(); } catch (e) {}
      video.srcObject = null;
      video = null;
    }
    onFound = null;
    busy = false;
  }

  function grabFrame() {
    if (!video || !video.videoWidth) return null;
    var w = video.videoWidth, h = video.videoHeight;
    var max = 720, scale = Math.min(1, max / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    if (!canvas) canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (busy) return;
    var frame = grabFrame();
    if (!frame) return;
    busy = true;
    decodeFromImage(frame).then(function (hit) {
      busy = false;
      if (!running || !hit || !onFound) return;
      var now = Date.now();
      if (hit.text === lastText && now - lastAt < 1500) return;
      lastText = hit.text;
      lastAt = now;
      onFound(hit);
    }).catch(function () { busy = false; });
  }

  global.DvdScan = {
    decodeFromImage: decodeFromImage,
    normalizeRead: normalizeRead,
    gs1Valid: gs1Valid,
    upcEtoA: upcEtoA,
    startCamera: startCamera,
    stopCamera: stopCamera,
    ready: zx,
    wasmUrl: WASM_URL
  };
})(window);
