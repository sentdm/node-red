'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = require('../package.json');
describe('Public package boundaries', () => {
    it('uses the official package name and a single authorized repository', () => {
        assert.equal(manifest.name, '@sentdm/node-red-sent');
        assert.equal(manifest.repository.url, 'git+https://github.com/sentdm/node-red.git');
        assert.equal(manifest.bugs.url, 'https://github.com/sentdm/node-red/issues');
        assert.equal(manifest.homepage, 'https://github.com/sentdm/node-red#readme');
    });
    it('allowlists individual package files and excludes installation hooks', () => {
        assert.ok(manifest.files.every(p => !p.endsWith('/') && !p.includes('*') && fs.statSync(p).isFile()));
        for (const key of ['preinstall', 'install', 'postinstall', 'prepublish', 'prepare']) assert.equal(manifest.scripts[key], undefined);
    });
    for (const file of ['sent-demo.json', 'sent-live-sandbox.json']) {
        it(file + ' never sends live messages or logs responses to the console by default', () => {
            const flow = JSON.parse(fs.readFileSync('examples/' + file));
            for (const node of flow) {
                if (node.type === 'sent-send-message') {assert.equal(node.sandbox, true);assert.equal(node.sandboxType, 'bool');}
                if (node.type === 'debug') assert.equal(node.console, false);
                if (node.type === 'sent-account' && file === 'sent-demo.json') assert.equal(node.useEnv, false);
                assert.equal(node.credentials, undefined);
            }
        });
    }
});
