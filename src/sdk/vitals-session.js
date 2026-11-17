// src/sdk/vitals-session.js
//
// The ONLY module in TEMPO that talks to @smartspectra/node-sdk.
// TEMPO's visual engine can later consume the normalized events this class
// emits without touching SDK internals.
//
// Uses the official Electron renderer integration:
//   @smartspectra/node-sdk/renderer  -> SmartSpectraSDK (MediaStream capture)
//   @smartspectra/node-sdk/messages  -> decodeMetrics (generated protobuf)
//
// Because this is the renderer integration, the SDK acquires the default
// system camera itself; CameraSelection (headless path) does not apply.

import {
    SmartSpectraSDK,
    ProcessingStatus,
    ValidationCode,
    SmartSpectraErrorCode,
    MetricType,
    breathingMetrics,
    cardioMetrics,
} from '@smartspectra/node-sdk/renderer';
import { decodeMetrics } from '@smartspectra/node-sdk/messages';

export { ProcessingStatus, ValidationCode, SmartSpectraErrorCode };

/** Version of the installed @smartspectra/node-sdk package. */
export const SDK_VERSION = SmartSpectraSDK.version;

/** Measurement availability states surfaced to the UI. */
export const METRIC_STATE = Object.freeze({
    UNAVAILABLE: 'unavailable',
    WARMING_UP: 'warming-up',
    VALID: 'valid',
});

const STATUS_LABELS = Object.freeze(
    Object.fromEntries(
        Object.entries(ProcessingStatus).map(([key, value]) => [value, key.replace(/^k/, '')]),
    ),
);

const VALIDATION_LABELS = Object.freeze(
    Object.fromEntries(
        Object.entries(ValidationCode).map(([key, value]) => [value, key.replace(/^k/, '')]),
    ),
);

const ERROR_LABELS = Object.freeze(
    Object.fromEntries(
        Object.entries(SmartSpectraErrorCode).map(([key, value]) => [value, key.replace(/^k/, '')]),
    ),
);

/** MetricType code -> SDK export name, e.g. 2 -> BREATHING_RATE. */
export const METRIC_NAMES = Object.freeze(
    Object.fromEntries(
        Object.entries(MetricType)
            .filter(([, value]) => typeof value === 'number')
            .map(([key, value]) => [value, key]),
    ),
);

export function statusLabel(status) {
    return STATUS_LABELS[status] || `Status(${status})`;
}

export function validationLabel(code) {
    return VALIDATION_LABELS[code] || `Validation(${code})`;
}

export function errorLabel(code) {
    return ERROR_LABELS[code] || String(code);
}

/**
 * Build the requestedMetrics array from the installed SDK's own bundles and
 * drop only codes that this SDK version does not define. Codes are compared
 * against MetricType from the installed package, never a hand-written list.
 */
export function resolveRequestedMetrics({ cardio = true } = {}) {
    const requested = [...breathingMetrics, ...(cardio ? cardioMetrics : [])];
    const unsupported = requested.filter((code) => !(code in METRIC_NAMES));
    const codes = requested.filter((code) => code in METRIC_NAMES);
    return {
        codes,
        names: codes.map((code) => `${METRIC_NAMES[code]}(${code})`),
        unsupported,
        cardio,
    };
}

/**
 * Classify a native SDK failure so the UI can distinguish:
 *   authentication        -> key rejected (kAuthenticationFailed, or auth text)
 *   metric-authorization  -> key accepted but metrics not entitled / gated
 *   model-provisioning    -> device-key or encrypted-model delivery failed
 *   invalid-configuration -> ConfigurationFailed without a more specific hint
 * The native message is matched only for wording; the numeric code wins where
 * the SDK defines one.
 */
export function classifyFailure(code, message) {
    const text = String(message || '').toLowerCase();

    if (code === SmartSpectraErrorCode.kAuthenticationFailed) return 'authentication';
    if (/api[_ ]?key|authenticat|credential|usage verification|unauthori[sz]ed.*key/.test(text)) {
        return 'authentication';
    }
    if (
        /metric(s)? (authoriz|authoris)|authoriz(ation|ed).*metric|metric.*(unauthoriz|not entitled|entitlement)|gating|subscription/.test(
            text,
        )
    ) {
        return 'metric-authorization';
    }
    if (/device[_ ]?key|device\/pair|device pair|secure_model|model_id|model load|emd/.test(text)) {
        return 'model-provisioning';
    }
    if (code === SmartSpectraErrorCode.kConfigurationFailed) return 'invalid-configuration';
    if (code === SmartSpectraErrorCode.kMetricNotAuthorized) return 'metric-authorization';
    if (code === SmartSpectraErrorCode.kCreditExhausted) return 'credit-exhausted';
    if (code === SmartSpectraErrorCode.kNetworkError) return 'network';
    if (code === SmartSpectraErrorCode.kSustainedLowFrameRate) return 'frame-rate';
    if (code === SmartSpectraErrorCode.kProcessingFailed) return 'processing';
    return 'unknown';
}

