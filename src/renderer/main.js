// src/renderer/main.js
//
// Temporary diagnostic UI for TEMPO milestone 1. It renders only real SDK
// events and decoded measurements — no simulated values anywhere.
// All SmartSpectra integration lives in ../sdk/vitals-session.js.

import {
    VitalsSession,
    SDK_VERSION,
    ProcessingStatus,
    ValidationCode,
    METRIC_STATE,
} from '../sdk/vitals-session.js';

// Injected by scripts/build-renderer.mjs from the local environment.
const API_KEY = __SMARTSPECTRA_API_KEY__;
const CARDIO_DISABLED = __TEMPO_DISABLE_CARDIO__;

const $ = (id) => document.getElementById(id);

const els = {
    status: $('status-badge'),
    setupBanner: $('setup-banner'),
    errorBanner: $('error-banner'),
    errorCode: $('error-code'),
    errorMessage: $('error-message'),
    fallbackBanner: $('fallback-banner'),
    fallbackMessage: $('fallback-message'),
    preview: $('preview'),
    previewPlaceholder: $('preview-placeholder'),
    previewState: $('preview-state'),
    validation: $('validation'),
    btnStart: $('btn-start'),
    btnStop: $('btn-stop'),
    btnReset: $('btn-reset'),
    btnClearLog: $('btn-clear-log'),
    btnCopyFailure: $('btn-copy-failure'),
    sdkVersion: $('sdk-version'),
    statPackets: $('stat-packets'),
    statLast: $('stat-last'),
    statMetrics: $('stat-metrics'),
    cardioNote: $('cardio-note'),
    failurePanel: $('failure-panel'),
    failureDetail: $('failure-detail'),
    log: $('event-log'),
};

const session = new VitalsSession({
    apiKey: API_KEY,
    cardio: !CARDIO_DISABLED,
});

let packetCount = 0;
let packetsWithCardio = 0;
let running = false;
let lastStatus = ProcessingStatus.kUninitialized;
let lastFailureText = '';

els.sdkVersion.textContent = SDK_VERSION;

// --- Logging ---------------------------------------------------------------

function clock(date = new Date()) {
    return date.toISOString().slice(11, 23);
}

function log(message, kind = 'info') {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = clock();
    const text = document.createElement('span');
    text.textContent = message;
    li.append(time, text);
    li.className = `log-${kind}`;
    els.log.prepend(li);
    while (els.log.children.length > 120) els.log.lastElementChild.remove();
}

els.btnClearLog.addEventListener('click', () => {
    els.log.replaceChildren();
});

// --- Metric rendering ------------------------------------------------------

function fmt(value, digits = 1) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function renderMeasurement(kind, sample) {
    const card = $(`metric-${kind}`);
    card.dataset.state = sample.state;
    $(`state-${kind}`).textContent = sample.state;

    const hasValue = sample.state !== METRIC_STATE.UNAVAILABLE;
    $(`value-${kind}`).textContent = hasValue ? fmt(sample.value) : '—';
    $(`confidence-${kind}`).textContent =
        typeof sample.confidence === 'number' ? `${sample.confidence.toFixed(0)}%` : '—';
    $(`stable-${kind}`).textContent = hasValue ? (sample.stable ? 'yes' : 'no') : '—';
}

function renderHrv(sample) {
    const card = $('metric-hrv');
    card.dataset.state = sample.state;
    $('state-hrv').textContent = sample.state;
    const hasValue = sample.state !== METRIC_STATE.UNAVAILABLE;
    $('value-hrv').textContent = hasValue ? fmt(sample.rmssd, 1) : '—';
    $('confidence-hrv').textContent =
        typeof sample.confidence === 'number' ? `${sample.confidence.toFixed(0)}%` : '—';
    $('stable-hrv').textContent = hasValue ? (sample.stable ? 'yes' : 'no') : '—';
}

function renderTraces(snapshot) {
    const chest = snapshot.chestTrace;
    const arterial = snapshot.arterialPressureTrace;

    const states = [chest.state, arterial.state];
    let combined = METRIC_STATE.UNAVAILABLE;
    if (states.includes(METRIC_STATE.VALID)) combined = METRIC_STATE.VALID;
    else if (states.includes(METRIC_STATE.WARMING_UP)) combined = METRIC_STATE.WARMING_UP;

    const card = $('metric-traces');
    card.dataset.state = combined;
    $('state-traces').textContent = combined;
    $('value-chest-trace').textContent = chest.state === METRIC_STATE.UNAVAILABLE ? '—' : fmt(chest.value, 3);
    $('value-arterial-trace').textContent =
        arterial.state === METRIC_STATE.UNAVAILABLE ? '—' : fmt(arterial.value, 3);
}

