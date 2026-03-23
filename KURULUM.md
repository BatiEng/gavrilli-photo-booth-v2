# Gavrilli Photo Booth — Windows Kurulum Rehberi

---

## A) Geliştirme modunda çalıştırma

### 1. Node.js kur (bir kez)
https://nodejs.org → LTS sürümünü indir ve kur.
Kurulumu doğrulamak için terminalde: `node -v` ve `npm -v`

### 2. Bağımlılıkları yükle (bir kez)
```
npm install
```

### 3. Uygulamayı başlat
```
npm start
```

---

## B) Kurulabilir .exe oluşturma

### 1. assets/icon.ico dosyasını ekle (isteğe bağlı)
`assets/` klasörüne 256×256 boyutunda bir `.ico` dosyası koy.
İcon yoksa build başarısız olur — `package.json` içindeki `"icon"` satırlarını silebilirsin.

### 2. Paketleme komutu
```
npm run dist
```

Bu komut `dist-build/` klasörüne şunları oluşturur:
- `Gavrilli Photo Booth Setup 1.0.0.exe` → kurulum sihirbazı
- Kurulum sessizce yapılır, masaüstüne kısayol eklenir.

### 3. Sadece klasör (kurulum olmadan test için)
```
npm run dist:dir
```
`dist-build/win-unpacked/` altında doğrudan çalıştırılabilir bir klasör oluşturur.

---

## C) Kiosk / tam ekran modu (kafe için)

`main.js` içinde bu satırları aktif et:
```js
fullscreen: true,
// kiosk: true,   // klavye/alt-tab tamamen kilitlemek için
```

---

## D) Varsayılan yazıcıyı ayarlama

Uygulama `silent: true` ile çalışır — yazdır butonuna basınca
sistem diyalogu açmadan doğrudan **varsayılan yazıcıya** gönderir.

Windows'ta varsayılan yazıcıyı ayarlamak için:
Ayarlar → Bluetooth ve aygıtlar → Yazıcılar → istediğin yazıcıya sağ tıkla → Varsayılan olarak ayarla

---

## E) Kamera seçimi (dış kamera)

`renderer.js` içinde kamera ayarı:
```js
// Şu an: yerleşik kamera
video: { facingMode: 'user' }

// Harici kamera için deviceId kullan:
video: { deviceId: { exact: 'KAMERA_ID' } }
```

Bağlı kamera ID'lerini listelemek için tarayıcı konsolunda:
```js
navigator.mediaDevices.enumerateDevices().then(d => console.log(d))
```