function normalizeFailure(error, source) {
    const code = error && error.code != null ? error.code : 'JS';
    const message = error && error.message ? error.message : String(error);
    return {
        code,
        label: typeof code === 'number' ? errorLabel(code) : String(code),
        message,
        retryable: Boolean(error && error.retryable),
        kind: typeof code === 'number' ? classifyFailure(code, message) : 'unknown',
        source,
    };
}

/** protobuf Long | number -> number microseconds. */
function timestampToNumber(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value.toNumber === 'function') return value.toNumber();
    return Number(value);
}

function lastItem(list) {
    return Array.isArray(list) && list.length > 0 ? list[list.length - 1] : null;
}

/**
 * `stable` is the SDK's own accuracy verdict for the metric (see the model
 * cards): a sample that exists but is not stable is still warming up.
 * No sample at all means the metric is unavailable (or unauthorized).
 */
function summarizeConfidentMeasurement(list) {
    const sample = lastItem(list);
    if (!sample) return { state: METRIC_STATE.UNAVAILABLE, value: null, confidence: null, stable: false, timestampUs: null };

    const stable = sample.stable === true;
    return {
        state: stable ? METRIC_STATE.VALID : METRIC_STATE.WARMING_UP,
        value: typeof sample.value === 'number' ? sample.value : null,
        confidence: typeof sample.confidence === 'number' ? sample.confidence : null,
        stable,
        timestampUs: timestampToNumber(sample.timestamp),
    };
}

function summarizeHrv(list) {
    const sample = lastItem(list);
    if (!sample) return { state: METRIC_STATE.UNAVAILABLE, rmssd: null, confidence: null, stable: false, timestampUs: null };

    const stable = sample.stable === true;
    return {
        state: stable ? METRIC_STATE.VALID : METRIC_STATE.WARMING_UP,
        rmssd: typeof sample.rmssd === 'number' ? sample.rmssd : null,
        confidence: typeof sample.confidence === 'number' ? sample.confidence : null,
        stable,
        timestampUs: timestampToNumber(sample.timestamp),
    };
}

function summarizeTrace(list) {
    const sample = lastItem(list);
    if (!sample) return { state: METRIC_STATE.UNAVAILABLE, value: null, timestampUs: null, samples: 0 };
    return {
        state: sample.stable === true ? METRIC_STATE.VALID : METRIC_STATE.WARMING_UP,
        value: typeof sample.value === 'number' ? sample.value : null,
        timestampUs: timestampToNumber(sample.timestamp),
        samples: Array.isArray(list) ? list.length : 0,
    };
}

/**
 * Turn one decoded Metrics packet into a flat, UI-friendly snapshot.
 * Each `metrics` event carries the window since the previous emit, so we
 * read the newest sample in each field rather than accumulating history.
 */
export function summarizeMetrics(metrics) {
    const breathing = metrics && metrics.breathing ? metrics.breathing : null;
    const cardio = metrics && metrics.cardio ? metrics.cardio : null;

    return {
        breathingRate: summarizeConfidentMeasurement(breathing && breathing.rate),
        pulseRate: summarizeConfidentMeasurement(cardio && cardio.pulseRate),
        hrv: summarizeHrv(cardio && cardio.hrv),
        arterialPressureTrace: summarizeConfidentMeasurement(cardio && cardio.arterialPressureTrace),
        chestTrace: summarizeTrace(breathing && breathing.upperTrace),
        // Diagnostic: were cardio fields present at all in this packet?
        cardioFieldsPresent: Boolean(cardio && cardio.pulseRate && cardio.pulseRate.length > 0),
    };
}

/**
 * Thin, dependency-free event emitter around the official renderer SDK.
 *
 * Events:
 *   'metricsRequest'   { codes, names, unsupported, cardio }
 *   'stream'           MediaStream
 *   'processingStatus' { status, label }
 *   'validation'       { code, label, hint, timestampUs }
 *   'metrics'          { snapshot, packetIndex, receivedAt }
 *   'decodeError'      { error, packetIndex }
 *   'fallback'         { failure, from } — cardio configuration failed, retrying breathing-only
 *   'error'            { code, label, message, retryable, kind, source }
 */
