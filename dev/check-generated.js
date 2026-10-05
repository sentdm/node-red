'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
// Render inside an ignored project-local directory; leave checked-in files intact.
const directory = fs.mkdtempSync(path.resolve('.test-runtime-generated-'));
try {
    fs.mkdirSync(path.join(directory, 'nodes'));
    fs.mkdirSync(path.join(directory, 'dev'));
    fs.copyFileSync('dev/editor-runtime.js', path.join(directory, 'dev/editor-runtime.js'));
    for (const script of ['build-editor.js', 'build-flows.js']) {
        execFileSync(process.execPath, [path.resolve('dev', script)], {cwd: directory, stdio: 'pipe'});
    }
    for (const file of ['nodes/sent.html', 'examples/sent-demo.json', 'examples/sent-live-sandbox.json']) {
        assert.deepEqual(fs.readFileSync(file), fs.readFileSync(path.join(directory, file)), file + ' is stale; run npm run build');
    }
    console.log('Editor and both examples match their sources on ' + os.platform());
} finally {
    fs.rmSync(directory, {recursive: true, force: true});
}
