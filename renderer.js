'use strict';

// ================================================================
//  Photo Booth — Renderer Process
// ================================================================

// ────────────────────────────────────────────
// Global application state
// ────────────────────────────────────────────
const State = {
  promoCode:      null,       // string | null
  photos:         [],         // array of JPEG dataURL strings (max 4)
  stream:         null,       // MediaStream | null
  audioCtx:       null,       // AudioContext | null
  isCapturing:    false,
  composedDataUrl: null       // cached composed image dataURL
};

// ────────────────────────────────────────────
// Utility helpers
// ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function $(id) { return document.getElementById(id); }

// ────────────────────────────────────────────
// Audio — generated via Web Audio API (no files needed)
// ────────────────────────────────────────────
function getAudioCtx() {
  if (!State.audioCtx) {
    State.audioCtx = new AudioContext();
  }
  return State.audioCtx;
}

/**
 * Play a beep tone.
 * @param {number} freq      Hz
 * @param {number} duration  ms
 * @param {number} vol       0..1
 * @param {'sine'|'square'|'triangle'} type
 */
function playTone(freq = 880, duration = 180, vol = 0.45, type = 'sine') {
  return new Promise((resolve) => {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(
      0.001, ctx.currentTime + duration / 1000
    );

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration / 1000 + 0.05);
    osc.onended = resolve;
  });
}

// Countdown tick beep   (3-2-1)
const beepCountdown = () => playTone(880, 180, 0.5, 'sine');

// Camera-shutter sound  (higher, short)
const beepShutter    = () => playTone(1500, 90,  0.55, 'square');

// Between-shots signal  (softer)
const beepBetween    = () => playTone(660, 160, 0.35, 'sine');

// ────────────────────────────────────────────
// Screen management
// ────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => {
    s.classList.remove('active');
  });
  const target = $(id);
  if (target) target.classList.add('active');
}

// ================================================================
//  SCREEN 1 — Start
// ================================================================
function initStartScreen() {
  showScreen('screen-start');
  $('btn-start').onclick = () => initPromoScreen();
}

// ================================================================
//  SCREEN 2 — Promo Code
// ================================================================
function initPromoScreen() {
  showScreen('screen-promo');

  const input    = $('promo-input');
  const errorEl  = $('promo-error');
  const btnSubmit = $('btn-promo-submit');
  const btnSkip   = $('btn-no-promo');

  input.value = '';
  errorEl.textContent = '';
  input.focus();

  // Helper: advance to capture after storing promo
  function proceed(code) {
    State.promoCode = code || null;
    initCaptureScreen();
  }

  btnSubmit.onclick = () => {
    const code = input.value.trim().toUpperCase();
    if (!code) {
      errorEl.textContent = 'Lütfen bir promosyon kodu girin.';
      input.focus();
      return;
    }
    errorEl.textContent = '';

    // ── Promo validation (mocked) ──────────────────────────────
    // TODO: Replace with real API call / database lookup.
    // Any non-empty code is accepted for now.
    // ──────────────────────────────────────────────────────────
    proceed(code);
  };

  btnSkip.onclick = () => {
    // ── POS / Payment placeholder ──────────────────────────────
    // TODO: Integrate POS / payment terminal here before proceeding.
    // ──────────────────────────────────────────────────────────
    proceed(null);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnSubmit.click();
    if (e.key === 'Escape') btnSkip.click();
  });
}

// ================================================================
//  SCREEN 3 — Capture
// ================================================================
async function initCaptureScreen() {
  State.photos      = [];
  State.isCapturing = false;

  showScreen('screen-capture');

  // Reset counter + status
  $('photo-count').textContent = '1';
  setStatus('Kamera başlatılıyor…');

  // Reset thumbnails
  for (let i = 0; i < 4; i++) {
    const slot = $(`thumb-${i}`);
    slot.classList.remove('filled');
    slot.innerHTML = `<span class="thumb-num">${i + 1}</span>`;
  }

  // Hide overlays
  hideCountdown();
  hideFlash();

  // ── Start camera ─────────────────────────────────────────────
  try {
    // Camera device selection:
    //   facingMode: 'user'   → built-in front cam (default)
    //   deviceId: { exact: 'xxx' } → external cam (future config)
    State.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: false
    });

    const video = $('camera-preview');
    video.srcObject = State.stream;
    await video.play();

    // Let the camera warm up (auto-exposure settle)
    setStatus('Hazır');
    await sleep(1200);

    // ── Run the 4-shot capture sequence ──
    await runCaptureSequence();

  } catch (err) {
    console.error('[Camera]', err);
    setStatus('Hata!');
    const msg = err.name === 'NotAllowedError'
      ? 'Kamera erişimi reddedildi. Lütfen kamera iznini etkinleştirin.'
      : `Kamera açılamadı: ${err.message}`;
    alert(msg);
    initStartScreen();
  }
}