function clearMetrics() {
    for (const kind of ['breathing', 'pulse', 'hrv', 'traces']) {
        $(`metric-${kind}`).dataset.state = METRIC_STATE.UNAVAILABLE;
        $(`state-${kind}`).textContent = METRIC_STATE.UNAVAILABLE;
    }
    $('value-breathing').textContent = '—';
    $('value-pulse').textContent = '—';
    $('value-hrv').textContent = '—';
    $('value-chest-trace').textContent = '—';
    $('value-arterial-trace').textContent = '—';
    for (const kind of ['breathing', 'pulse', 'hrv']) {
        $(`confidence-${kind}`).textContent = '—';
        $(`stable-${kind}`).textContent = '—';
    }
    els.cardioNote.hidden = true;
}

// --- Camera / status -------------------------------------------------------

let previewTrack = null;

function onPreviewTrackEnded() {
    log('camera track ended — the SDK released the stream', 'warn');
    clearPreview('camera released');
}

function detachPreviewTrack() {
    if (!previewTrack) return;
    previewTrack.removeEventListener('ended', onPreviewTrackEnded);
    previewTrack = null;
}

function showPreview(stream) {
    detachPreviewTrack();
    els.preview.srcObject = stream;
    els.previewPlaceholder.hidden = true;
    els.previewState.textContent = 'acquiring';

    els.preview.onloadedmetadata = () => {
        const { videoWidth: width, videoHeight: height } = els.preview;
        log(`preview metadata ${width || '?'}x${height || '?'}`, 'ok');
        els.previewState.textContent = width && height ? `live ${width}x${height}` : 'live';
    };
    els.preview.onplaying = () => log('preview playing');
    els.preview.onerror = () => log('preview element reported a media error', 'error');

    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    previewTrack = track || null;
    if (previewTrack) previewTrack.addEventListener('ended', onPreviewTrackEnded);

    const settings = track && track.getSettings ? track.getSettings() : {};
    log(
        `stream acquired (${settings.width || '?'}x${settings.height || '?'} @ ${settings.frameRate || '?'} fps)`,
        'ok',
    );

    // Autoplay policy in Electron doesn't always honor <video autoplay> when
    // srcObject is assigned after load; start playback explicitly.
    els.preview.play().then(() => {
        if (els.preview.videoWidth && els.preview.videoHeight) {
            els.previewState.textContent = `live ${els.preview.videoWidth}x${els.preview.videoHeight}`;
        }
    }).catch((error) => {
        els.previewState.textContent = 'paused';
        log(`preview play() rejected: ${error.message}`, 'warn');
    });
}

function clearPreview(reason) {
    detachPreviewTrack();
    els.preview.onloadedmetadata = null;
    els.preview.onplaying = null;
    els.preview.onerror = null;
    els.preview.srcObject = null;
    els.previewPlaceholder.hidden = false;
    els.previewState.textContent = reason;
}

function updateButtons(status) {
    const isStarting = status === ProcessingStatus.kStarting;
    const isRunning = status === ProcessingStatus.kRunning;
    const isStopping = status === ProcessingStatus.kStopping;
    const isError = status === ProcessingStatus.kError;

    els.btnStart.disabled = !session.hasApiKey || isStarting || isRunning || isStopping;
    els.btnStop.disabled = !(isStarting || isRunning);
    els.btnReset.disabled = !(isError || status === ProcessingStatus.kIdle || status === ProcessingStatus.kUninitialized);
}

function setStatus(status) {
    els.status.textContent = status.label;
    els.status.className = `status status-${status.label.toLowerCase()}`;
    running = status.status === ProcessingStatus.kRunning;
    lastStatus = status.status;
    updateButtons(status.status);
    log(`processingStatus -> ${status.label} (${status.status})`);

    if (status.status === ProcessingStatus.kError) {
        // The renderer SDK releases its camera when start fails; without this
        // the panel kept saying "live" over a stopped (black) stream.
        clearPreview('released after SDK error');
    }
}

// --- Failure surfaces ------------------------------------------------------

