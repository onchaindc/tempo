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

const $ = (id) => document.getElementById(id);

const els = {
    status: $('status-badge'),
    setupBanner: $('setup-banner'),
    errorBanner: $('error-banner'),
    errorCode: $('error-code'),
    errorMessage: $('error-message'),
    preview: $('preview'),
    previewPlaceholder: $('preview-placeholder'),
    previewState: $('preview-state'),
    validation: $('validation'),
    btnStart: $('btn-start'),
    btnStop: $('btn-stop'),
    btnReset: $('btn-reset'),
    btnClearLog: $('btn-clear-log'),
    sdkVersion: $('sdk-version'),
    statPackets: $('stat-packets'),
    statLast: $('stat-last'),
    cardioNote: $('cardio-note'),
    log: $('event-log'),
};

const session = new VitalsSession({ apiKey: API_KEY });

let packetCount = 0;
let packetsWithCardio = 0;
let running = false;
let lastStatus = ProcessingStatus.kUninitialized;

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

function showPreview(stream) {
    els.preview.srcObject = stream;
    els.previewPlaceholder.hidden = true;
    els.previewState.textContent = 'live';
    els.preview.play().catch((error) => {
        log(`preview play() rejected: ${error.message}`, 'warn');
    });
    const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
    const settings = track && track.getSettings ? track.getSettings() : {};
    log(
        `stream acquired (${settings.width || '?'}x${settings.height || '?'} @ ${settings.frameRate || '?'} fps)`,
        'ok',
    );
}

function clearPreview(reason) {
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
}

function showError({ code, label, message, retryable, source }) {
    els.errorBanner.hidden = false;
    els.errorCode.textContent = `${label} (${code})`;
    els.errorMessage.textContent = `${message}${retryable ? ' — retryable' : ''}`;
    log(`error [${source}] ${label} (${code}): ${message}${retryable ? ' [retryable]' : ''}`, 'error');
}

// --- SDK events ------------------------------------------------------------

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
    showError({
        code: 'DECODE',
        label: 'decodeMetricsFailed',
        message: `packet #${packetIndex}: ${error.message}`,
        retryable: false,
        source: 'decode',
    });
});

session.on('error', showError);

// --- Controls --------------------------------------------------------------

async function startMeasurement() {
    if (!session.hasApiKey) {
        els.setupBanner.hidden = false;
        return;
    }

    els.errorBanner.hidden = true;
    els.setupBanner.hidden = true;
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
            els.errorBanner.hidden = false;
            els.errorCode.textContent = error.code || 'START';
            els.errorMessage.textContent = error.message;
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
    clearPreview('released');
    clearMetrics();
}

els.btnStart.addEventListener('click', startMeasurement);
els.btnStop.addEventListener('click', stopMeasurement);
els.btnReset.addEventListener('click', resetSession);

// --- Boot ------------------------------------------------------------------

if (!session.hasApiKey) {
    els.setupBanner.hidden = false;
    els.btnStart.disabled = true;
    els.btnStart.title = 'SMARTSPECTRA_API_KEY is not set';
    log('SMARTSPECTRA_API_KEY missing — measurement disabled', 'error');
} else {
    log(`ready — SDK ${SDK_VERSION}, requesting breathing + cardio`);
}

updateButtons(ProcessingStatus.kUninitialized);
clearMetrics();

// Release the renderer SDK bridge and the main-process SDK before teardown.
window.addEventListener('beforeunload', () => {
    session.destroy();
});
