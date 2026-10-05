'use strict';
// Node-RED owns the Express apps. This package only needs a bounded byte reader.
async function read(req, res, next) {
    if (Buffer.isBuffer(req.sentRawBody)) return next();
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return res.sendStatus(415);
    if (req._body || req.readableEnded) return res.status(500).json({error: 'Sent raw-body middleware must run before JSON parsing'});
    try {
        // Dynamic import supports the ESM reader on the full Node >=22.9 range.
        const {default: getRawBody} = await import('raw-body');
        const raw = await getRawBody(req, {length: req.headers['content-length'], limit: 1024 * 1024});
        Object.defineProperty(req, 'sentRawBody', {value: raw, enumerable: false});
        req.body = raw;
        req._body = true; // Tell Node-RED 5's admin body-parser that bytes are already captured.
        next();
    } catch (err) {
        if (!res.headersSent && !res.destroyed) res.set('Connection', 'close').status(err.status === 413 ? 413 : 400).json({error: 'invalid request body'});
        req.resume();
    }
}
// Supported settings hook: called before the admin app's global JSON parser.
function sentRawBody(options = {}) {
    const root = String(options.httpNodeRoot || '').replace(/^\/+|\/+$/g, '');
    const prefix = '/' + (root ? root + '/' : '') + 'sent/webhooks/';
    return function(req, res, next) {
        const path = (req.originalUrl || req.url).split('?')[0];
        if (req.method !== 'POST' || !path.startsWith(prefix)) return next();
        return read(req, res, next);
    };
}
sentRawBody.read = read;
module.exports = sentRawBody;