const FAILURE_KIND_TEXT = {
    authentication: 'Authentication failure — the API key was rejected.',
    'metric-authorization':
        'Metric authorization failure — the key authenticated, but it is not entitled to one or more requested metrics.',
    'model-provisioning':
        'Model/device-key provisioning failure — an encrypted cardio model (for example arterial pressure) could not be loaded.',
    'invalid-configuration':
        'Invalid configuration — native ConfigurationFailed without a more specific metric or auth hint in the message.',
    'credit-exhausted': 'Credit exhausted — the Presage account has no measurement credit left.',
    network:
        'Network failure — the SDK could not reach the Presage service. Check VPN, proxy, and firewall access to Presage, then retry.',
    processing: 'Processing failure after the session started.',
    camera: 'Camera acquisition failure — the OS or another app prevented the camera from starting.',
    unknown: 'Unclassified SDK failure.',
};

function buildFailureDetail(failure) {
    const requested = session.requestedMetrics;
    return [
        `code: ${failure.label} (${failure.code})`,
        `kind: ${failure.kind}`,
        `source: ${failure.source}`,
        `retryable: ${failure.retryable}`,
        `requestedMetrics: ${requested.names.join(', ') || '(none)'}`,
        `cardioRequested: ${!CARDIO_DISABLED}`,
        `fallbackActive: ${session.fallbackActive}`,
        `apiKey: ${session.hasApiKey ? 'present' : 'missing'}`,
        '',
        'message:',
        failure.message,
    ].join('\n');
}

function recordFailureDetail(failure) {
    lastFailureText = buildFailureDetail(failure);
    els.failurePanel.hidden = false;
    els.failureDetail.textContent = lastFailureText;
}

function showFailure(failure, { releasePreview = true } = {}) {
    const kindText = FAILURE_KIND_TEXT[failure.kind] || FAILURE_KIND_TEXT.unknown;
    recordFailureDetail(failure);

    els.errorBanner.hidden = false;
    els.errorCode.textContent = `${failure.label} (${failure.code})`;
    els.errorMessage.textContent = `${kindText} ${failure.message}`;

    log(`error [${failure.source}] ${failure.label} (${failure.code}, ${failure.kind}): ${failure.message}`, 'error');
    console.error('[tempo] SDK failure', failure);

    if (releasePreview) clearPreview('released after SDK error');
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Electron gates navigator.clipboard on a permission; fall back to the
        // selection-based copy so diagnostics are still retrievable.
    }

    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        return copied;
    } catch {
        return false;
    }
}

els.btnCopyFailure.addEventListener('click', async () => {
    if (!lastFailureText) return;
    const copied = await copyText(lastFailureText);
    if (copied) log('failure details copied to clipboard');
    else log('copy failed: clipboard permission denied', 'warn');
});

// --- SDK events ------------------------------------------------------------

session.on('metricsRequest', ({ names, unsupported, cardio }) => {
    els.statMetrics.textContent = names.join(', ') || '(none)';
    log(`requestedMetrics (${names.length}${cardio ? ', breathing+cardio' : ', breathing only'}): ${names.join(', ')}`);
    if (unsupported.length > 0) {
        log(`dropped metric codes missing from this SDK: ${unsupported.join(', ')}`, 'warn');
    }
});

session.on('stream', showPreview);
session.on('processingStatus', setStatus);

session.on('validation', ({ code, label, hint }) => {
    els.validation.textContent = `${label}${hint ? ` — ${hint}` : ''}`;
    const kind =
        code === ValidationCode.kOk ? 'ok'
        : code === ValidationCode.kCameraTuning || code === ValidationCode.kFrameRateTooLow ? 'warn'
        : 'err';
    els.validation.className = `hint hint-${kind}`;
});

session.on('metrics', ({ snapshot, packetIndex, receivedAt }) => {
    packetCount += 1;
    els.statPackets.textContent = String(packetCount);
    els.statLast.textContent = clock(new Date(receivedAt));

    renderMeasurement('breathing', snapshot.breathingRate);
    renderMeasurement('pulse', snapshot.pulseRate);
    renderHrv(snapshot.hrv);
    renderTraces(snapshot);

    if (snapshot.cardioFieldsPresent) packetsWithCardio += 1;

    // Cardio metrics are omitted silently when the API key doesn't include
    // them; flag that after a reasonable number of packets.
    if (packetCount >= 20 && packetsWithCardio === 0 && running) {
        els.cardioNote.hidden = false;
    }

    if (packetCount <= 3 || packetCount % 30 === 0) {
        const b = snapshot.breathingRate;
        const p = snapshot.pulseRate;
        log(
            `metrics #${packetCount} (sdk packet ${packetIndex}): ` +
            `breathing ${b.state}${b.value != null ? ` (${b.value.toFixed(1)})` : ''}, ` +
            `pulse ${p.state}${p.value != null ? ` (${p.value.toFixed(1)})` : ''}`,
        );
    }
});

