# Security properties and deployment requirements

- API keys use Node-RED password credentials or an explicitly selected server environment variable. They are absent from exported flows. Protect Node-RED's credential encryption key and user directory.
- Authenticated API traffic is pinned to https://api.sent.dm. Custom API paths must remain relative /v3 paths. Traversal, absolute/protocol-relative URLs, encoded separator tricks, framing/header overrides and redirects are refused. Custom headers allow only Accept-Language.
- Sender Profile scope is a dedicated option and requires a verified organization account. The current /v3/sender-profiles endpoint is used.
- Admin lookups use RED.httpAdmin and RED.auth.needsPermission('sent.read'). Configure Node-RED adminAuth; a server with anonymous administrative access remains anonymous by the administrator's choice. There is no credential-bearing direct browser call to Sent.
- Webhook secrets exist only in each trigger's server-side closure. Read/flow output paths redact signing_secret and api_key fields and any reflected configured credential. The receiver never returns raw signatures or secrets in an error.
- HMAC verification uses exact raw Buffer bytes, base64 secret decoding, timingSafeEqual, the expected subscription ID, and ±300-second replay protection. Compressed and oversized webhook bodies are rejected. See README for the mandatory early raw-body settings hook when the editor/admin root overlaps the receiver.
- Each trigger owns a deterministic subscription identity; only exact matching identities are eligible for orphan cleanup. Do not run two processes with the same instance/account/profile/node identity. Moving an instance or changing identity requires cleaning old subscriptions first.
- Dedupe is seven days and at most 10,000 entries per trigger. Context persistence depends on the selected synchronous store. It is not a durable delivery queue and cannot guarantee exactly-once business processing.
- Requests have bounded retries and 15-second network timeouts. Mutation retries require stable idempotency keys. Errors redact credentials and preserve structured diagnostics.
- Local demo servers bind to loopback. Development transport requires an explicit process switch, loopback-only URL and a fixed fake development credential; real credentials are refused with that transport. The mock server is not shipped.

If reporting a vulnerability, share a minimal sanitized reproduction with the package maintainers through an appropriate private channel. Do not post API keys, signing secrets, recipient content or private phone numbers in public issues. Coordinate a private reporting channel with Sent before sharing sensitive details; do not assume public GitHub issues are private.

See the [contributor guide](https://github.com/sentdm/node-red/blob/main/CONTRIBUTING.md) for reproducible checks. Local reports, credentials and runtime directories are deliberately excluded from version control and the npm package.

## Upstream development dependency advisories

The 2026-10-05 review of version 0.1.0 found four vulnerable packages in the development
tree. The full `npm audit` still reports them; they have not been suppressed or patched
by overriding npm's bundled files. All four enter through this development dependency:

`node-red@5.0.7 → @node-red/runtime@5.0.7 → @node-red/registry@5.0.7 → npm@11.19.1`

| npm dependency branch | Integration reachability |
| --- | --- |
| `minimatch@10.2.5 → brace-expansion@5.0.9` | Sent does not expand user input as glob patterns. The parser CPU/stack exhaustion advisories concern npm tooling, not Sent flow execution. |
| `make-fetch-happen@15.0.6 → http-cache-semantics@4.2.0` | Sent has no HTTP response cache and does not accept custom cache-control headers. The shared-cache disclosure path is absent. |
| `node-gyp@12.4.0 → undici@6.28.0` | Sent imports neither this copy nor node-gyp. It has no native build/install hooks, WebSocket client, retry interceptor or HTTP response proxy. |
| `make-fetch-happen@15.0.6 → @npmcli/agent@4.0.2 → socks-proxy-agent@8.0.5 → socks@2.8.9 → ip-address@10.5.0` | Sent does not use this parser or its address classifiers. The transport uses a fixed API origin and refuses redirects. |

The npm tarball contains no dependencies bundled as files. A normal clean tarball install
installs only this package, `raw-body` and its dependencies; none of the four packages,
Node-RED or npm is installed by it. Both the production audit and the clean consumer audit
reported zero advisories at the review date. This does not make the development audit clean.

Node-RED is a separately installed host. Its palette manager can run its own npm copy,
including vulnerable tooling; this review does not certify that host against malicious
package metadata, workspaces or other installed nodes. Keep Node-RED and npm updated.
Node's built-in Undici, used by global `fetch`, is also separate from the audited npm copy
and is not assessed by `npm audit`. The relevant Undici advisories require a WebSocket client
or enabled retry interception plus unsafe downstream HTTP framing. Sent uses neither:
retries issue fresh requests, and outputs contain parsed data and selected metadata,
without upstream HTTP framing headers. Other nodes can use different features or modify
process globals; keep Node itself patched as well.

Reassess this conclusion if the dependency tree, transport, cache, proxy, build hooks or
supported host versions change. These are documented upstream development findings, not
a general exemption for transitive dependencies or a guarantee against unknown issues.