// ────────────────────────────────────────────
// Capture sequence
// ────────────────────────────────────────────
async function runCaptureSequence() {
  State.isCapturing = true;

  try {
    // ── Photo 1: full 3-2-1 countdown ──
    setPhotoCounter(1);
    setStatus('Pozisyon alın!');
    await sleep(600);

    await fullCountdown();       // shows 3 → 2 → 1 with beeps
    await doCapture(0);          // flash + capture

    // ── Photos 2–4: brief wait → single-beep signal → capture ──
    for (let i = 1; i < 4; i++) {
      setPhotoCounter(i + 1);
      setStatus('Sonraki poz…');
      await sleep(1600);          // pause so person can change pose

      await singleBeepCue();     // show "1" with beep
      await doCapture(i);
    }
  } finally {
    State.isCapturing = false;
    stopCamera();
  }

  setStatus('Tamamlandı!');

  // Composition başlıyor — kamera dururken, kullanıcı "Tamamlandı!" yazısını
  // görürken arka planda hazırlanıyor. Preview ekranına geçtiğinde zaten bitmiş olur.
  const pendingCompose = composePhotos();

  await sleep(600);
  initPreviewScreen(pendingCompose);
}

// ── 3-2-1 countdown with beeps ──
async function fullCountdown() {
  for (let n = 3; n >= 1; n--) {
    showCountdownNumber(n);
    await beepCountdown();   // ~180 ms
    await sleep(820);        // total ~1 s per digit
  }
  hideCountdown();
}

// ── Single "1" cue before photos 2–4 ──
async function singleBeepCue() {
  showCountdownNumber(1);
  await beepBetween();       // ~160 ms
  await sleep(640);          // total ~800 ms
  hideCountdown();
}

// ── Actual photo capture ──
async function doCapture(index) {
  const video  = $('camera-preview');
  const flashEl = $('flash-overlay');

  // Shutter sound + flash simultaneously
  await beepShutter();
  triggerFlash(flashEl);

  // Draw the video frame onto an offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  // Note: video preview is CSS-mirrored; we capture the RAW (non-mirrored)
  // frame so prints look natural. If you prefer mirrored prints, uncomment:
  //   ctx.translate(canvas.width, 0);
  //   ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.93);
  State.photos[index] = dataUrl;

  fillThumbnail(index, dataUrl);
  await sleep(200); // let flash finish
}

// ────────────────────────────────────────────
// Countdown / flash helpers
// ────────────────────────────────────────────
function showCountdownNumber(n) {
  const overlay = $('countdown-overlay');
  const numEl   = $('countdown-number');

  overlay.classList.remove('hidden');
  numEl.textContent = String(n);

  // Retrigger CSS animation
  numEl.classList.remove('pop');
  void numEl.offsetWidth; // force reflow
  numEl.classList.add('pop');

  // Restart the ring animation
  const ring = overlay.querySelector('.countdown-ring');
  if (ring) {
    ring.style.animation = 'none';
    void ring.offsetWidth;
    ring.style.animation = '';
  }
}

function hideCountdown() {
  $('countdown-overlay').classList.add('hidden');
}

function triggerFlash(el) {
  el.classList.remove('hidden', 'flashing');
  void el.offsetWidth;
  el.classList.add('flashing');
  // After animation ends, hide it
  el.addEventListener('animationend', () => {
    el.classList.add('hidden');
    el.classList.remove('flashing');
  }, { once: true });
}

function hideFlash() {
  const el = $('flash-overlay');
  el.classList.remove('flashing');
  el.classList.add('hidden');
}

// ────────────────────────────────────────────
// UI helpers for the capture screen
// ────────────────────────────────────────────
function setPhotoCounter(n) {
  $('photo-count').textContent = String(n);
}

function setStatus(msg) {
  const el = $('capture-status');
  if (el) el.textContent = msg;
}

function fillThumbnail(index, dataUrl) {
  const slot = $(`thumb-${index}`);
  if (!slot) return;
  slot.innerHTML = '';
  const img = document.createElement('img');
  img.src = dataUrl;
  img.alt = `Fotoğraf ${index + 1}`;
  slot.appendChild(img);
  slot.classList.add('filled');
}

function stopCamera() {
  if (State.stream) {
    State.stream.getTracks().forEach((t) => t.stop());
    State.stream = null;
  }
}

