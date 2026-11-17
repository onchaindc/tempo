// main.js
//
// Electron main process for TEMPO milestone 1.
//
// Responsibilities:
//   1. Create the diagnostic window.
//   2. Grant camera permission to the bundled local page only.
//   3. Wire the SmartSpectra IPC bridge (renderer SDK <-> main process SDK).
//   4. Tear the SDK down with the window (handled by bindSmartSpectraIpc).
//
// This file mirrors the official electron-quickstart sample:
// https://github.com/Presage-Security/SmartSpectra/tree/main/nodejs/samples/electron-quickstart
// The API key is injected into the renderer bundle at build time from the
// local environment by scripts/build-renderer.mjs. It is never in this file.

'use strict';

const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// Opt-in verbose window/devtools for SDK diagnosis.
const DIAGNOSTICS = process.env.TEMPO_DIAGNOSTICS === '1';

function createWindow() {
    const win = new BrowserWindow({
        width: 1180,
        height: 820,
        minWidth: 900,
        minHeight: 680,
        backgroundColor: '#0b0f14',
        title: 'TEMPO — SDK diagnostic',
        webPreferences: {
            // The package's preload exposes a tightly scoped bridge to the
            // renderer-side SDK. It is the only preload this app needs.
            preload: require.resolve('@smartspectra/node-sdk/preload'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
        },
    });

    // One SDK instance per renderer connection; released when the window closes.
    bindSmartSpectraIpc(win);

    // The diagnostic page is the only page this window may ever show.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.loadFile(path.join(__dirname, 'index.html'));

    if (DIAGNOSTICS) {
        win.webContents.openDevTools({ mode: 'detach' });
    }
}

app.whenReady().then(() => {
    // Grant only the camera (mediaTypes: ['video']) and only to the app's own
    // file:// page. Everything else is denied. The OS camera prompt and
    // indicator LED still behave normally.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        callback(permission === 'media' && cameraOnly && url.startsWith('file://'));
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
