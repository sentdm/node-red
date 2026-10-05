const js = require('@eslint/js');
const globals = require('globals');
module.exports = [js.configs.recommended, {files:['dev/editor-runtime.js'], languageOptions:{globals:{...globals.browser,RED:'readonly',$:'readonly',definitions:'readonly'}}}, {languageOptions: {ecmaVersion: 2024, sourceType: 'commonjs', globals: {...globals.node, ...globals.mocha}}, rules: {'no-control-regex': 'off', 'no-unused-vars': ['error', {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_'}]}}];
