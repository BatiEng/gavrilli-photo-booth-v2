'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, minimal API to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Send a composed photo-strip dataURL to the main process for printing.
   * @param {string} dataUrl  – JPEG/PNG data URL of the composed image
   * @returns {Promise<boolean>}
   */
  printImage: (dataUrl) => ipcRenderer.invoke('print-image', dataUrl),

  /** App version string */
  getVersion: () => ipcRenderer.invoke('get-version')
});