export class VitalsSession {
    constructor({ apiKey, cardio = true, cameraOverride = null } = {}) {
        this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        this._cameraOverride =
            cameraOverride && cameraOverride.width > 0 && cameraOverride.height > 0
                ? {
                    width: cameraOverride.width,
                    height: cameraOverride.height,
                    fps: cameraOverride.fps > 0 ? cameraOverride.fps : 30,
                }
                : null;
        this._listeners = new Map();
        this._sdk = null;
        this._packetIndex = 0;
        this._cardioRequested = Boolean(cardio);
        this._fallbackActive = false;
        this._hostStream = null;
        this._cameraRetryUsed = false;
        this._starting = false;
        this._errorCleanup = null;
        this._fatalHandled = false;
        this._frameWindow = null;
        this._requested = resolveRequestedMetrics({ cardio: this._cardioRequested });
    }

    get hasApiKey() {
        return this.apiKey.length > 0;
    }

    get metricsCount() {
        return this._packetIndex;
    }

    get requestedMetrics() {
        return this._requested;
    }

    get fallbackActive() {
        return this._fallbackActive;
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
        return this;
    }

    _emit(event, payload) {
        const handlers = this._listeners.get(event);
        if (!handlers) return;
        for (const handler of handlers) {
            try {
                handler(payload);
            } catch (err) {
                // A broken listener must not take down the measurement session.
                console.error(`[tempo] listener for "${event}" failed:`, err);
            }
        }
    }

    _ensureSdk() {
        if (this._sdk) return this._sdk;

        this._requested = resolveRequestedMetrics({
            cardio: this._cardioRequested && !this._fallbackActive,
        });
        this._emit('metricsRequest', this._requested);

        const sdk = new SmartSpectraSDK({
            apiKey: this.apiKey,
            // Only codes validated against this SDK's MetricType are sent.
            requestedMetrics: this._requested.codes,
        });

        sdk.on('streamAvailable', (stream) => {
            this._emit('stream', stream);
        });

        sdk.on('processingStatus', (status) => {
            this._emit('processingStatus', { status, label: statusLabel(status) });
            // A mid-session failure leaves the SDK's frame pump running against
            // an invalid native session (dropped-frame spam) and keeps the
            // camera open. Reset once the status settles into kError.
            if (status === ProcessingStatus.kError && !this._starting && !this._fatalHandled) {
                void this._cleanupAfterFatalError();
            }
        });

        sdk.on('validationStatus', (code, timestampUs, hint) => {
            this._emit('validation', {
                code,
                label: validationLabel(code),
                hint: hint || '',
                timestampUs,
            });
        });

        sdk.on('metrics', (buffer, timestampUs) => {
            this._packetIndex += 1;
            const packetIndex = this._packetIndex;
            try {
                // decodeMetrics from /messages ships the generated Metrics class,
                // so no setMetricsClass() registration is needed.
                const decoded = decodeMetrics(buffer);
                this._emit('metrics', {
                    snapshot: summarizeMetrics(decoded),
                    packetIndex,
                    timestampUs,
                    receivedAt: Date.now(),
                });
            } catch (error) {
                this._emit('decodeError', { error, packetIndex, timestampUs });
            }
        });

        sdk.on('frameSentThrough', (sent) => {
            const now = Date.now();
            if (!this._frameWindow) this._frameWindow = { start: now, sent: 0, rejected: 0 };
            const window = this._frameWindow;
            if (sent) window.sent += 1;
            else window.rejected += 1;

            const elapsed = now - window.start;
            if (elapsed >= 1000) {
                this._emit('frameRate', {
                    fps: (window.sent * 1000) / elapsed,
                    rejected: window.rejected,
                    windowMs: elapsed,
                });
                this._frameWindow = { start: now, sent: 0, rejected: 0 };
            }
        });

        sdk.on('error', (code, message, retryable) => {
            this._emit('error', {
                code,
                label: errorLabel(code),
                message,
                retryable,
                kind: classifyFailure(code, message),
                source: 'sdk',
            });
            if (!this._starting && !this._fatalHandled) void this._cleanupAfterFatalError();
        });

        this._sdk = sdk;
        return sdk;
    }

