// main.js
//
// Electron main process for TEMPO milestone 1.
//
// Responsibilities:
//   1. Create the diagnostic window and load the local page.
//   2. Grant camera permission to the bundled local page only.
//   3. Wire the SmartSpectra IPC bridge (renderer SDK <-> main process SDK).
//   4. Tear the SDK down with the window (handled by bindSmartSpectraIpc).
//
// This file mirrors the official electron-quickstart sample:
// https://github.com/Presage-Security/SmartSpectra/tree/main/nodejs/samples/electron-quickstart
// The API key is injected into the renderer bundle at build time from the
// local environment by scripts/build-renderer.mjs. It is never in this file.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');

// Opt-in verbose window/devtools for SDK diagnosis.
const DIAGNOSTICS = process.env.TEMPO_DIAGNOSTICS === '1';

// Some Windows GPU/driver combinations produce black previews or renderer
// instability in Chromium. Opt-in escape hatch, not the default.
if (process.env.TEMPO_DISABLE_GPU === '1') {
    app.disableHardwareAcceleration();
    console.warn('[tempo] TEMPO_DISABLE_GPU=1 — hardware acceleration disabled.');
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * If the real page cannot be loaded, show a readable diagnostic document
 * instead of leaving the window as a blank about:blank surface.
 */
function showBootFallback(win, detail) {
    if (win.isDestroyed()) return;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>TEMPO — boot failure</title>
<style>
  html,body{margin:0;height:100%;background:#0b0f14;color:#e6edf3;
    font:14px/1.6 "Segoe UI",system-ui,sans-serif}
  main{max-width:900px;margin:0 auto;padding:40px 24px}
  h1{font-size:20px;margin:0 0 8px}
  p{color:#8a99a8}
  pre{white-space:pre-wrap;word-break:break-word;background:#1c1111;color:#f0c9c7;
    border:1px solid #6b2f2d;border-radius:8px;padding:14px;font-size:12px}
</style>
</head>
<body><main>
  <h1>TEMPO could not load its interface</h1>
  <p>Electron never rendered <code>index.html</code>. The failure below is also
     printed in the terminal that ran <code>npm start</code>.</p>
  <pre>${escapeHtml(detail)}</pre>
  <p>Check that <code>index.html</code> exists beside <code>main.js</code>, that
     <code>dist/renderer.bundle.js</code> was built, and whether antivirus or a
     network-service crash is interfering with Electron.</p>
</main></body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error) => {
        console.error('[tempo] boot fallback failed to load:', error);
    });
}

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

    const indexPath = path.join(__dirname, 'index.html');
    let indexSize = 'MISSING';
    try {
        indexSize = `${fs.statSync(indexPath).size} bytes`;
    } catch (error) {
        console.error(`[tempo] index.html is missing at ${indexPath}: ${error.message}`);
    }
    console.log(`[tempo] loading ${indexPath} (${indexSize})`);

    let ipcBound = false;
    const bindIpcOnce = () => {
        if (ipcBound || win.isDestroyed()) return;
        ipcBound = true;
        try {
            // Bind after the page has painted so a slow native preconfigure()
            // can never leave the window blank while this process blocks.
            bindSmartSpectraIpc(win);
            console.log('[tempo] SmartSpectra IPC bridge bound');
        } catch (error) {
            console.error('[tempo] bindSmartSpectraIpc failed:', error);
        }
    };

    let fallbackShown = false;
    const showFallbackOnce = (detail) => {
        if (fallbackShown) return;
        fallbackShown = true;
        showBootFallback(win, detail);
    };

    win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        console.log(`[tempo] did-finish-load ${url}`);
        bindIpcOnce();
    });

    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrame) return;
        const detail =
            `did-fail-load ${errorCode}: ${errorDescription}\nURL: ${validatedURL}\nPath: ${indexPath}`;
        console.error(`[tempo] ${detail}`);
        showFallbackOnce(detail);
    });

    win.webContents.on('preload-error', (_event, preloadPath, error) => {
        console.error(`[tempo] preload-error ${preloadPath}:`, error);
    });

    win.webContents.on('render-process-gone', (_event, details) => {
        console.error('[tempo] render-process-gone:', details);
        showFallbackOnce(
            `Renderer process gone:\nreason: ${details.reason}\nexitCode: ${details.exitCode}`,
        );
    });

    win.webContents.on('unresponsive', () => {
        console.error('[tempo] renderer became unresponsive');
    });

    // The diagnostic page is the only page this window may ever show.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.loadFile(indexPath).catch((error) => {
        console.error('[tempo] loadFile failed:', error);
        showFallbackOnce(`loadFile failed: ${indexPath}\n${error && error.stack ? error.stack : error}`);
    });

    if (DIAGNOSTICS) {
        win.webContents.openDevTools({ mode: 'detach' });
    }

    return win;
}

app.whenReady().then(() => {
    // Grant only the camera (mediaTypes: ['video']) and only to the app's own
    // file:// page. Everything else is denied. The OS camera prompt and
    // indicator LED still behave normally.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = (details && details.requestingUrl) || (wc && wc.getURL()) || '';
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        const granted = permission === 'media' && cameraOnly && url.startsWith('file://');
        console.log(
            `[tempo] permission=${permission} mediaTypes=[${mediaTypes.join(',')}] ` +
            `url=${url} -> ${granted ? 'granted' : 'denied'}`,
        );
        callback(granted);
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Chromium's network service can crash independently of the renderer; report
// the reason so an empty window isn't mistaken for an HTML problem.
app.on('child-process-gone', (_event, details) => {
    console.error(`[tempo] child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
