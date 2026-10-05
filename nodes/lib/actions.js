'use strict';
const {fail, object, id, phone, keyFor} = require('./client');
const TYPES = ['get-account', 'send-message', 'get-message-status', 'get-message-activities', 'list-contacts', 'get-contact', 'get-phone-number-details', 'custom-api-call'];
function evaluate(RED, node, config, name, msg, fallback, defaultType = 'str') {
    const value = config[name] === undefined ? fallback : config[name];
    const type = config[name + 'Type'] || defaultType;
    if (!['str', 'msg', 'json', 'num', 'bool', 'env'].includes(type)) fail('Unsupported input type');
    return RED.util.evaluateNodeProperty(value, type, node, msg);
}
function integer(value, name, max) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) fail(`${name} must be between 1 and ${max}`);
    return n;
}
async function run(type, RED, node, config, msg, account) {
    const v = (n, d, t) => evaluate(RED, node, config, n, msg, d, t);
    const profile = type === 'get-account' ? undefined : await account.profile(v('profile', ''));
    const opts = {profile, signal: node.sentAbort.signal, onRetry: () => node.status({fill: 'yellow', shape: 'ring', text: 'retrying'})};
    let method = 'GET', path;
    switch (type) {
    case 'get-account': path = '/v3/me'; break;
    case 'send-message': {
        method = 'POST'; path = '/v3/messages';
        let to = v('to', 'payload.to', 'msg');
        if (typeof to === 'string') to = to.split(',').map(s => s.trim());
        if (!Array.isArray(to) || !to.length || to.length > 1000) fail('Provide 1–1000 recipients');
        to.forEach(phone);
        let channel = v('channel', 'sent');
        if (typeof channel === 'string') channel = channel.split(',').map(s => s.trim()).filter(Boolean);
        if (!Array.isArray(channel) || channel.some(c => !['sent', 'sms', 'whatsapp', 'rcs'].includes(c))) fail('Invalid channel');
        const sandbox = v('sandbox', false, 'bool');
        if (typeof sandbox !== 'boolean') fail('Sandbox must be boolean');
        opts.body = {to, sandbox};
        if (channel.length) opts.body.channel = channel;
        if ((config.mode || 'template') === 'text') {
            const text = v('text', 'payload.text', 'msg');
            if (typeof text !== 'string' || !text.trim()) fail('Free-form text is required');
            opts.body.text = text;
        } else if (!config.mode || config.mode === 'template') {
            const template = v('template', '');
            if (typeof template !== 'string' || !template.trim()) fail('Template ID or name is required');
            if (!['id', 'name'].includes(config.templateBy || 'id')) fail('Choose template ID or name');
            if ((config.templateBy || 'id') === 'id') id(template, 'Template');
            const parameters = {...object(v('parameters', '{}', 'json'), 'Template parameters')};
            for (const row of config.variables || []) {
                if (!row.name || ['__proto__', 'constructor', 'prototype'].includes(row.name)) fail('Invalid variable name');
                parameters[row.name] = evaluate(RED, node, {value: row.value, valueType: row.type}, 'value', msg, '');
            }
            opts.body.template = {[config.templateBy || 'id']: template, parameters};
        } else fail('Choose Template or Free-form text');
        opts.key = v('idempotencyKey', '') || keyFor(node.id, msg._msgid, opts.body, profile);
        break;
    }
    case 'get-message-status': case 'get-message-activities':
        path = '/v3/messages/' + id(v('messageId', 'payload.message_id', 'msg'), 'Message ID') + (type === 'get-message-activities' ? '/activities' : ''); break;
    case 'get-contact': path = '/v3/contacts/' + id(v('contactId', 'payload.id', 'msg'), 'Contact ID'); break;
    case 'get-phone-number-details': path = '/v3/numbers/lookup/' + encodeURIComponent(phone(v('phone', 'payload.phone', 'msg'))); break;
    case 'list-contacts':
        path = '/v3/contacts'; opts.query = {page: integer(v('page', 1, 'num'), 'Page', 1000000), page_size: integer(v('pageSize', 50, 'num'), 'Page size', 100), search: v('search', ''), channel: v('contactChannel', ''), phone: v('phoneFilter', '')};
        if (opts.query.channel && !['sms', 'whatsapp'].includes(opts.query.channel)) fail('Contact channel must be sms or whatsapp');
        if (opts.query.phone) phone(opts.query.phone);
        break;
    case 'custom-api-call':
        method = config.method || 'GET'; path = v('path', '/v3/me');
        opts.query = v('query', '{}', 'json'); opts.headers = v('headers', '{}', 'json');
        if (method !== 'GET') opts.body = v('body', '{}', 'json');
        opts.key = v('idempotencyKey', '') || undefined;
        break;
    default: fail('Unknown action');
    }
    return account.request(method, path, opts);
}
module.exports = {TYPES, run, evaluate, integer};
