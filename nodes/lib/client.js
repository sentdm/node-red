'use strict';
const crypto = require('node:crypto');
const {setTimeout: sleep} = require('node:timers/promises');
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH']);
const MOCK_KEY = '00000000-0000-4000-8000-000000000001';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
function clean(value, secrets = []) {
    if (typeof value === 'string') {
        for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[redacted]');
        return value.replace(/whsec_[A-Za-z\d+/=_-]+/g, '[redacted]');
    }
    if (Array.isArray(value)) return value.map(v => clean(v, secrets));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(api[_-]?key|signing[_-]?secret|authorization|x-api-key)$/i.test(k) ? '[redacted]' : clean(v, secrets)]));
    return value;
}
class SentError extends Error {
    constructor(message, info = {}) { super(message); this.name = 'SentError'; this.sent = info; }
}
function fail(message) { throw new SentError(message, {code: 'INPUT_INVALID', message}); }
function errorSummary(error) {
    // Provider messages can reflect customer data. Keep them on msg.sent.error,
    // not in Node-RED's normal log/error message.
    if (error.sent?.code === 'INPUT_INVALID') return error.message;
    const status = Number.isInteger(error.sent?.statusCode) ? ' HTTP ' + error.sent.statusCode : '';
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.sent?.code || '') ? ' (' + error.sent.code + ')' : '';
    return 'Sent request failed' + status + code;
}
function object(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be a JSON object');
    return value;
}
function id(value, label = 'ID') {
    if (typeof value !== 'string' || !UUID.test(value)) fail(label + ' must be a UUID');
    return value;
}
function phone(value) {
    if (typeof value !== 'string' || !/^\+[1-9]\d{6,14}$/.test(value)) fail('Phone must be an E.164 string including +');
    return value;
}
function safePath(path) {
    if (typeof path !== 'string' || !path.startsWith('/v3/') || /[\\\s#?\x00-\x1f]/.test(path)) fail('Use a relative /v3/ path; enter query separately');
    // Decode fully to detect double encoding, traversal and encoded separators before URL normalisation.
    let decoded = path;
    try { for (let i = 0; i < 5 && decoded.includes('%'); i++) { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } } catch { fail('Invalid path encoding'); }
    if (decoded.includes('%') || /[\\\s?#\x00-\x1f]/.test(decoded) || decoded.includes('//') || decoded.split('/').some(p => p === '.' || p === '..') || !decoded.startsWith('/v3/')) fail('Unsafe API path');
    const url = new URL(path, 'https://api.sent.dm');
    if (url.origin !== 'https://api.sent.dm' || !url.pathname.startsWith('/v3/')) fail('Unsafe API origin');
    return path;
}
function keyFor(nodeId, msgId, body, profile) {
    return 'nr_' + crypto.createHash('sha256').update(JSON.stringify([nodeId, msgId || crypto.randomUUID(), body, profile])).digest('hex');
}
function retryAfter(value, now = Date.now()) {
    if (!value) return 0;
    const n = Number(value);
    return Math.max(0, Number.isFinite(n) ? n * 1000 : Date.parse(value) - now) || 0;
}
function metadata(response, body, profile) {
    const h = response.headers;
    return {statusCode: response.status, meta: body?.meta, requestId: h.get('x-request-id') || body?.meta?.request_id,
        responseTime: h.get('x-response-time'), apiVersion: h.get('x-api-version'), profileId: h.get('x-profile-id') || profile || undefined,
        idempotentReplayed: h.get('idempotent-replayed') === 'true', originalRequestId: h.get('x-original-request-id'), sandbox: h.get('x-sandbox') === 'true'};
}
class Client {
    #key;
    constructor(key, settings = {}) {
        this.#key = key;
        this.base = 'https://api.sent.dm';
        this.controller = new AbortController();
        this.wait = settings.wait || sleep;
        this.minInterval = 310; // approximately 193 requests/min; shared by this account config
        this.tail = Promise.resolve();
        this.nextAt = 0;
        this.rateUntil = 0;
        if (settings.development) {
            const url = new URL(settings.development.baseUrl);
            if (process.env.SENT_NODE_RED_DEVELOPMENT !== '1' || key !== MOCK_KEY || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) fail('Development transport requires explicit opt-in, loopback and mock credential');
            this.base = url.origin;
            this.minInterval = settings.development.minInterval ?? 0;
        }
    }
    sanitize(v) { return clean(v, [this.#key]); }
    close() { this.controller.abort(); }
    async pace(webhook, signal = this.controller.signal) {
        const slot = this.tail.then(async () => {
            signal.throwIfAborted();
            const delay = Math.max(this.nextAt, this.rateUntil) - Date.now();
            if (delay > 0) await this.wait(delay, undefined, {signal});
            signal.throwIfAborted();
            this.nextAt = Date.now() + (webhook && this.minInterval ? 1100 : this.minInterval);
        });
        this.tail = slot.catch(() => {});
        await slot;
    }
    async request(method, path, options = {}) {
        const signal = options.signal ? AbortSignal.any([this.controller.signal, options.signal]) : this.controller.signal;
        method = String(method).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('Unsupported method');
        safePath(path);
        if (!UUID.test(this.#key || '')) fail('Configure a UUID Sent API key');
        const url = new URL(path, this.base);
        const headers = {'x-api-key': this.#key, accept: 'application/json'};
        if (options.profile) headers['x-profile-id'] = id(options.profile, 'Sender profile');
        if (options.headers) for (const [k, v] of Object.entries(object(options.headers, 'Headers'))) {
            // Narrow allowlist excludes authentication, routing, proxy, framing and profile overrides.
            if (!['accept-language'].includes(k.toLowerCase()) || typeof v !== 'string' || /[\r\n]/.test(v)) fail('Only Accept-Language is allowed in custom headers');
            headers[k.toLowerCase()] = v;
        }
        if (options.query) for (const [k, v] of Object.entries(object(options.query, 'Query'))) {
            if (v !== undefined && v !== null && v !== '') {
                if (!['string', 'number', 'boolean'].includes(typeof v)) fail('Query values must be scalar');
                url.searchParams.set(k, String(v));
            }
        }
        if (options.key) {
            if (!MUTATIONS.has(method) || !/^[A-Za-z0-9_-]{1,255}$/.test(options.key)) fail('Idempotency key requires POST/PUT/PATCH and 1–255 letters, numbers, _ or -');
            headers['idempotency-key'] = options.key;
        }
        let body;
        if (options.body !== undefined) {
            if (method === 'GET') fail('GET cannot have a body');
            body = JSON.stringify(object(options.body, 'Body'));
            if (Buffer.byteLength(body) > 1024 * 1024) fail('Request body exceeds 1 MiB');
            headers['content-type'] = 'application/json';
        }
        const safeRetry = method === 'GET' || (MUTATIONS.has(method) && !!options.key);
        for (let attempt = 0; ; attempt++) {
            let response, parsed, failure;
            try {
                await this.pace(path.startsWith('/v3/webhooks'), signal);
                response = await fetch(url, {method, headers, body, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])});
                if (response.status >= 300 && response.status < 400) {
                    await response.body?.cancel();
                    throw new SentError('Sent redirect refused', {statusCode: response.status, code: 'REDIRECT_REFUSED'});
                }
                const chunks = []; let bytes = 0;
                for await (const chunk of response.body || []) {
                    bytes += chunk.length;
                    if (bytes > 5 * 1024 * 1024) throw new SentError('Response exceeds 5 MiB', {code: 'RESPONSE_TOO_LARGE'});
                    chunks.push(chunk);
                }
                const raw = Buffer.concat(chunks).toString('utf8');
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                if (response.ok && parsed?.success !== false) return {data: parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'data') ? parsed.data : parsed, body: parsed, sent: metadata(response, parsed, options.profile)};
                const error = this.sanitize(parsed?.error || {});
                failure = new SentError(error.message || `Sent HTTP ${response.status}`, {...metadata(response, parsed, options.profile), ...error, retryAfter: response.headers.get('retry-after')});
            } catch (error) {
                failure = error instanceof SentError ? error : new SentError(signal.aborted ? 'Sent request cancelled' : 'Sent network request failed', {code: signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR'});
            }
            const transient = !response && failure.sent.code === 'NETWORK_ERROR' || response?.status === 429 || response?.status >= 500 || response?.status === 409 && failure.sent.code === 'CONFLICT_001';
            if (response?.status === 429) this.rateUntil = Math.max(this.rateUntil, Date.now() + retryAfter(response.headers.get('retry-after')));
            const delay = Math.max(retryAfter(response?.headers.get('retry-after')), 300 * 2 ** attempt + Math.floor(Math.random() * 150));
            if (!safeRetry || !transient || attempt >= 2 || delay > 60000 || signal.aborted) throw failure;
            options.onRetry?.();
            try { await this.wait(delay, undefined, {signal}); } catch { throw failure; }
        }
    }
}
module.exports = {Client, SentError, clean, fail, errorSummary, object, id, phone, safePath, keyFor, retryAfter, MOCK_KEY};