    _destroySdk() {
        this._releaseHostStream();
        if (!this._sdk) return;
        try {
            this._sdk.destroy();
        } catch (error) {
            console.error('[tempo] SDK destroy failed:', error);
        }
        this._sdk = null;
    }

    _releaseHostStream() {
        if (!this._hostStream) return;
        for (const track of this._hostStream.getTracks()) {
            try {
                track.stop();
            } catch {
                // already stopped
            }
        }
        this._hostStream = null;
    }

    /**
     * Host-side camera acquisition used only if the SDK's default getUserMedia
     * times out. The SDK's default constraints include `facingMode: 'user'`;
     * Windows desktop cameras do not reliably honour facing-mode selection, so
     * the retry uses plain ideal width/height/fps with no facingMode — still
     * the official renderer path, via useMediaStream().
     */
    async _acquireHostStream(override = null) {
        const target = override || { width: 1280, height: 720, fps: 30 };
        const constraints = {
            audio: false,
            video: {
                width: { ideal: target.width },
                height: { ideal: target.height },
                frameRate: { ideal: target.fps },
            },
        };

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices
                .filter((device) => device.kind === 'videoinput')
                .map((device, index) => ({
                    index,
                    label: device.label || '(label hidden until camera permission is granted)',
                    deviceIdSuffix: device.deviceId ? device.deviceId.slice(-6) : '(none)',
                }));
            this._emit('cameraDevices', { cameras, constraints });
        } catch (error) {
            this._emit('cameraDevices', { cameras: [], constraints, error: error.message });
        }

