'use strict';
// Structural contract audit of the public deployed API. No credentials are used.
// allOf members are inspected together; this is not advertised as a strict JSON Schema validator.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
async function main() {
const source = 'https://api.sent.dm/swagger/v3/swagger.json';
const response = await fetch(source, {redirect: 'error', signal: AbortSignal.timeout(30000)});
if (!response.ok) throw Error('OpenAPI download failed: HTTP ' + response.status);
const chunks = []; let size = 0;
for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw Error('OpenAPI document exceeds 10 MiB');
    chunks.push(chunk);
}
const snapshot = Buffer.concat(chunks);
const spec = JSON.parse(snapshot);
const checks = [];
function check(name, fn) { fn(); checks.push({name, passed: true}); }
function resolve(schema) { return schema.$ref ? spec.components.schemas[schema.$ref.split('/').pop()] : schema; }
function properties(schema) {
    schema = resolve(schema);
    return Object.assign({}, ...(schema.allOf || []).map(properties), schema.properties || {});
}
function body(path) { return properties(spec.paths[path].post.requestBody.content['application/json'].schema); }
check('OpenAPI 3, deployed v3', () => { assert.match(spec.openapi, /^3\./); assert.equal(spec.info.version, 'v3'); });
const operations = [
    ['get', '/v3/me'], ['post', '/v3/messages'], ['get', '/v3/messages/{id}'], ['get', '/v3/messages/{id}/activities'],
    ['get', '/v3/contacts'], ['get', '/v3/contacts/{id}'], ['get', '/v3/numbers/lookup/{phoneNumber}'],
    ['get', '/v3/sender-profiles'], ['get', '/v3/templates'], ['get', '/v3/templates/{id}'],
    ['get', '/v3/webhooks'], ['post', '/v3/webhooks'], ['delete', '/v3/webhooks/{id}'],
    ['post', '/v3/webhooks/{id}/test'], ['get', '/v3/webhooks/event-types']
];
for (const [method, path] of operations) check(method.toUpperCase() + ' ' + path, () => assert(spec.paths[path]?.[method]));
check('Current Sender Profiles endpoint is not deprecated', () => assert.notEqual(spec.paths['/v3/sender-profiles'].get.deprecated, true));
check('Send fields match recipient/channel arrays, text/template and sandbox', () => {
    const p = body('/v3/messages');
    for (const [name, type] of Object.entries({to: 'array', channel: 'array', text: 'string', template: 'object', sandbox: 'boolean'})) assert.equal(p[name].type, type, name);
    assert.equal(p.to.items.type, 'string'); assert.equal(p.channel.items.type, 'string');
    const t = properties(p.template); for (const name of ['id', 'name', 'parameters']) assert(t[name]);
});
check('Send success is 202 acceptance, BLOCKED is an asynchronous gate', () => {
    const op = spec.paths['/v3/messages'].post;
    assert(op.responses['202']); assert.match(op.description, /accepted with 202.*BLOCKED/s);
    assert.match(op.description, /free-form content with no open conversation/);
});
check('Explicit idempotency header pattern and limit match client', () => {
    const h = spec.paths['/v3/messages'].post.parameters.find(p => p.name === 'Idempotency-Key').schema;
    assert.equal(h.maxLength, 255); assert(new RegExp(h.pattern).test('nr_' + 'a'.repeat(64)));
});
check('Organization profile header matches the config guard', () => {
    const h = spec.paths['/v3/messages'].post.parameters.find(p => p.name === 'x-profile-id');
    assert.equal(h.schema.format, 'uuid'); assert.match(h.description, /Only organization API keys/);
});
check('List Contacts query fields match implemented filters', () => {
    const names = spec.paths['/v3/contacts'].get.parameters.filter(p => p.in === 'query').map(p => p.name);
    for (const field of ['page', 'page_size', 'search', 'channel', 'phone']) assert(names.includes(field));
});
check('Approved template discovery and pagination are documented', () => {
    const fields = spec.paths['/v3/templates'].get.parameters;
    for (const field of ['page', 'page_size', 'search', 'status']) assert(fields.some(p => p.name === field));
    assert.match(fields.find(p => p.name === 'status').description, /APPROVED/);
});
check('Template response declares string variable names', () => {
    const schema = Object.entries(spec.components.schemas).find(([name]) => name.endsWith('TemplatesResponsesTemplateResponse'))[1];
    assert.equal(properties(schema).variables.items.type, 'string');
});
check('Webhook registration matches fields and numeric limits', () => {
    const p = body('/v3/webhooks');
    for (const name of ['display_name', 'endpoint_url', 'event_types', 'event_filters', 'retry_count', 'timeout_seconds']) assert(p[name]);
    assert.equal(p.event_types.type, 'array'); assert.equal(p.event_filters.type, 'object');
    assert(p.retry_count.minimum <= 3 && p.retry_count.maximum >= 3);
    assert(p.timeout_seconds.minimum <= 10 && p.timeout_seconds.maximum >= 10);
});
check('Webhook test event_type is a string', () => assert.equal(body('/v3/webhooks/{id}/test').event_type.type, 'string'));
check('All implemented operation successes preserve response metadata', () => {
    for (const [method, path] of operations) {
        const response = Object.entries(spec.paths[path][method].responses).find(([code]) => /^2\d\d$/.test(code))[1];
        const headers = Object.keys(response.headers || {}).map(h => h.toLowerCase());
        assert(headers.includes('x-request-id'), path);
    }
});
const report = {checkedAt: new Date().toISOString(), source: 'https://api.sent.dm/swagger/v3/swagger.json',
    sourceDocumentedAt: 'https://docs.sent.dm/reference/api/openapi-spec',
    sha256: crypto.createHash('sha256').update(snapshot).digest('hex'),
    revisionKind: 'SHA-256 of the downloaded public OpenAPI body',
    snapshotUnmodified: true, strictJsonSchemaValidationClaimed: false, operationsAudited: operations.length, checks};
fs.mkdirSync('qa/research', {recursive: true});
fs.writeFileSync('qa/research/openapi-upstream.json', snapshot);
fs.writeFileSync('qa/openapi-contract-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(checks.length + ' deployed OpenAPI contract checks passed');
}
main().catch(() => { console.error('Public OpenAPI contract check failed; no release clearance. Check source availability and API compatibility.'); process.exitCode = 1; });
