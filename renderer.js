'use strict';

const CONFIG = {
  API_BASE:         'https://gavrilli.inovasyonbulutu.com/api',

  POS_URL:          'http://localhost:9373/start-sale',
  POS_PORT:         59000,
  POS_PAYMENT_TYPE: 'CreditCardPayment',
  POS_PRODUCT_NAME: 'Ürün Bedeli',
  POS_KDV:          10,

  POS_TIMEOUT_MS:   120_000,
};


const State = {
  promoCode:       null,   // string | null  — validated code
  promoDiscount:   null,   // { type:'percentage'|'fixed', value:number } | null
  photos:          [],     // array of JPEG dataURL strings (max 4)
  stream:          null,   // MediaStream | null
  audioCtx:        null,   // AudioContext | null
  isCapturing:     false,
  composedDataUrl: null,   // cached composed image dataURL
  photoPrice:      200,    // base price loaded from API at startup; fallback = 200
  sessionId:       null,   // hex string, generated at the start of each session
};

// ────────────────────────────────────────────
// Utility helpers
// ────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function $(id) { return document.getElementById(id); }

/** Generate a 32-char hex session ID using the Web Crypto API. */
function generateSessionId() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Format a price number as a Turkish lira string, e.g. ₺200,00 */
function fmtPrice(n) {
  return '₺' + Number(n).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

const beepCountdown = () => playTone(880,  180, 0.50, 'sine');
const beepShutter   = () => playTone(1500,  90, 0.55, 'square');
const beepBetween   = () => playTone(660,  160, 0.35, 'sine');

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
//  API helpers
// ================================================================

/**
 * Fetch the photo price from the backend settings API.
 * On any error, silently keeps State.photoPrice at its default (200).
 */
async function fetchPhotoPrice() {
  try {
    const res  = await fetch(`${CONFIG.API_BASE}/settings.php?public=1`);
    const data = await res.json();
    if (data.success && data.settings?.photo_price) {
      State.photoPrice = parseFloat(data.settings.photo_price) || 200;
    }
  } catch {
    // Offline / unreachable — keep default price, app still works
    console.warn('[fetchPhotoPrice] Backend unavailable, using default price:', State.photoPrice);
  }
}

/**
 * Apply a promo discount to the base price.
 * @returns {{ finalPrice: number, discountAmount: number }}
 */
function calcFinalPrice(originalPrice, promoDiscount) {
  if (!promoDiscount) {
    return { finalPrice: originalPrice, discountAmount: 0 };
  }

  let discountAmount = 0;
  if (promoDiscount.type === 'percentage') {
    discountAmount = originalPrice * (promoDiscount.value / 100);
  } else {
    // fixed TL amount
    discountAmount = promoDiscount.value;
  }

  // Clamp — can never exceed original price
  discountAmount = Math.min(discountAmount, originalPrice);

  return {
    finalPrice:     Math.round(Math.max(0, originalPrice - discountAmount) * 100) / 100,
    discountAmount: Math.round(discountAmount * 100) / 100,
  };
}

/**
 * Call the local POS device.
 * Uses the exact request shape from the integration spec.
 * @param {number} price  Final price in TL
 * @returns {Promise<object>}
 */
async function callPOS(price) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), CONFIG.POS_TIMEOUT_MS);

  try {
    const res = await fetch(CONFIG.POS_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      signal:  controller.signal,
      body:    JSON.stringify({
        port:     CONFIG.POS_PORT,
        odemeTip: CONFIG.POS_PAYMENT_TYPE,
        products: [{
          name:     CONFIG.POS_PRODUCT_NAME,
          price:    price,
          kdv:      CONFIG.POS_KDV,
          quantity: 1,
        }],
      }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`POS ${res.status}: ${txt || res.statusText}`);
    }

    return await res.json().catch(() => ({ status: 'success' }));

  } finally {
    clearTimeout(timer);
  }
}

/**
 * Persist the payment record to the backend.
 * Non-blocking — a backend failure never interrupts the photo booth UX.
 * (The POS has already charged the customer; saving to DB is best-effort.)
 */
