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

Diagnostics:

- `TEMPO_DIAGNOSTICS=1` opens DevTools.
- `SMARTSPECTRA_DIAGNOSTICS=1` turns on the SDK's IPC and frame-pump logging.
- Native SDK log lines (metric authorization, device keys, model load) always
  go to the terminal that ran `npm start`.
- At startup the app probes `physiology.presagetech.com`,
  `cont-api.physiology.presagetech.com`, and `medical.physiology.presagetech.com`
  and logs `[tempo] connectivity … -> HTTP <status>` or the exact network error.
  This distinguishes a local firewall/VPN/DNS problem from an SDK bug.
- `TEMPO_DISABLE_CARDIO=1` requests breathing metrics only, to isolate cardio
  authorization or device-key failures. It is a diagnostic switch, not the
  default.
- `TEMPO_DISABLE_GPU=1` disables Chromium hardware acceleration if the window
  or camera preview misbehaves on a particular Windows GPU driver.
- `TEMPO_CAMERA_WIDTH=640 TEMPO_CAMERA_HEIGHT=480` (optionally
  `TEMPO_CAMERA_FPS=30`) forces a host-acquired camera stream at that resolution
  for throughput diagnosis. The Session panel shows the measured frame rate
  from `frameSentThrough`, independent of the camera's nominal setting.
- `TEMPO_CAMERA_INDEX=0,1,…` selects a specific video input by the index logged
  in the event log — useful when Windows exposes an IR or virtual camera first.

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

## Runtime failure handling

Findings from the first Windows run and the fixes applied:

1. **"API key missing" while the build said the key was present.** The key was
   injected correctly (`scripts/build-renderer.mjs` → esbuild `define` →
   `API_KEY` in the bundle; verified with a dummy key). The banner was a CSS
   bug: `.banner { display: flex }` overrode the HTML `hidden` attribute, so the
   setup banner rendered even though `hidden` was set. A global
   `[hidden] { display: none !important; }` rule fixes all banners/panels.
2. **Metric request.** The UI now logs the requested bundle by SDK export name
   and code:
   `CHEST_BREATHING(0), ABDOMEN_BREATHING(1), BREATHING_RATE(2), PULSE_RATE(15), ARTERIAL_PRESSURE_TRACE(16), HRV(17)`.
   Every code is validated against `MetricType` from the installed 3.5.0 SDK;
   unsupported codes would be dropped and logged. All six are supported, so
   `cardioMetrics` is kept.
3. **`ConfigurationFailed` (3).** The native message and classification are now
   shown in the failure panel: authentication, metric authorization,
   model/device-key provisioning, invalid configuration, credit, network, or
   processing. If the full bundle fails with `kConfigurationFailed`, the app
   retries once with breathing only and reports the original native error; that
   mirrors the cardio failure mode documented by the official sample (cardio
   outputs need authorization/device keys). If the retry also fails, the full error is
   shown. `TEMPO_DISABLE_CARDIO=1` forces breathing-only from the first attempt.
4. **Camera `AbortError: Timeout starting video source`.** The SDK's default
   renderer acquisition uses `facingMode: 'user'`, which Windows desktop
   cameras do not reliably honour. If the default acquisition times out (or
   reports `NotReadableError`), the session retries once through the official
   `useMediaStream()` path with a host-acquired stream using only ideal
   width/height/fps — no facingMode. The event log lists detected video inputs
   and can distinguish permission denial, camera-in-use, timeout, and missing
   device. If the retry also fails, the camera failure is shown with that
   guidance.
5. **SustainedLowFrameRate (14).** The SDK stops when processed frames stay
   below its reliability threshold. The UI now classifies code 14 (and
   `kMetricNotAuthorized` 13) instead of reporting "unclassified", and shows the
   actual measured fps. Dim lighting, CPU contention, virtual cameras, and an
   open DevTools window can all lower effective throughput.
6. **Camera stays on after a mid-session error.** The renderer SDK's frame loop
   kept posting frames after the native session entered `kError`
   (`SmartSpectra is not in a valid state`), and the camera indicator stayed on.
   A fatal error now triggers one automatic SDK `reset()`: the frame pump stops,
   the SDK-owned stream is released, host streams are stopped, and the UI shows
   `camera released after SDK error`. The user can Start again.
