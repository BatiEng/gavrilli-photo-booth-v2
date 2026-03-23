'use strict';

const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

let mainWindow;

// ─────────────────────────────────────────────
// Window creation
// ─────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Photo Booth',
    backgroundColor: '#0d0d0d',
    // Set to true for production kiosk use:
    // fullscreen: true,
    // kiosk: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Required so getUserMedia works on file:// origin
      webSecurity: false
    }
  });

  // Hide the menu bar (keeps Alt-show-menu behaviour on Windows/Linux)
  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadFile('index.html');

  // Uncomment for development:
  // mainWindow.webContents.openDevTools();
}

// ─────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  // Grant camera (media) permission unconditionally for the desktop kiosk
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => {
    callback(true);
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─────────────────────────────────────────────
// IPC: Print composed photo-strip image
// ─────────────────────────────────────────────
ipcMain.handle('print-image', async (_event, dataUrl) => {
  return new Promise((resolve, reject) => {
    // Create a hidden BrowserWindow just for printing
    const printWin = new BrowserWindow({
      width: 1000,
      height: 700,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    // Build a minimal HTML page that sizes itself exactly to the paper
    const printHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @page {
    /* 15.61 cm × 10.5 cm — already landscape ratio, no rotation needed */
    size: 156.1mm 105mm;
    margin: 0;
  }
  html, body {
    width:  156.1mm;
    height: 105mm;
    margin: 0;
    padding: 0;
    overflow: hidden;
    background: #fff;
  }
  img {
    display: block;
    width:  156.1mm;
    height: 105mm;
    object-fit: fill;
  }
</style>
</head>
<body>
  <img src="${dataUrl}">
</body>
</html>`;

    printWin.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(printHTML)
    );

    printWin.webContents.once('did-finish-load', () => {
      printWin.webContents.print(
        {
          silent: true,            // send directly to default printer
          printBackground: true,
          // Custom paper: 156.1 mm × 105 mm (values in microns)
          pageSize: {
            width:  156100,
            height: 105000
          },
          margins: { marginType: 'none' }
        },
        (success, errorType) => {
          setTimeout(() => printWin.close(), 500);
          if (success) {
            resolve(true);
          } else {
            reject(new Error(errorType || 'Print failed'));
          }
        }
      );
    });

    // Safety: close if load fails
    printWin.webContents.once('did-fail-load', (_e, code, desc) => {
      printWin.close();
      reject(new Error(`Load failed: ${desc}`));
    });
  });
});