async function savePayment({ originalPrice, discountAmount, finalPrice,
                              promoCode, posStatus, posResponse }) {
  try {
    await fetch(`${CONFIG.API_BASE}/payment.php?action=save`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        session_id:      State.sessionId,
        original_price:  originalPrice,
        discount_amount: discountAmount,
        final_price:     finalPrice,
        promo_code:      promoCode  || null,
        pos_status:      posStatus,
        pos_response:    posResponse || null,
      }),
    });
  } catch {
    console.warn('[savePayment] Backend unavailable — payment not recorded in DB.');
  }
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
  // ── Start a fresh session ─────────────────────────────────
  State.sessionId    = generateSessionId();
  State.promoCode    = null;
  State.promoDiscount = null;

  showScreen('screen-promo');

  const input     = $('promo-input');
  const errorEl   = $('promo-error');
  const btnSubmit = $('btn-promo-submit');
  const btnSkip   = $('btn-no-promo');

  // Reset UI
  input.value         = '';
  errorEl.textContent = '';
  btnSubmit.disabled  = false;
  btnSkip.disabled    = false;
  btnSubmit.textContent = 'Devam Et';
  input.focus();

  // ── Helper: advance to payment ────────────────────────────
  function goToPayment(code, discount) {
    State.promoCode     = code;
    State.promoDiscount = discount;

    const { finalPrice, discountAmount } = calcFinalPrice(State.photoPrice, discount);
    initPaymentScreen(finalPrice, State.photoPrice, discountAmount, code);
  }

  // ── "Devam Et" — validate promo with API ──────────────────
  btnSubmit.onclick = async () => {
    const code = input.value.trim().toUpperCase();
    if (!code) {
      errorEl.textContent = 'Lütfen bir promosyon kodu girin.';
      input.focus();
      return;
    }

    errorEl.textContent   = '';
    btnSubmit.disabled    = true;
    btnSkip.disabled      = true;
    btnSubmit.textContent = 'Kontrol ediliyor…';

    try {
      const res  = await fetch(`${CONFIG.API_BASE}/promo.php?action=validate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({ success: false, error: 'Geçersiz yanıt' }));

      if (!data.success) {
        errorEl.textContent = data.error || 'Geçersiz promosyon kodu.';
        input.select();
        input.focus();
        return;
      }

      // ✓ Valid — proceed with discount
      goToPayment(data.code, { type: data.discount_type, value: data.discount_value });

    } catch {
      errorEl.textContent = 'Sunucuya bağlanılamadı. Lütfen tekrar deneyin.';
      input.focus();
    } finally {
      btnSubmit.disabled    = false;
      btnSkip.disabled      = false;
      btnSubmit.textContent = 'Devam Et';
    }
  };

  // ── "Promosyon kodum yok" — full price, straight to payment ──
  btnSkip.onclick = () => {
    goToPayment(null, null);
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  btnSubmit.click();
    if (e.key === 'Escape') btnSkip.click();
  });
}

// ================================================================
//  SCREEN 2.5 — Payment
// ================================================================

/**
 * Update the payment screen to reflect the current flow state.
 *
 * @param {'processing'|'waiting'|'success'|'error'|'free'} state
 * @param {string} message    Primary status text
 * @param {string} subMessage Secondary (smaller) status text
 */
function setPaymentState(state, message = '', subMessage = '') {
  const spinner    = $('payment-spinner');
  const resultIcon = $('payment-result-icon');
  const statusEl   = $('payment-status');
  const actionsEl  = $('payment-actions');
  const subEl      = $('payment-sub');

  // ── Reset all visual state first ──────────────────────────
  spinner.style.display    = '';        // show spinner by default
  resultIcon.style.display = 'none';   // hide icon by default
  resultIcon.textContent   = '';
  resultIcon.className     = 'payment-result-icon';
  actionsEl.style.display  = 'none';   // hide buttons by default

  switch (state) {

    case 'processing':
      statusEl.textContent  = message || 'POS cihazına bağlanılıyor…';
      break;

    case 'waiting':
      statusEl.textContent  = message || 'Lütfen kartınızı okutun…';
      break;

    case 'success':
      spinner.style.display      = 'none';
      resultIcon.style.display   = '';
      resultIcon.textContent     = '✓';
      resultIcon.classList.add('payment-result-icon--success');
      statusEl.textContent       = message || 'Ödeme başarılı!';
      break;

    case 'free':
      spinner.style.display      = 'none';
      resultIcon.style.display   = '';
      resultIcon.textContent     = '🎉';
      statusEl.textContent       = message || 'Ücretsiz fotoğraf!';
      break;

    case 'error':
      spinner.style.display      = 'none';
      resultIcon.style.display   = '';
      resultIcon.textContent     = '✗';
      resultIcon.classList.add('payment-result-icon--error');
      statusEl.textContent       = message || 'Ödeme başarısız';
      actionsEl.style.display    = 'flex'; // show Retry / Back buttons
      break;
  }

  if (subEl) subEl.textContent = subMessage;
}

/**
 * Entry point for the payment screen.
 *
 * @param {number} finalPrice      Price to charge (0 = free)
 * @param {number} originalPrice   Base price before discount
 * @param {number} discountAmount  How much was discounted
 * @param {string|null} promoCode  The validated promo code (or null)
 */
async function initPaymentScreen(finalPrice, originalPrice, discountAmount, promoCode) {
  showScreen('screen-payment');

  // ── Populate price breakdown card ─────────────────────────
  $('payment-original-val').textContent = fmtPrice(originalPrice);
  $('payment-final-val').textContent    = fmtPrice(finalPrice);
  $('payment-title').textContent        = finalPrice === 0 ? 'Ücretsiz Fotoğraf' : 'Ödeme';

  const discountRow = $('payment-discount-row');
  if (discountAmount > 0) {
    $('payment-discount-val').textContent = '−' + fmtPrice(discountAmount);
    discountRow.style.display = '';
  } else {
    discountRow.style.display = 'none';
  }

  // ── FREE photo — promo covers 100% of the price ───────────
  if (finalPrice === 0) {
    setPaymentState('free', 'Promosyon kodunuz tüm ücreti karşılıyor!');
    await savePayment({ originalPrice, discountAmount, finalPrice,
                        promoCode, posStatus: 'success' });
    await sleep(2000);
    initCaptureScreen();
    return;
  }

  // ── Paid photo — run POS flow ─────────────────────────────
  // Wire the "Geri" button (always goes back to promo screen)
  $('btn-payment-back').onclick = () => initPromoScreen();

  // Start the POS attempt
  await _runPOSAttempt(finalPrice, originalPrice, discountAmount, promoCode);
}

/**
 * Perform one POS attempt.
 * On error, shows the error state and wires the Retry button for another try.
 */
async function _runPOSAttempt(finalPrice, originalPrice, discountAmount, promoCode) {
  setPaymentState('processing', 'POS cihazına bağlanılıyor…');

  // Small settle delay so the screen transition is visible
  await sleep(350);
  setPaymentState('waiting', 'Lütfen kartınızı okutun…');

  try {
    const posResult = await callPOS(finalPrice);

    // ── POS reported success ──────────────────────────────────
    setPaymentState('success', 'Ödeme başarılı!');

    // Save to backend (non-blocking; POS already charged)
    await savePayment({ originalPrice, discountAmount, finalPrice,
                        promoCode, posStatus: 'success', posResponse: posResult });

    await sleep(1500);
    initCaptureScreen();

  } catch (err) {
    // ── POS failed / timeout ──────────────────────────────────
    console.error('[POS]', err);

    let msg = 'Ödeme gerçekleştirilemedi.';
    if (err.name === 'AbortError') {
      msg = 'POS cihazı yanıt vermedi (zaman aşımı).';
    } else if (err.message) {
      // Truncate long system errors for the kiosk display
      msg = err.message.length > 80 ? err.message.slice(0, 80) + '…' : err.message;
    }

    // Record failed attempt
    await savePayment({ originalPrice, discountAmount, finalPrice,
                        promoCode, posStatus: 'failed',
                        posResponse: { error: String(err.message) } });

    // Show error UI and wire Retry
    setPaymentState('error', msg, 'Tekrar denemek için "Tekrar Dene" butonuna basın.');

    $('btn-payment-retry').onclick = () =>
      _runPOSAttempt(finalPrice, originalPrice, discountAmount, promoCode);
  }
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

    setStatus('Hazır');
    await sleep(1200);

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

    await fullCountdown();
    await doCapture(0);

    // ── Photos 2–4: brief wait → single-beep signal → capture ──
    for (let i = 1; i < 4; i++) {
      setPhotoCounter(i + 1);
      setStatus('Sonraki poz…');
      await sleep(1600);

      await singleBeepCue();
      await doCapture(i);
    }
  } finally {
    State.isCapturing = false;
    stopCamera();
  }

  setStatus('Tamamlandı!');

  const pendingCompose = composePhotos();

  await sleep(600);
  initPreviewScreen(pendingCompose);
}

// ── 3-2-1 countdown with beeps ──
async function fullCountdown() {
  for (let n = 3; n >= 1; n--) {
    showCountdownNumber(n);
    await beepCountdown();
    await sleep(820);
  }
  hideCountdown();
}

// ── Single "1" cue before photos 2–4 ──
async function singleBeepCue() {
  showCountdownNumber(1);
  await beepBetween();
  await sleep(640);
  hideCountdown();
}

// ── Actual photo capture ──
async function doCapture(index) {
  const video   = $('camera-preview');
  const flashEl = $('flash-overlay');

  await beepShutter();
  triggerFlash(flashEl);

  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  // Capture in grayscale — applies to both preview and print
  ctx.filter = 'grayscale(1)';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.filter = 'none'; // reset for any future draws on this canvas

  const dataUrl = canvas.toDataURL('image/jpeg', 0.93);
  State.photos[index] = dataUrl;

  fillThumbnail(index, dataUrl);
  await sleep(200);
}

// ────────────────────────────────────────────
// Countdown / flash helpers
// ────────────────────────────────────────────
function showCountdownNumber(n) {
  const overlay = $('countdown-overlay');
  const numEl   = $('countdown-number');

  overlay.classList.remove('hidden');
  numEl.textContent = String(n);

  numEl.classList.remove('pop');
  void numEl.offsetWidth;
  numEl.classList.add('pop');

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
async function initPreviewScreen(pendingCompose = null) {
  showScreen('screen-preview');

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
//  SCREEN 5 — Print
// ================================================================
async function startPrintFlow() {
  showScreen('screen-printing');
  $('print-spinner').style.display = '';
  setPrintStatus('Yazdırılıyor…', false);

  try {
    const dataUrl = State.composedDataUrl;
    if (!dataUrl) throw new Error('Görüntü bulunamadı');

    setPrintStatus('Yazdırılıyor…', false);

    if (window.electronAPI && typeof window.electronAPI.printImage === 'function') {
      await window.electronAPI.printImage(dataUrl);
    } else {
      openBrowserPrint(dataUrl);
    }

    setPrintStatus('✓ Yazdırıldı!', true);
    $('print-spinner').style.display = 'none';

    // Auto-restart after 5 s
    setTimeout(() => {
      State.photos          = [];
      State.promoCode       = null;
      State.promoDiscount   = null;
      State.composedDataUrl = null;
      State.sessionId       = null;
      initStartScreen();
    }, 5000);

  } catch (err) {
    console.error('[Print]', err);
    $('print-spinner').style.display = 'none';
    setPrintStatus('Yazdırma hatası', true);
    $('printing-sub').textContent = err.message || 'Bilinmeyen hata';

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

  await new Promise((r) => setTimeout(r, 30));

  const W      = 1843;
  const H      = 1240;
  const MARGIN = 18;
  const H_GAP  = 5;
  const V_GAP  = 5;
  const FRAME  = 8;
  const COLS   = 4;
  const ROWS   = 2;

  const photoW = Math.floor((W - 2 * MARGIN - (COLS - 1) * H_GAP) / COLS);
  const photoH = Math.floor((H - 2 * MARGIN - (ROWS - 1) * V_GAP) / ROWS);

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#d8d8d8';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.restore();

  const rotated = images.map((img) => rotateImage(img, -90));

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = MARGIN + col * (photoW + H_GAP);
      const y = MARGIN + row * (photoH + V_GAP);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x, y, photoW, photoH);

      const px = x + FRAME;
      const py = y + FRAME;
      const pw = photoW - 2 * FRAME;
      const ph = photoH - 2 * FRAME;
      drawCropped(ctx, rotated[col], px, py, pw, ph);

      if (col === COLS - 1) {
        drawGavrilliWatermark(ctx, px, py, pw, ph);
      }
    }
  }

  return canvas;
}

function drawGavrilliWatermark(ctx, x, y, w, h) {
  const fontSize = Math.max(16, Math.round(h * 0.052));
  const padRight = Math.round(fontSize * 0.30);
  const padTop   = Math.round(fontSize * 0.50);

  ctx.save();

  ctx.translate(x + w - padRight, y + padTop);
  ctx.rotate(-Math.PI / 2);

  ctx.font         = `italic 700 ${fontSize}px Georgia, 'Times New Roman', serif`;
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'bottom';

  ctx.shadowColor   = 'rgba(0, 0, 0, 0.60)';
  ctx.shadowBlur    = Math.round(fontSize * 0.5);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.fillText('gavrilli', 0, 0);

  ctx.restore();
}

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

function drawCropped(ctx, src, dx, dy, dw, dh) {
  const srcW = src.naturalWidth  ?? src.width;
  const srcH = src.naturalHeight ?? src.height;

  const targetAR = dw / dh;
  const srcAR    = srcW / srcH;

  let sx, sy, sw, sh;

  if (srcAR > targetAR) {
    sh = srcH;
    sw = sh * targetAR;
    sx = (srcW - sw) / 2;
    sy = 0;
  } else {
    sw = srcW;
    sh = sw / targetAR;
    sx = 0;
    sy = (srcH - sh) / 2;
  }

  ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
}

// ================================================================
//  Initialise — fetch price first, then show start screen
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  fetchPhotoPrice().finally(() => initStartScreen());
});