// ================================================================
//  SCREEN 4 — Preview  (shows final paper layout)
// ================================================================
//
// composePhotos() was already kicked off in runCaptureSequence during
// the "Tamamlandı!" pause, so by the time we reach here the promise
// is already resolved (or resolves in milliseconds).  No spinner needed.
//
async function initPreviewScreen(pendingCompose = null) {
  showScreen('screen-preview');

  // Disable buttons while we wait for the canvas (should be instant)
  $('btn-retake').disabled = true;
  $('btn-print').disabled  = true;

  try {
    const canvas = await (pendingCompose ?? composePhotos());
    State.composedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
    $('preview-composed').src = State.composedDataUrl;
  } catch (err) {
    console.error('[Compose preview]', err);
  }

  $('btn-retake').disabled = false;
  $('btn-print').disabled  = !State.composedDataUrl;

  $('btn-retake').onclick = () => {
    State.composedDataUrl = null;
    initCaptureScreen();
  };
  $('btn-print').onclick = () => startPrintFlow();
}

// ================================================================
//  SCREEN 5 — Print  (composition already done; just print the cached image)
// ================================================================
async function startPrintFlow() {
  showScreen('screen-printing');
  $('print-spinner').style.display = '';
  setPrintStatus('Yazdırılıyor…', false);

  try {
    // Re-use the image composed during the preview step
    const dataUrl = State.composedDataUrl;
    if (!dataUrl) throw new Error('Görüntü bulunamadı');

    setPrintStatus('Yazdırılıyor…', false);

    if (window.electronAPI && typeof window.electronAPI.printImage === 'function') {
      // ── Electron path: IPC → main process → system printer ──
      await window.electronAPI.printImage(dataUrl);
    } else {
      // ── Fallback for browser / dev mode: open print window ──
      openBrowserPrint(dataUrl);
    }

    setPrintStatus('✓ Yazdırıldı!', true);
    $('print-spinner').style.display = 'none';

    // Auto-restart after 5 s
    setTimeout(() => {
      State.photos         = [];
      State.promoCode      = null;
      State.composedDataUrl = null;
      initStartScreen();
    }, 5000);

  } catch (err) {
    console.error('[Print]', err);
    $('print-spinner').style.display = 'none';
    setPrintStatus('Yazdırma hatası', true);
    $('printing-sub').textContent = err.message || 'Bilinmeyen hata';

    // Allow user to go back after 3 s (preview already has the composed image)
    setTimeout(() => {
      showScreen('screen-preview');
      $('btn-retake').disabled = false;
      $('btn-print').disabled  = false;
    }, 3500);
  }
}

function setPrintStatus(msg, hideSub) {
  $('printing-status-text').textContent = msg;
  if (hideSub) $('printing-sub').textContent = '';
}

function openBrowserPrint(dataUrl) {
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return;
  win.document.write(`<!DOCTYPE html>
<html>
<head>
<style>
  @page { size: 156.1mm 105mm; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; width: 156.1mm; height: 105mm; object-fit: fill; }
</style>
</head>
<body>
  <img src="${dataUrl}" onload="window.print(); window.close();">
</body>
</html>`);
  win.document.close();
}

// ────────────────────────────────────────────
// Photo composition
// ────────────────────────────────────────────
/**
 * Compose 4 captured photos into a single canvas.
 *
 * Paper:  15.61 cm × 10.5 cm  (landscape)
 * Canvas: 1843 × 1240 px  (≈ 300 DPI)
 *
 * Layout:
 *   Row 1:  [photo 1] [photo 2] [photo 3] [photo 4]
 *   Row 2:  [photo 1] [photo 2] [photo 3] [photo 4]  (identical repeat)
 *
 * The physical paper will be cut in half after printing, yielding
 * two identical strips — one for the guest, one as a keepsake.
 */
