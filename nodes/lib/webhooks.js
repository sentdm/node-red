'use strict';
const crypto = require('node:crypto');
const rawBody = require('./raw-body');
const {fail, id, keyFor, errorSummary} = require('./client');
const SUBTYPES = ['queued', 'routed', 'sent', 'delivered', 'read', 'failed', 'scheduled', 'filtered', 'blocked', 'received'];
const TTL = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 10000;
function hash(v) { return crypto.createHash('sha256').update(v).digest('hex'); }
function subscription(events, templateNames = []) {
    if (typeof events === 'string') events = events.split(',').map(s => s.trim()).filter(Boolean);
    if (!Array.isArray(events) || !events.length) fail('Choose at least one webhook event');
    const parents = new Set(), filters = {};
    for (const event of events) {
        if (typeof event !== 'string') fail('Webhook events must be strings');
        if (event === 'message' || event === 'templates') parents.add(event);
        else if (event.startsWith('message.') && SUBTYPES.includes(event.slice(8))) { parents.add('message'); (filters.message ||= []).push(event.slice(8)); }
        else fail('Unsupported webhook event');
    }
    if (events.includes('message')) delete filters.message;
    if (parents.has('templates') && templateNames.length) filters.templates = templateNames;
    return {event_types: [...parents], event_filters: filters};
}
function matches(event, spec) {
    if (!spec.event_types.includes(event.field)) return false;
    if (event.field === 'message') return typeof event.event === 'string' && event.event.startsWith('message.') && (!spec.event_filters.message || spec.event_filters.message.includes(event.event.slice(8)));
    return event.field === 'templates' && (!spec.event_filters.templates || spec.event_filters.templates.includes(event.payload.template_name));
}
function signingKey(secret) {
    if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
    const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
    if (key.length < 16 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null;
    return key;
}
function verify(raw, headers, secret, expectedId, now = Date.now()) {
    const names = ['x-webhook-id', 'x-webhook-timestamp', 'x-webhook-signature', 'x-webhook-event-type'];
    if (names.some(n => typeof headers[n] !== 'string' || !headers[n])) return 400;
    const timestamp = headers['x-webhook-timestamp'];
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || headers['x-webhook-id'] !== expectedId) return 401;
    const key = signingKey(secret);
    if (!Buffer.isBuffer(raw) || !key) return 401;
    const expected = crypto.createHmac('sha256', key).update(expectedId + '.' + timestamp + '.').update(raw).digest();
    const signatures = headers['x-webhook-signature'].split(/\s+/);
    return signatures.some(s => {
        if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(s)) return false;
        const candidate = Buffer.from(s.slice(3), 'base64');
        return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
    }) ? 200 : 401;
}
function dedupeKey(event) {
    const p = event.payload;
    if (event.event === 'message.received' && p.message_id) return hash('in:' + p.message_id);
    if (event.field === 'message' && p.message_id && p.message_status) return hash('out:' + p.message_id + ':' + p.message_status);
    if (event.field === 'templates' && p.template_id && p.status) return hash('template:' + p.template_id + ':' + p.status);
    return hash('event:' + JSON.stringify(event));
}
function remember(node, key, now = Date.now()) {
    const entries = (node.context().get('sentDedupe') || []).filter(e => Array.isArray(e) && e[1] > now - TTL);
    if (entries.some(e => e[0] === key)) return false;
    entries.push([key, now]);
    node.context().set('sentDedupe', entries.slice(-LIMIT));
    return true;
}
function callbackUrl(RED, token) {
    if (RED.settings.httpNodeRoot === false) fail('Node-RED HTTP endpoints are disabled');
    const base = RED.settings.sentWebhookBaseUrl || process.env.SENT_WEBHOOK_BASE_URL;
    if (!base) fail('Set SENT_WEBHOOK_BASE_URL to a public HTTPS origin');
    const url = new URL(base);
    const dev = process.env.SENT_NODE_RED_DEVELOPMENT === '1' && RED.settings.sentDevelopment;
    if ((url.protocol !== 'https:' && !(dev && url.protocol === 'http:' && url.hostname === '127.0.0.1')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('Webhook base must be an HTTPS origin without a path');
    const root = RED.settings.httpNodeRoot || '';
    return url.origin + '/' + [root, 'sent/webhooks', token].map(s => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}
function installReceiver(RED) {
    const receivers = new Map();
    const route = '/sent/webhooks/:token';
    RED.httpNode.post(route, (req, res, next) => {
        if (!receivers.has(req.params.token)) return res.sendStatus(404);
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return res.sendStatus(415);
        if (Buffer.isBuffer(req.sentRawBody)) return next();
        if (req._body || req.readableEnded) return res.status(500).json({error: 'raw body unavailable; check middleware'});
        next();
    }, rawBody.read, (req, res) => {
        const receiver = receivers.get(req.params.token);
        if (!receiver?.secret) return res.sendStatus(503);
        const status = verify(req.sentRawBody || req.body, req.headers, receiver.secret, receiver.webhookId);
        if (status !== 200) return res.status(status).json({error: status === 400 ? 'missing signature headers' : 'invalid signature'});
        let event;
        try {
            event = JSON.parse((req.sentRawBody || req.body).toString('utf8'));
            if (!event || !['message', 'templates'].includes(event.field) || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload) || (event.event || event.field) !== req.headers['x-webhook-event-type']) throw Error();
        } catch { return res.status(400).json({error: 'invalid payload'}); }
        try {
            const key = dedupeKey(event);
            const emit = matches(event, receiver.spec) && remember(receiver.node, key);
            res.status(200).json({received: true});
            if (emit) setImmediate(() => {
                if (receiver.closed) return;
                try { receiver.node.send({payload: receiver.sanitize(event), topic: event.event || event.field, sent: {webhook: {id: receiver.webhookId, eventType: req.headers['x-webhook-event-type'], timestamp: req.headers['x-webhook-timestamp'], dedupeKey: key}}}); }
                catch { receiver.node.error('Webhook downstream dispatch failed'); }
            });
        } catch { res.status(503).json({error: 'event context unavailable'}); }
    }, (_err, _req, res, _next) => res.status(_err.status === 413 ? 413 : 400).json({error: 'invalid request body'}));
    return receivers;
}
function createTrigger(RED, receivers, specialized) {
    return function Trigger(config) {
        RED.nodes.createNode(this, config);
        const node = this, account = RED.nodes.getNode(config.account);
        const releaseCleanup = account?.retainCleanup() || (() => {});
        let receiver, token, profile;
        let closing = false;
        const registrationAbort = new AbortController();
        const cleanup = async () => {
            if (!receiver?.webhookId) return;
            try { await account.request('DELETE', '/v3/webhooks/' + id(receiver.webhookId), {profile, signal: AbortSignal.timeout(10000)}); }
            catch (e) { if (e.sent?.statusCode !== 404) throw e; }
            receiver.webhookId = undefined;
        };
        node.status({fill: 'yellow', shape: 'ring', text: 'registering'});
        node.ready = (async () => {
            if (!account) fail('Select a Sent Account');
            profile = await account.profile(config.profile || '');
            const instance = RED.settings.sentInstanceId || process.env.SENT_INSTANCE_ID || RED.settings.userDir;
            if (!instance) fail('Set SENT_INSTANCE_ID for webhook ownership');
            token = hash(JSON.stringify([instance, account.id, profile, node.id])).slice(0, 40);
            const endpoint = callbackUrl(RED, token);
            const owner = 'node-red-sent:' + token;
            const spec = subscription(specialized ? ['message.received'] : config.events || ['message.delivered'], String(config.templateNames || '').split(',').map(s => s.trim()).filter(Boolean));
            if (receivers.has(token)) fail('Duplicate trigger identity');
            receiver = {node, spec, sanitize: account.sanitize, secret: null, closed: false};
            receivers.set(token, receiver);
            const stale = [];
            // Collect before deleting so pagination cannot shift underneath cleanup.
            for (let page = 1; page <= 20; page++) {
                const {data} = await account.request('GET', '/v3/webhooks', {profile, signal: registrationAbort.signal, query: {page, page_size: 100, search: owner}});
                if (!Array.isArray(data?.webhooks)) fail('Invalid webhook list response');
                stale.push(...data.webhooks.filter(w => w.display_name === owner));
                if (data.webhooks.length < 100 || data.pagination?.has_next_page === false || data.pagination?.total_pages <= page) break;
                if (page === 20) fail('Webhook cleanup exceeds 2000 registrations; inspect account');
            }
            for (const webhook of stale) {
                await account.request('DELETE', '/v3/webhooks/' + id(webhook.id), {profile, signal: registrationAbort.signal});
            }
            if (closing) return;
            const {data} = await account.request('POST', '/v3/webhooks', {profile, signal: registrationAbort.signal, key: keyFor(node.id, crypto.randomUUID()), body: {display_name: owner, endpoint_url: endpoint, ...spec, retry_count: 3, timeout_seconds: 10}});
            receiver.webhookId = id(data?.id, 'Webhook ID');
            if (!signingKey(data?.signing_secret)) { await cleanup(); fail('Webhook registration did not return a valid signing secret'); }
            receiver.secret = data.signing_secret;
            if (closing) { await cleanup(); return; }
            node.status({fill: 'blue', shape: 'dot', text: 'webhook active'});
        })().catch(e => { if (closing) return; node.status({fill: 'red', shape: 'ring', text: 'registration failed'}); node.error(account?.sanitize(errorSummary(e)) || 'Webhook registration failed'); });
        node.on('close', async (_removed, done) => {
            closing = true;
            registrationAbort.abort();
            if (receiver) receiver.closed = true;
            try { await node.ready; await cleanup(); }
            catch { node.warn('Owned webhook cleanup failed; next deploy will recover it'); }
            finally {
                if (receiver) receiver.secret = null;
                if (token && receivers.get(token) === receiver) receivers.delete(token);
                releaseCleanup();
                done();
            }
        });
    };
}
module.exports = {SUBTYPES, TTL, LIMIT, subscription, matches, verify, dedupeKey, remember, callbackUrl, installReceiver, createTrigger};
