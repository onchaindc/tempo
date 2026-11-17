# TEMPO

An immersive, physiology-responsive digital environment powered by the Presage
SmartSpectra SDK.

This repository is at **milestone 1**: getting the official
`@smartspectra/node-sdk` working with a live camera and real decoded
measurements through an Electron app. There is no visual engine, auth,
database, or deployment setup yet, by design. The interface in this milestone
is a temporary diagnostic panel only.

## What this milestone does

- Electron desktop app (Windows x64 development target).
- Official Electron renderer integration: `@smartspectra/node-sdk/renderer`
  plus the package's preload bridge and `bindSmartSpectraIpc` in the main
  process — the same wiring as the official
  [electron-quickstart](https://github.com/Presage-Security/SmartSpectra/tree/main/nodejs/samples/electron-quickstart).
- Live camera preview from the SDK-acquired `MediaStream`.
- Requests the breathing bundle and the cardio bundle
  (`breathingMetrics` + `cardioMetrics`: chest breathing, abdomen breathing,
  breathing rate, pulse rate, arterial pressure trace, HRV).
- Handles `streamAvailable`, `processingStatus`, `validationStatus`, `metrics`,
  and `error` events.
- Decodes every real `metrics` packet with
  `decodeMetrics()` from `@smartspectra/node-sdk/messages`.
- Per-metric **unavailable / warming-up / valid** states based on the SDK's own
  sample presence and `stable` verdict.
- API key comes from a local environment variable. Nothing is hardcoded or
  committed.

No simulated measurements or mock data exist anywhere in this app.

## Requirements

| Requirement | Notes |
| --- | --- |
| Windows x64 | Target development environment. |
| Node.js 24 LTS | SDK requires Node >= 20; Node 24 is recommended. |
| Webcam | The SDK uses the default system camera. |
| Presage API key | From <https://physiology.presagetech.com/auth/login>. |

`npm install` downloads the SDK's native runtime for every supported platform
(a few hundred MB). That is expected; only `win32-x64` is loaded at runtime on
Windows.

## Setup

```bash
npm install
```

Create `.env` (or `.env.local`) in the project root:

```dotenv
SMARTSPECTRA_API_KEY=your_key_here
```

`.env`, `.env.local`, and `dist/` are gitignored. `SMARTSPECTRA_API_KEY` is the
only variable this milestone needs.

## Run

```bash
npm start
```

`npm start` bundles the renderer with esbuild, then launches Electron.

Flow:

1. Press **Start measurement**.
2. Electron grants camera permission to the local page (Windows also needs
   camera access enabled for desktop apps in Settings → Privacy → Camera).
3. The SDK opens the camera, emits `streamAvailable`, and the preview appears.
4. Validation hints update live until the face/lighting checks pass.
5. Breathing and cardio cards move from **unavailable** to **warming-up** to
   **valid** as real decoded samples with `stable: true` arrive.

`TEMPO_DIAGNOSTICS=1` opens DevTools and shows the SDK's IPC diagnostics.

### If Electron exits immediately (VS Code terminal)

VS Code integrated terminals export `ELECTRON_RUN_AS_NODE=1`, which makes
Electron behave like plain Node. Launch from a normal terminal, or:

```powershell
$env:ELECTRON_RUN_AS_NODE=$null
npm start
```

## API key handling (read this)

The official renderer SDK takes `apiKey` in the renderer process, so the key
cannot be read from the environment at runtime inside the sandboxed renderer.
`scripts/build-renderer.mjs` therefore reads `SMARTSPECTRA_API_KEY` from the
local environment (shell > `.env.local` > `.env`) and injects it with esbuild
`define` while bundling.

Consequences:

- The key never appears in tracked source files or commits.
- The key **is** embedded in the local, gitignored `dist/renderer.bundle.js`.
  Do not share or publish that file; rebuild after rotating the key.
- If the key is missing, the build prints a warning and the app opens with a
  setup banner and Start disabled. Nothing reaches the native SDK.

For a production build, move the key behind your own backend or OS credential
store before packaging the app.

## Integration choice: renderer vs headless

This app uses the **Electron renderer integration** (`useMediaStream` /
`streamAvailable`), which is the officially recommended Electron path. The SDK
acquires the default OS camera itself at 1280x720 / 30 fps and locks AE/AWB
once the graph is running.

`CameraSelection.default` belongs to the **headless** `useCamera()` path in the
main process. It is not used here because the renderer integration bypasses the
native front/back camera selection entirely — which also avoids the Windows
unreliability of front/back selection through that API. `CameraSelection` is not
exported from the renderer entry point.

## Metric states

| State | Meaning in this UI |
| --- | --- |
| `unavailable` | No sample for that metric in the latest decoded packet. Persistently empty cardio fields usually mean the API key is not provisioned for cardio metrics (the SDK omits unauthorized metrics silently). |
| `warming-up` | A real sample exists, but the SDK's `stable` flag is false: the estimator is still converging or confidence is below the accuracy threshold. |
| `valid` | A real sample exists with `stable: true` (confidence above the metric's accepted accuracy threshold). Confidence % is shown alongside. |

Stopping or resetting clears the cards so stale readings cannot be mistaken for
live ones.

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process: window, camera permission handler, IPC bridge via `bindSmartSpectraIpc`. |
| `src/sdk/vitals-session.js` | **The only module that touches the SDK.** Owns lifecycle (`start` / `stop` / `reset` / `destroy`), event subscriptions, packet decoding and normalization. TEMPO's visual engine can consume this module independently. |
| `src/renderer/main.js` | Temporary diagnostic UI: preview, statuses, measurement cards, event log. No SDK calls. |
| `index.html`, `styles.css` | Diagnostic shell and styles. |
| `scripts/build-renderer.mjs` | esbuild bundling + environment API key injection. |

The preload is the SDK's own bridge
(`require.resolve('@smartspectra/node-sdk/preload')`); this project does not add
a custom preload.

## Verified in this workspace

- `npm install` completed with `@smartspectra/node-sdk` **3.5.0** and the
  per-platform native packages (`win32-x64` included).
- `npm run build` produced `dist/renderer.bundle.js` (~335 kB) using only the
  official entry points (`/renderer`, `/messages`, `/main`, `/preload`).
- `require('@smartspectra/node-sdk')` loads the native runtime successfully
  (Linux x64 sandbox) and reports SDK version 3.5.0.
- `decodeMetrics` was smoke-tested against a protobuf `Metrics` payload to
  confirm the field paths used by the UI (`breathing.rate`,
  `cardio.pulseRate`, `cardio.hrv`).

**Not verified here:** the actual Electron window, camera acquisition, Presage
authentication, and live measurements. The workspace available to this session
has no display server or webcam, runs Linux rather than Windows, and its install
of the Electron runtime binary did not complete (the npm package and lockfile
installed normally). Those steps must be run on the Windows x64 machine with a
real key and camera. The first live run is the remaining acceptance step for
this milestone.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Setup banner: API key missing | Add `SMARTSPECTRA_API_KEY` to `.env` or `.env.local`, then restart with `npm start` (the bundle is rebuilt on every start). |
| `kAuthenticationFailed` | Wrong/expired key, or the key is not enabled for the requested metrics. Verify it at physiology.presagetech.com. |
| Cardio cards stay `unavailable` while breathing works | The API key is not provisioned for cardio outputs; the SDK omits unauthorized metrics without error. Request cardio access or test with breathing only. |
| `Refused to create a worker from 'blob:…'` | The page CSP must keep `worker-src 'self' blob:`. |
| `window.__smartspectraBridge is unavailable` | `webPreferences.preload` must resolve to `@smartspectra/node-sdk/preload`, with `bindSmartSpectraIpc(win)` called in the main process. |
| Black preview / no camera | Check the Windows camera privacy setting for desktop apps, close other apps holding the camera, and confirm the LED turns on. |
| App exits immediately | `ELECTRON_RUN_AS_NODE=1` in the VS Code terminal — see above. |

## References

- Docs: <https://smartspectra.presagetech.com/docs/nodejs/>
- API reference: <https://smartspectra.presagetech.com/docs/nodejs/api-reference/>
- Metrics: <https://smartspectra.presagetech.com/docs/nodejs/metrics/>
- Official Electron sample:
  <https://github.com/Presage-Security/SmartSpectra/tree/main/nodejs/samples/electron-quickstart>
