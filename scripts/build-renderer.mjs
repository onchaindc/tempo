// scripts/build-renderer.mjs
//
// Bundles the renderer with esbuild (same approach as the official
// electron-quickstart, which also ships a CJS renderer bundle).
//
// The Presage API key is read from the local environment at build time and
// injected via esbuild `define`, so it never appears in a tracked source file.
// Precedence: real environment > .env.local > .env.
//
// dist/ is gitignored, but the key does end up inside the built bundle
// (dist/renderer.bundle.js) so the official renderer SDK can authenticate.
// Do not share that file; rebuild after changing the key.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'dist', 'renderer.bundle.js');

/** Minimal .env parser: KEY=VALUE, optional quotes, # comments. */
function parseEnvFile(file) {
    const values = {};
    if (!existsSync(file)) return values;

    for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const eq = line.indexOf('=');
        if (eq === -1) continue;

        const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
        if (!key) continue;

        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        values[key] = value;
    }
    return values;
}

function readLocalEnv() {
    const merged = {
        ...parseEnvFile(join(root, '.env')),
        ...parseEnvFile(join(root, '.env.local')),
    };

    // Values already exported in the shell win over files.
    for (const [key, value] of Object.entries(merged)) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

readLocalEnv();

const apiKey = (process.env.SMARTSPECTRA_API_KEY || '').trim();
// Diagnostic switch: request breathing only, to isolate cardio authorization
// or device-key provisioning failures from the rest of the pipeline.
const cardioDisabled = process.env.TEMPO_DISABLE_CARDIO === '1';

// Optional camera override for throughput diagnosis, e.g.
// TEMPO_CAMERA_WIDTH=640 TEMPO_CAMERA_HEIGHT=480 TEMPO_CAMERA_FPS=30.
const cameraWidth = Number.parseInt(process.env.TEMPO_CAMERA_WIDTH || '0', 10) || 0;
const cameraHeight = Number.parseInt(process.env.TEMPO_CAMERA_HEIGHT || '0', 10) || 0;
const cameraFps = Number.parseInt(process.env.TEMPO_CAMERA_FPS || '0', 10) || 0;
const cameraOverride =
    cameraWidth > 0 && cameraHeight > 0
        ? { width: cameraWidth, height: cameraHeight, fps: cameraFps > 0 ? cameraFps : 30 }
        : { width: 0, height: 0, fps: 0 };

if (cameraOverride.width > 0) {
    console.warn(
        `[tempo] camera override: ${cameraOverride.width}x${cameraOverride.height} @ ${cameraOverride.fps} fps`,
    );
}

if (cardioDisabled) {
    console.warn('[tempo] TEMPO_DISABLE_CARDIO=1 — requesting breathing metrics only.');
}

if (!apiKey) {
    console.warn(
        [
            '',
            '[tempo] SMARTSPECTRA_API_KEY is not set.',
            '        The app will open but measurement is disabled.',
            '        Fix: create .env (or .env.local) in the project root with:',
            '            SMARTSPECTRA_API_KEY=your_key_from_physiology.presagetech.com',
            '        then rebuild with `npm start`.',
            '',
        ].join('\n'),
    );
}

mkdirSync(dirname(outfile), { recursive: true });

await build({
    entryPoints: [join(root, 'src', 'renderer', 'main.js')],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    sourcemap: true,
    logLevel: 'info',
    define: {
        __SMARTSPECTRA_API_KEY__: JSON.stringify(apiKey),
        __TEMPO_DISABLE_CARDIO__: JSON.stringify(cardioDisabled),
        __TEMPO_CAMERA_OVERRIDE__: JSON.stringify(cameraOverride),
    },
});

console.log(`[tempo] renderer bundle -> ${outfile} (api key ${apiKey ? 'present' : 'MISSING'})`);