async function composePhotos() {
  // ── Load all 4 images ──
  const images = await Promise.all(
    State.photos.map((url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => reject(new Error('Image load failed'));
        img.src = url;
      })
    )
  );

  // Browserın UI thread'ini serbest bırak (spinner'ın bir frame dönmesine izin ver)
  // Büyük canvas işlemleri main thread'i blokluyor — bu yield olmadan ekran donuyor.
  await new Promise((r) => setTimeout(r, 30));

  // ── Canvas dimensions (300 DPI equivalent) ──
  const W      = 1843;   // 15.61 cm × 118 px/cm  ≈ 1843
  const H      = 1240;   // 10.5  cm × 118 px/cm  ≈ 1240
  const MARGIN = 18;     // outer margin (all sides)
  const H_GAP  = 5;      // gap between photo slots
  const V_GAP  = 5;      // gap between rows
  const FRAME  = 8;      // white border inside each slot
  const COLS   = 4;
  const ROWS   = 2;

  const photoW = Math.floor((W - 2 * MARGIN - (COLS - 1) * H_GAP) / COLS);
  const photoH = Math.floor((H - 2 * MARGIN - (ROWS - 1) * V_GAP) / ROWS);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  // Light-gray background — makes the white frames pop
  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, W, H);

  // Faint dashed cut-line at vertical centre
  ctx.save();
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.restore();

  // Pre-rotate each source image by -90° (webcam captures landscape;
  // composition slots are portrait, so we rotate clockwise −90°).
  const rotated = images.map((img) => rotateImage(img, -90));

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = MARGIN + col * (photoW + H_GAP);
      const y = MARGIN + row * (photoH + V_GAP);

      // ── White frame ──
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, photoW, photoH);

      // ── Photo inset by frame width ──
      const px = x + FRAME;
      const py = y + FRAME;
      const pw = photoW - 2 * FRAME;
      const ph = photoH - 2 * FRAME;
      drawCropped(ctx, rotated[col], px, py, pw, ph);

      // ── "gavrilli" watermark — bottom row, last 2 photos ──
     if (col === COLS - 1) {
  drawGavrilliWatermark(ctx, px, py, pw, ph);
}
    }
  }

  return canvas;
}

/**
 * Draw the "gavrilli" brand text in white, rotated −90°,
 * anchored at the TOP-RIGHT corner of the photo image area.
 *
 * After rotate(−π/2):
 *   canvas +x → points UPWARD on screen
 *   canvas +y → points RIGHTWARD on screen
 *
 * textAlign:'right'  → text extends in −x direction → DOWNWARD on screen
 * textBaseline:'bottom' → glyphs sit above y=0 in rotated space → into the
 *                         photo (leftward / inward in screen space)
 *
 * Result: reading the photo normally the text appears vertical on the right
 * side. Tilt the photo 90° counter-clockwise and "gavrilli" reads normally.
 */
function drawGavrilliWatermark(ctx, x, y, w, h) {
  const fontSize = Math.max(16, Math.round(h * 0.052));
  const padRight = Math.round(fontSize * 0.30); // distance inward from right edge
  const padTop   = Math.round(fontSize * 0.50); // distance down from top edge

  ctx.save();

  // Move origin to top-right area of the photo, then rotate −90°
  ctx.translate(x + w - padRight, y + padTop);
  ctx.rotate(-Math.PI / 2);

  ctx.font         = `italic 700 ${fontSize}px Georgia, 'Times New Roman', serif`;
  ctx.textAlign    = 'right';    // 'i' at anchor, text grows downward on screen
  ctx.textBaseline = 'bottom';   // glyphs extend into the photo (inward direction)

  ctx.shadowColor   = 'rgba(0, 0, 0, 0.60)';
  ctx.shadowBlur    = Math.round(fontSize * 0.5);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillText('gavrilli', 0, 0);

  ctx.restore();
}

/**
 * Return a new <canvas> with `img` rotated by `degrees` clockwise.
 * Works for any angle; for ±90° the canvas dimensions are swapped.
 */
function rotateImage(img, degrees) {
  const rad    = (degrees * Math.PI) / 180;
  const abscos = Math.abs(Math.cos(rad));
  const abssin = Math.abs(Math.sin(rad));

  const srcW = img.naturalWidth  ?? img.width;
  const srcH = img.naturalHeight ?? img.height;

  const newW = Math.round(srcW * abscos + srcH * abssin);
  const newH = Math.round(srcW * abssin + srcH * abscos);

  const canvas = document.createElement('canvas');
  canvas.width  = newW;
  canvas.height = newH;

  const ctx = canvas.getContext('2d');
  ctx.translate(newW / 2, newH / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -srcW / 2, -srcH / 2);

  return canvas;
}

/**
 * Draw `src` (Image or Canvas) into the rectangle (dx, dy, dw, dh),
 * centre-cropping to match the target aspect ratio (object-fit: cover).
 */
function drawCropped(ctx, src, dx, dy, dw, dh) {
  // Support both HTMLImageElement (.naturalWidth) and HTMLCanvasElement (.width)
  const srcW = src.naturalWidth  ?? src.width;
  const srcH = src.naturalHeight ?? src.height;

  const targetAR = dw / dh;
  const srcAR    = srcW / srcH;

  let sx, sy, sw, sh;

  if (srcAR > targetAR) {
    // Source is wider → crop sides
    sh = srcH;
    sw = sh * targetAR;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    // Source is taller → crop top/bottom
    sw = srcW;
    sh = sw / targetAR;
    sx = 0;
    sy = (srcH - sh) / 2;
  }

  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

// ================================================================
//  Initialise
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  initStartScreen();
});