session.on('decodeError', ({ error, packetIndex }) => {
    showFailure({
        code: 'DECODE',
        label: 'decodeMetricsFailed',
        message: `packet #${packetIndex}: ${error.message}`,
        retryable: false,
        kind: 'unknown',
        source: 'decode',
    }, { releasePreview: false });
});

session.on('releasedAfterError', () => {
    clearPreview('camera released after SDK error');
    log('SDK entered an error state: stopped frames and released the camera', 'warn');
});

session.on('cameraRetry', ({ failure }) => {
    log(
        `default camera acquisition failed (${failure.message}); retrying with a host MediaStream ` +
        'without facingMode (Windows-safe)',
        'warn',
    );
});

session.on('cameraDevices', ({ cameras, constraints, error }) => {
    if (error) {
        log(`could not enumerate video devices: ${error}`, 'warn');
        return;
    }
    log(`video inputs (${cameras.length}): ${cameras.map((c) => c.label).join(' | ') || '(none reported)'}`);
    log(`host camera constraints: ${JSON.stringify(constraints.video)}`);
});

session.on('fallback', ({ failure }) => {
    // Keep the original ConfigurationFailed details copyable even though the
    // session is recovering with breathing only.
    recordFailureDetail(failure);
    els.fallbackBanner.hidden = false;
    els.fallbackMessage.textContent =
        `${failure.label} (${failure.code}) while requesting cardio. Retrying with breathing metrics only. ` +
        `Native detail: ${failure.message}`;
    clearPreview('restarting camera');
    log(
        `configuration failed with cardio (${failure.label} ${failure.code}); retrying breathing-only. ` +
        `Native detail: ${failure.message}`,
        'warn',
    );
});

session.on('error', (failure) => showFailure(failure));

// --- Controls --------------------------------------------------------------

async function startMeasurement() {
    if (!session.hasApiKey) {
        els.setupBanner.hidden = false;
        return;
    }

    els.errorBanner.hidden = true;
    els.setupBanner.hidden = true;
    els.fallbackBanner.hidden = true;
    packetCount = 0;
    packetsWithCardio = 0;
    els.statPackets.textContent = '0';
    els.statLast.textContent = '—';
    clearMetrics();
    els.btnStart.disabled = true;
    log('start() requested');

    try {
        await session.start();
    } catch (error) {
        // The session emits a structured 'error' event for SDK failures;
        // this is a fallback for failures that never reached the SDK.
        if (els.errorBanner.hidden) {
            showFailure({
                code: error.code || 'START',
                label: String(error.code || 'START'),
                message: error.message,
                retryable: false,
                kind: 'unknown',
                source: 'start',
            });
        }
        log(`start() failed: ${error.message}`, 'error');
        updateButtons(lastStatus);
    }
}

async function stopMeasurement() {
    els.btnStop.disabled = true;
    log('stop() requested');
    try {
        await session.stop();
    } catch {
        // Already surfaced through the session 'error' event.
    }
    clearPreview('released');
    clearMetrics();
}

async function resetSession() {
    els.btnReset.disabled = true;
    log('reset() requested');
    try {
        await session.reset();
    } catch (error) {
        log(`reset() failed: ${error.message}`, 'error');
    }
    els.errorBanner.hidden = true;
    els.fallbackBanner.hidden = true;
    clearPreview('released');
    clearMetrics();
}

els.btnStart.addEventListener('click', startMeasurement);
els.btnStop.addEventListener('click', stopMeasurement);
els.btnReset.addEventListener('click', resetSession);

// --- Boot ------------------------------------------------------------------

log(`API key: ${session.hasApiKey ? 'present' : 'MISSING'}`);
if (CARDIO_DISABLED) {
    log('TEMPO_DISABLE_CARDIO=1 — cardio bundle is disabled for this run', 'warn');
}

if (!session.hasApiKey) {
    els.setupBanner.hidden = false;
    els.btnStart.disabled = true;
    els.btnStart.title = 'SMARTSPECTRA_API_KEY is not set';
    log('SMARTSPECTRA_API_KEY missing — measurement disabled', 'error');
} else {
    log(`ready — SDK ${SDK_VERSION}`);
}

updateButtons(ProcessingStatus.kUninitialized);
clearMetrics();
els.statMetrics.textContent = session.requestedMetrics.names.join(', ');

// Release the renderer SDK bridge and the main-process SDK before teardown.
window.addEventListener('beforeunload', () => {
    session.destroy();
});
