/* Barcode scanner for My DVDs.
   iPhone Safari has no BarcodeDetector, so we vendor zxing-wasm in ./vendor/
   and always load the .wasm from this same site (never a CDN). */
(function (global) {
  'use strict';

  var WASM_URL = new URL('./vendor/zxing_reader.wasm', document.baseURI).href;
  var FORMATS = ['EAN-13', 'UPC-A'];
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
          return { text: text, format: format };
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
    }).then(function () {
      running = true;
      return zx();
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
    startCamera: startCamera,
    stopCamera: stopCamera,
    ready: zx,
    wasmUrl: WASM_URL
  };
})(window);