        try {
            return await navigator.mediaDevices.getUserMedia(constraints);
        } catch (error) {
            const name = error && error.name ? error.name : 'Error';
            const hint =
                name === 'NotAllowedError'
                    ? 'Camera permission was denied. Allow camera access for desktop apps in Windows Settings → Privacy → Camera, then retry.'
                    : name === 'NotReadableError'
                        ? 'The camera is already in use by another application. Close Teams/Zoom/Camera/other Electron apps and retry.'
                        : name === 'AbortError'
                            ? 'The camera did not start in time. Close other camera apps, check Windows Settings → Privacy → Camera, and retry. A USB camera can also be re-plugged.'
                            : name === 'NotFoundError'
                                ? 'No camera was found. Connect a webcam and retry.'
                                : 'The camera could not be opened.';
            const wrapped = new Error(
                `Host camera acquisition failed (${name}): ${error && error.message ? error.message : error}. ${hint}`,
            );
            wrapped.code = 'TEMPO_CAMERA';
            throw wrapped;
        }
    }

    /** Acquire and attach the configured override stream, if any. */
    async _applyCameraOverride(sdk) {
        if (!this._cameraOverride || this._hostStream) return;
        const stream = await this._acquireHostStream(this._cameraOverride);
        this._hostStream = stream;
        this._emit('stream', stream);
        sdk.useMediaStream(stream);
    }

    _shouldRetryCamera(failure) {
        if (this._cameraRetryUsed || this._hostStream) return false;
        return /AbortError|Timeout starting video source|NotReadableError|Could not start video source/.test(
            failure.message,
        );
    }

    /**
     * Acquire the camera and begin streaming to Presage.
     *
     * If the full breathing+cardio request fails with ConfigurationFailed, the
     * official sample's documented cardio failure mode (device keys / metric
     * authorization) is a likely cause. We retry once with breathing only so a
     * partially entitled key can still produce real measurements; the original
     * native error is emitted through 'fallback' and shown in the UI.
     */
    async start() {
        if (!this.hasApiKey) {
            const error = new Error(
                'SMARTSPECTRA_API_KEY is not set. Add it to .env (or .env.local) and restart with `npm start`.',
            );
            error.code = 'TEMPO_MISSING_API_KEY';
            throw error;
        }

        this._starting = true;
        try {
            await this._startSession();
        } finally {
            this._starting = false;
        }
    }

    /**
     * Stop the frame pump and release the camera after the SDK enters a fatal
     * state. reset() is the official lifecycle call after kError and releases
     * the SDK-owned stream; host streams are ours, so release them too.
     */
    async _cleanupAfterFatalError() {
        if (this._errorCleanup) return this._errorCleanup;
        if (this._fatalHandled) return undefined;
        this._fatalHandled = true;
        const sdk = this._sdk;
        this._errorCleanup = (async () => {
            try {
                if (sdk && sdk === this._sdk) {
                    try {
                        await sdk.reset();
                    } catch (error) {
                        console.warn('[tempo] post-error reset failed:', error && error.message ? error.message : error);
                        if (this._sdk === sdk) this._destroySdk();
                    }
                }
            } finally {
                this._releaseHostStream();
                this._emit('releasedAfterError');
                this._errorCleanup = null;
            }
        })();
        return this._errorCleanup;
    }

    /** Body of start(); the public method tracks the in-flight state. */
    async _startSession() {
        // One host-stream retry is allowed per start attempt.
        this._cameraRetryUsed = false;
        this._fatalHandled = false;
        this._frameWindow = null;

        const sdk = this._ensureSdk();

        // Explicit resolution/fps override for throughput diagnosis: acquire
        // the stream ourselves and use the official useMediaStream() path.
        if (this._cameraOverride && !this._hostStream) {
            try {
                await this._applyCameraOverride(sdk);
            } catch (error) {
                const failure = {
                    code: 'CAMERA',
                    label: 'CameraUnavailable',
                    message: error.message,
                    retryable: true,
                    kind: 'camera',
                    source: 'camera override',
                };
                this._emit('error', failure);
                throw error;
            }
        }

        try {
            await sdk.start();
            return;
        } catch (error) {
            const failure = normalizeFailure(error, 'start');

            if (this._shouldRetryCamera(failure)) {
                this._cameraRetryUsed = true;
                this._emit('cameraRetry', { failure });
                try {
                    const stream = await this._acquireHostStream();
                    this._hostStream = stream;
                    // The SDK does not emit streamAvailable for host-supplied
                    // streams, so surface the preview stream ourselves.
                    this._emit('stream', stream);
                    sdk.useMediaStream(stream);
                    await sdk.start();
                    return;
                } catch (retryError) {
                    this._releaseHostStream();
                    if (retryError && retryError.code === 'TEMPO_CAMERA') {
                        const cameraFailure = {
                            code: 'CAMERA',
                            label: 'CameraUnavailable',
                            message: retryError.message,
                            retryable: true,
                            kind: 'camera',
                            source: 'camera retry',
                        };
                        retryError.failure = cameraFailure;
                        this._emit('error', cameraFailure);
                        throw retryError;
                    }
                    const retryFailure = normalizeFailure(retryError, 'camera retry');
                    this._emit('error', retryFailure);
                    throw retryError;
                }
            }

            const canFallback =
                !this._fallbackActive &&
                this._cardioRequested &&
                (failure.code === SmartSpectraErrorCode.kConfigurationFailed ||
                    failure.code === SmartSpectraErrorCode.kMetricNotAuthorized);

            if (canFallback) {
                this._emit('fallback', { failure, from: this._requested });
                this._fallbackActive = true;
                // A failed renderer start already released the SDK-owned camera.
                // Rebuild the SDK so the new metric set is used for configure.
                this._destroySdk();
                // Native SDK state is process-global and main-process teardown
                // is deferred; give the destroy message a moment to be handled
                // so the replacement start queues behind its teardown barrier.
                await new Promise((resolve) => setTimeout(resolve, 250));
                try {
                    const retrySdk = this._ensureSdk();
                    if (this._cameraOverride) {
                        await this._applyCameraOverride(retrySdk);
                    }
                    await retrySdk.start();
                    return;
                } catch (retryError) {
                    const retryFailure = normalizeFailure(retryError, 'start (breathing-only retry)');
                    this._emit('error', retryFailure);
                    throw retryError;
                }
            }

            this._emit('error', failure);
            throw error;
        }
    }

    /** Stop the session and release the SDK-acquired camera. */
    async stop() {
        if (!this._sdk) {
            this._releaseHostStream();
            return;
        }
        try {
            await this._sdk.stop();
        } catch (error) {
            this._emit('error', normalizeFailure(error, 'stop'));
            throw error;
        } finally {
            this._releaseHostStream();
        }
    }

    /**
     * Rebuild after an error. A fallback session is torn down completely so the
     * next start retries the full metric bundle; otherwise use the SDK's reset.
     */
    async reset() {
        // An automatic post-error cleanup may already be running.
        if (this._errorCleanup) {
            await this._errorCleanup;
            return;
        }
        if (!this._sdk) {
            this._releaseHostStream();
            return;
        }
        if (this._fallbackActive || this._hostStream) {
            this._destroySdk();
            this._fallbackActive = false;
            this._cameraRetryUsed = false;
            this._fatalHandled = false;
            return;
        }
        await this._sdk.reset();
    }

    /** Release renderer + main-process resources. Idempotent. */
    destroy() {
        this._destroySdk();
    }
}
