# Development and review

Use Node.js 24 and the Node-RED version pinned in `package.json`. Install the
locked dependencies with `npm ci --ignore-scripts`. The integration has no
install scripts and does not require a global Node-RED installation.

Run these checks from the source directory:

```sh
npm test
npm run lint
npm run check:generated
npm run qa:contract
npm audit
npm audit --omit=dev
npm pack --dry-run --json
npm run qa:fresh
```

Node-RED 5.0.7 pins several transitive development packages below their security fixes.
The root `overrides` selects compatible patched majors for axios, moment, multer,
and qs. The fresh demo applies the same overrides. These are development-only
dependencies; consumer installations do not inherit npm overrides from a dependency.
Recheck and remove each override when upstream pins a patched version. Administrators
must separately keep their own Node-RED host and dependencies patched.
Four additional findings remain inside npm bundled by the development Node-RED
registry component. See [their scope and reachability](SECURITY.md#upstream-development-dependency-advisories).
Keep the full audit result visible; a clean production audit alone does not resolve
a finding without tracing the installed copy and its vulnerable functionality.

There is no TypeScript build. ESLint checks the JavaScript runtime, editor source,
development tools and tests. `qa:contract` fetches the public deployed OpenAPI
without authentication and saves its snapshot and structural audit under `qa/`.
Network failures or contract changes fail that check; investigate them before a
release rather than substituting an old result.

`qa:fresh` needs ports 1880 and 1881 free. It packs and installs the actual package
inside a new project-local directory, loads all eleven registered node types,
exercises actions and signed webhook requests, and checks subscription cleanup.
Tests use fictional identities and loopback mocks. They do not send real messages.
Live delivery testing is a separate, explicitly authorized activity.

Run `npm run build` after changing editor sources or example generation. Commit
the generated HTML and example JSON with their generators. `check:generated`
compares them without modifying the checked-in files.

## Public-file boundaries

Git and npm use explicit allowlists. Adding a public source file requires updating
`.gitignore`; changing runtime package contents requires updating `package.json`.
Review both lists and the complete staged diff. Do not force-add ignored files.
Local QA results, research downloads, runtime directories, credentials, logs and
archives must remain local. Never include real keys, customer identities, message
contents, private URLs or personal filesystem paths in tests, examples or issues.

The mock UUIDs and NANP 202-555-01xx numbers are synthetic fixtures. Runtime output
can legitimately contain customer data returned by Sent; deployments must protect
flow context, Debug output and downstream storage. Redaction of credentials does
not make arbitrary message payloads public-safe.

## Release review

Use the configured human Git identity. Confirm functional checks pass, dependency
advisories are fixed or explicitly demonstrated not to affect this package's consumers,
generated files match, and the tarball contains only the
reviewed runtime, editor, icon, examples, README, security guidance, license and
package manifest. Check compatibility and the documented webhook setup on the
target Node-RED version. Do not claim coverage of untested runtime versions or
messaging channels.

The source repository is https://github.com/sentdm/node-red. npm publication and
Node-RED Flow Library submission are separate maintainer actions; no development
or validation script publishes a package, creates a release, or changes repository
settings. Publishing requires explicit authorization and npm scope access.