6. **Black preview.** The renderer SDK releases its camera when `start()`
   fails, but the UI kept the old stream and the label "live". The panel now
   clears on `kError`, SDK errors, and fallback; listens for the preview track's
   `ended` event; logs `loadedmetadata`/`playing`; and shows `acquiring`,
   `live WxH`, `paused`, or `released` instead of assuming success.

Native log lines are not captured inside the renderer; they remain in the
main-process terminal and the failure panel tells the tester to read them.

### Blank window / boot failure

An empty DevTools DOM (`<html><head></head><body></body>`) means the page was
never parsed, not that a metric failed. `main.js` now:

- logs the absolute `index.html` path, its size, `did-finish-load`, and the
  final URL;
- reports `did-fail-load`, `preload-error`, `render-process-gone`, renderer
  `unresponsive`, and Chromium `child-process-gone` details to the terminal;
- shows a readable boot-failure page inside the window instead of leaving
  `about:blank`;
- binds the SmartSpectra IPC bridge only after `did-finish-load`, so a slow
  native `preconfigure()` cannot block the first paint.

Check the terminal for `[tempo] loading … (N bytes)` and
`[tempo] did-finish-load …`. If the build reports ~335 kB, it is the old bundle;
the current bundle is ~358 kB. A 335 kB build also still shows the old CSS
`[hidden]` bug (the API-key banner appears even when the key is present) and has
none of the camera retry or failure diagnostics in this document.

### Windows retest

```powershell
cd C:\path\to\tempo
Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
$env:SMARTSPECTRA_DIAGNOSTICS = "1"
$env:TEMPO_DIAGNOSTICS = "1"
npm start
```

Use the key from `.env`/`.env.local`, or set `$env:SMARTSPECTRA_API_KEY` in the
same shell. Check, in order:

1. Event log says `API key: present` and the setup banner is **not** shown.
2. Event log lists the six validated metric names/codes.
3. Camera panel reads `live WIDTHxHEIGHT` (not just "live").
4. If the default camera times out, the log shows `default camera acquisition
   failed … retrying with a host MediaStream without facingMode` and the video
   inputs it found. If that retry fails too, the failure panel explains
   permission denial, camera-in-use, timeout, or missing device.
5. If `ConfigurationFailed` occurs, an amber fallback banner appears with the
   native message, followed by a breathing-only retry. If the retry succeeds,
   real breathing metrics arrive; if it fails, the red failure panel shows the
   full message and classification.
6. **Copy details** in the failure panel captures code, kind, source, requested
   metrics, and the complete native message for the report.

To isolate cardio without relying on the fallback:

```powershell
$env:TEMPO_DISABLE_CARDIO = "1"
npm start
Remove-Item Env:TEMPO_DISABLE_CARDIO -ErrorAction SilentlyContinue
```

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
- `npm run build` produced `dist/renderer.bundle.js` (~358 kB) using only the
  official entry points (`/renderer`, `/messages`, `/main`, `/preload`).
- A dummy key (never a real key) was injected into the bundle to prove the
  `.env` → esbuild → renderer path; the emitted bundle contained the dummy
  value and `CARDIO_DISABLED`.
- `require('@smartspectra/node-sdk')` loads the native runtime successfully
  (Linux x64 sandbox) and reports SDK version 3.5.0.
- `decodeMetrics` was smoke-tested against a protobuf `Metrics` payload to
  confirm the field paths used by the UI (`breathing.rate`,
  `cardio.pulseRate`, `cardio.hrv`).
- A native probe with a fake key showed the cardio path's documented
  dependencies: `Metrics authorization failed`, `POST /device/pair failed`, and
  `LoadInternal failed for model_id=phasic-bp-inference`. This is why cardio
  configuration failures are classified and retried breathing-only.
- The metric resolver and failure classifier were bundled and executed: all
  six requested codes resolve, `[]` are unsupported, and auth/metric/model/
  config/processing messages classify to distinct kinds.
- `[hidden]` banner behavior and preview state transitions were verified by
  static inspection only; no display was available.

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
| `ConfigurationFailed (3)` | Native configuration rejection. The failure panel classifies it from the native message. If it happens with cardio, the app retries breathing-only; check the terminal for `Metrics authorization failed`, `Failed to load device keys`, or a model-load error. |
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
