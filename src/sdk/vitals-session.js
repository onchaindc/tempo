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

export function statusLabel(status) {
    return STATUS_LABELS[status] || `Status(${status})`;
}

export function validationLabel(code) {
    return VALIDATION_LABELS[code] || `Validation(${code})`;
}

export function errorLabel(code) {
    return ERROR_LABELS[code] || String(code);
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
 *   'stream'           MediaStream
 *   'processingStatus' { status, label }
 *   'validation'       { code, label, hint, timestampUs }
 *   'metrics'          { snapshot, packetIndex, receivedAt }
 *   'decodeError'      { error, packetIndex }
 *   'error'            { code, label, message, retryable, source }
 */
export class VitalsSession {
    constructor({ apiKey } = {}) {
        this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
        this._listeners = new Map();
        this._sdk = null;
        this._packetIndex = 0;
    }

    get hasApiKey() {
        return this.apiKey.length > 0;
    }

    get metricsCount() {
        return this._packetIndex;
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

        const sdk = new SmartSpectraSDK({
            apiKey: this.apiKey,
            requestedMetrics: [...breathingMetrics, ...cardioMetrics],
        });

        sdk.on('streamAvailable', (stream) => {
            this._emit('stream', stream);
        });

        sdk.on('processingStatus', (status) => {
            this._emit('processingStatus', { status, label: statusLabel(status) });
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

        sdk.on('error', (code, message, retryable) => {
            this._emit('error', {
                code,
                label: errorLabel(code),
                message,
                retryable,
                source: 'sdk',
            });
        });

        this._sdk = sdk;
        return sdk;
    }

    /** Acquire the camera and begin streaming to Presage. */
    async start() {
        if (!this.hasApiKey) {
            const error = new Error(
                'SMARTSPECTRA_API_KEY is not set. Add it to .env (or .env.local) and restart with `npm start`.',
            );
            error.code = 'TEMPO_MISSING_API_KEY';
            throw error;
        }

        // Construction is deferred so a missing key never reaches the native SDK.
        const sdk = this._ensureSdk();
        try {
            await sdk.start();
        } catch (error) {
            this._emit('error', {
                code: error && error.code != null ? error.code : 'JS',
                label: error && error.code != null ? errorLabel(error.code) : 'JavaScriptError',
                message: error && error.message ? error.message : String(error),
                retryable: Boolean(error && error.retryable),
                source: 'start',
            });
            throw error;
        }
    }

    /** Stop the session and release the SDK-acquired camera. */
    async stop() {
        if (!this._sdk) return;
        try {
            await this._sdk.stop();
        } catch (error) {
            this._emit('error', {
                code: error && error.code != null ? error.code : 'JS',
                label: error && error.code != null ? errorLabel(error.code) : 'JavaScriptError',
                message: error && error.message ? error.message : String(error),
                retryable: Boolean(error && error.retryable),
                source: 'stop',
            });
            throw error;
        }
    }

    /** Rebuild the pipeline after an SDK error. */
    async reset() {
        if (!this._sdk) return;
        await this._sdk.reset();
    }

    /** Release renderer + main-process resources. Idempotent. */
    destroy() {
        if (!this._sdk) return;
        try {
            this._sdk.destroy();
        } catch (error) {
            console.error('[tempo] SDK destroy failed:', error);
        }
        this._sdk = null;
    }
}
