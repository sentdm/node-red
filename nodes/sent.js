'use strict';
const {Client, fail, id, errorSummary} = require('./lib/client');
const {TYPES, run, integer} = require('./lib/actions');
const {installReceiver, createTrigger} = require('./lib/webhooks');
module.exports = function(RED) {
    function Account(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        let client;
        try {
            client = new Client(config.useEnv ? process.env.SENT_API_KEY : node.credentials?.apiKey, {development: RED.settings.sentDevelopment});
        } catch (e) { node.error(e.message); }
        node.sanitize = v => client ? client.sanitize(v) : 'Sent account unavailable';
        node.request = (...args) => { if (!client) fail('Sent account unavailable'); return client.request(...args); };
        let accountData, pending, closed = false, cleanupUsers = 0;
        node.retainCleanup = () => {
            if (closed) fail('Sent account is closing');
            cleanupUsers++;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                cleanupUsers--;
                if (closed && cleanupUsers === 0) client?.close();
            };
        };
        node.authenticate = async (force = false) => {
            if (closed) fail('Sent account is closing');
            if (force) accountData = undefined;
            if (accountData) return accountData;
            if (!pending) pending = node.request('GET', '/v3/me').then(r => { accountData = r.data; return accountData; }).finally(() => { pending = undefined; });
            return pending;
        };
        node.profile = async profile => {
            if (!profile) return undefined;
            id(profile, 'Sender profile');
            const data = await node.authenticate();
            if (data?.type !== 'organization') fail('Sender profile scope requires an organization API key; leave profile blank for profile keys');
            return profile;
        };
        // Keep transport alive only while trigger close hooks delete their owned subscriptions.
        node.on('close', () => {
            closed = true;
            accountData = undefined;
            if (cleanupUsers === 0) client?.close();
        });
    }
    RED.nodes.registerType('sent-account', Account, {credentials: {apiKey: {type: 'password'}}});
    for (const type of TYPES) {
        RED.nodes.registerType('sent-' + type, function Action(config) {
            RED.nodes.createNode(this, config);
            const node = this, account = RED.nodes.getNode(config.account);
            let closed = false;
            node.sentAbort = new AbortController();
            node.status({fill: account ? 'green' : 'yellow', shape: account ? 'dot' : 'ring', text: account ? 'ready' : 'select account'});
            node.on('input', async (msg, send, done) => {
                send ||= node.send.bind(node);
                done ||= err => { if (err) node.error(err, msg); };
                try {
                    if (!account) fail('Select a Sent Account');
                    node.status({fill: 'blue', shape: 'dot', text: 'requesting'});
                    const result = await run(type, RED, node, config, msg, account);
                    if (!closed) {
                        msg.payload = account.sanitize(result.data);
                        msg.sent = {...msg.sent, ...account.sanitize(result.sent)};
                        node.status({fill: 'green', shape: 'dot', text: result.sent.statusCode === 202 ? 'accepted' : 'success'});
                        send(msg);
                    }
                    done();
                } catch (error) {
                    if (closed) { done(); return; }
                    msg.sent = {...msg.sent, error: account ? account.sanitize(error.sent || {message: error.message}) : {message: error.message}};
                    node.status({fill: 'red', shape: 'ring', text: 'failed'});
                    done(new Error(account ? account.sanitize(errorSummary(error)) : errorSummary(error)));
                }
            });
            node.on('close', () => { closed = true; node.sentAbort.abort(); });
        });
    }
    const receivers = installReceiver(RED);
    RED.nodes.registerType('sent-new-event', createTrigger(RED, receivers, false));
    RED.nodes.registerType('sent-new-message-received', createTrigger(RED, receivers, true));
    RED.httpAdmin.get('/sent/accounts/:account/:resource', RED.auth.needsPermission('sent.read'), async (req, res) => {
        const account = RED.nodes.getNode(req.params.account);
        if (!account || account.type !== 'sent-account') return res.status(404).json({error: 'Deploy the Sent Account first'});
        try {
            const resource = req.params.resource;
            if (resource === 'status') {
                const data = await account.authenticate(true);
                return res.json({ok: true, type: data.type, name: data.name});
            }
            const profile = await account.profile(req.query.profile || '');
            const page = integer(req.query.page || 1, 'Page', 10000);
            const search = String(req.query.search || '').slice(0, 200);
            let result;
            if (resource === 'profiles') result = await account.request('GET', '/v3/sender-profiles', {query: {page, page_size: 50}});
            else if (resource === 'templates') result = await account.request('GET', '/v3/templates', {profile, query: {page, page_size: 50, search, status: 'APPROVED'}});
            else if (resource === 'template') result = await account.request('GET', '/v3/templates/' + id(req.query.id, 'Template ID'), {profile});
            else if (resource === 'events') result = await account.request('GET', '/v3/webhooks/event-types', {profile});
            else return res.sendStatus(404);
            return res.json(account.sanitize(result.data));
        } catch (error) { res.status(error.sent?.statusCode === 401 ? 401 : 400).json({error: account.sanitize(error.message)}); }
    });
};
