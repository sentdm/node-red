# Sent for Node-RED

Eight messaging actions and two verified webhook triggers for Node-RED 5, sharing a secure **Sent Account** configuration. Sent provides a unified API for SMS, WhatsApp and RCS messaging, templates, contacts and delivery events.

This package targets Node-RED 5 and the deployed Sent v3 API. Contract verification uses the [official upstream OpenAPI](https://api.sent.dm/swagger/v3/swagger.json), linked by Sent's [OpenAPI documentation](https://docs.sent.dm/reference/api/openapi-spec). The automated suite covers local workflows, signed webhook verification and negative security cases. Account policy gates can still block an accepted message; HTTP acceptance does not prove carrier delivery. Reproduce the checks described in [CONTRIBUTING.md](https://github.com/sentdm/node-red/blob/main/CONTRIBUTING.md).

## Install the package into your Node-RED user directory

Requires Node.js 22.9 or later and Node-RED 5.0.7 or later within the 5.x series.

Install the published package from npm in your Node-RED user directory (usually `~/.node-red`):

```sh
cd ~/.node-red
npm install @sentdm/node-red-sent
```

If you start Node-RED with a custom `--userDir`, run the install command in that directory instead.

Restart Node-RED. The **Sent** palette contains ten nodes. Examples appear in **Import → Examples → @sentdm/node-red-sent**. Only standard Node-RED core nodes are needed. Do not run the mock example against a live account; import `sent-live-sandbox` for a live setup.

## Configure a Sent Account

Add a Sent node, then create its **Sent Account**. Enter your current UUID API key in the password field, save, and deploy. In the account dialog, **Check connection** validates `GET /v3/me` using the deployed credentials and reports account type/name. Newly edited credentials take effect after deployment. A missing key or rejected authentication is reported through Catch when a request runs.

Node-RED stores the key as a password credential separately from flow JSON. Stored keys are not returned to editor JavaScript. Alternatively, select **Use SENT_API_KEY** and provide that variable to the Node-RED process through your normal secret management. The value is not placed in an exported flow. For disk credentials, configure Node-RED's `credentialSecret` and protect its user directory.

Production requests always use `https://api.sent.dm`. There is no editable base URL. The private mock transport requires `SENT_NODE_RED_DEVELOPMENT=1`, a server-only `sentDevelopment` setting, literal loopback, and the fixed development credential. It refuses live credentials. The mock server is excluded from the tarball.

## Actions

| Node | Operation | Main input |
| --- | --- | --- |
| Get Account | `GET /v3/me` | Any msg; no parameters |
| Send Message | `POST /v3/messages` | Recipients, Template or Free-form text |
| Get Message Status | `GET /v3/messages/{id}` | Fixed UUID or `msg.payload.message_id` |
| Get Message Activities | `GET /v3/messages/{id}/activities` | Fixed UUID or `msg.payload.message_id` |
| List Contacts | `GET /v3/contacts` | page, page_size, search, channel, phone |
| Get Contact | `GET /v3/contacts/{id}` | Fixed UUID or `msg.payload.id` |
| Get Phone Number Details | `GET /v3/numbers/lookup/{phoneNumber}` | E.164 string or `msg.payload.phone` |
| Custom API Call | Relative `/v3/...` | Method, path, JSON query/body |

Fields with typed selectors can read `msg`, literal strings, JSON, numbers, booleans or environment variables. A `msg` field contains the property path, such as `payload.message_id`, not a Mustache expression. List Contacts returns one bounded page; inspect `payload.pagination` and supply the next page deliberately. Page size is limited to 100 by this integration. No automatic unbounded “return all” mode is included.

All actions preserve the incoming `msg`, replace `msg.payload` with Sent's `data`, and merge diagnostics into `msg.sent`: `statusCode`, `meta`, `requestId`, `responseTime`, `apiVersion`, `profileId`, `sandbox`, `idempotentReplayed`, `originalRequestId`. Custom API Call preserves a non-envelope body. API key and signing-secret fields are redacted even when a custom endpoint returns them.

Failures go to Node-RED Catch nodes and add `msg.sent.error` with available HTTP status, code, message, details, `doc_url`, request ID and `retryAfter`. Do not interpret a green “accepted” status or HTTP 202 as successful delivery. Accepted messages may later become BLOCKED or FAILED.

## Sender Profiles and templates

Organization keys can scope actions and triggers to a child Sender Profile through `x-profile-id`. Select **Load profiles** to discover `/v3/sender-profiles`, use **Next page**, or enter a manual UUID. A profile-scoped or standalone key must leave profile blank. The package checks `/v3/me` before applying organization-style scope. Get Account always reads the actual credential's account without a profile parameter.

In **Template** mode, choose a manual template ID/name or search approved templates. Search uses `/v3/templates?status=APPROVED` with page/page_size and the selected fixed profile. Selecting a template reads `/v3/templates/{id}` and exposes its declared variables as individually typed fields. The Parameters JSON/msg object also supports dynamic parameters. Individual variable fields override matching keys in that object. Keep one source for each parameter to avoid unintended overrides.

Dynamic profile/template IDs work at runtime. Editor discovery requires a fixed profile so it can know which catalogue to show. If discovery fails, manual entry remains available. Browser lookups call protected Node-RED admin routes; they never call Sent with a credential.

## Free-form messages, channels and sandbox

**Free-form text** sends `text` instead of a template. Recipients accept one E.164 string, comma-separated values or an array. Channels accept `sent`, `sms`, `whatsapp`, `rcs`, comma-separated values or a JSON/msg array. Multiple channels broadcast separately for each recipient; omitted channels or `sent` use Sent automatic routing.

For SMS, RCS and automatic routing, a contact who has never replied needs an approved template first. That template opens a seven-day free-form window; a previous qualifying reply removes this particular Sent conversation gate. Pinned WhatsApp free-form instead requires a recent inbound WhatsApp message within Meta's 24-hour window. The integration leaves eligibility decisions to Sent. See [conversation-window errors](https://docs.sent.dm/reference/api/errors#conversation-window-codes). See the [current send contract](https://docs.sent.dm/reference/api/messages/SentDmServicesEndpointsCustomerAPIv3MessagesSendMessageV3Endpoint).

Set **Sandbox** to true for validation without real side effects. Custom API mutations can include `sandbox: true` in their body where supported. Sandbox-created IDs are simulated and may not persist; do not use them to claim successful status/activity or webhook delivery tests. The local mock end-to-end demo deliberately uses its own in-memory persistent fixture messages; its behavior is not presented as Sent sandbox persistence.

## Retry and idempotency behavior

GET operations retry transient network errors, HTTP 429 and server errors at most twice. POST/PUT/PATCH retry only when protected by an idempotency key, reusing exactly the same serialized request body and key. `CONFLICT_001` is retried with that same key. Other conflicts and validation/authentication errors fail immediately. DELETE is not automatically retried.

Send Message automatically derives a key from node ID, `msg._msgid`, body and scope when no explicit key is supplied. Reusing an identical msg identity/body produces the same key. If `_msgid` is absent, a fresh operation ID is used. Custom mutations need an explicit key to enable automatic retries. Keys allow 1–255 alphanumeric, hyphen or underscore characters. Sent caches successful idempotent responses for 24 hours and does not compare bodies; never reuse a key for a different operation. See [Sent idempotency](https://docs.sent.dm/reference/api/idempotency).

Requests are paced per shared Sent Account configuration (about 193 requests/min, with a slower lane for webhook operations). Separate config nodes do not share that local budget; server limits remain authoritative. Backoff includes jitter and honors Retry-After. If Retry-After exceeds 60 seconds, the current operation fails with structured retry metadata instead of retrying early; the account pauses later requests until the indicated time. Downstream flows can schedule a later retry with the original key. Requests time out after 15 seconds and responses are limited to 5 MiB. Closing a node cancels its queued actions and registration requests; deletion cleanup has its own bounded deadline.

## Webhooks: required raw-body setup

Node-RED 5.0.7 mounts its editor/admin app before its HTTP-node app. With the default admin root `/`, the admin JSON parser can consume webhook bodies before a custom node sees them. The core HTTP In node's “skip body parsing” setting is private to that node and does not automatically apply here.

Add this supported early middleware to your Node-RED `settings.js`, then restart Node-RED:

```js
const sentRawBody = require('@sentdm/node-red-sent/nodes/lib/raw-body');
module.exports = {
    // Merge these fields into your existing settings object.
    httpNodeRoot: '/api',
    httpAdminMiddleware: sentRawBody({ httpNodeRoot: '/api' }),
    sentWebhookBaseUrl: process.env.SENT_WEBHOOK_BASE_URL,
    sentInstanceId: process.env.SENT_INSTANCE_ID,
    contextStorage: { default: { module: 'localfilesystem' } }
};
```

If you already have `httpAdminMiddleware`, place `sentRawBody(...)` **first** in its middleware array. It only captures POSTs under `/api/sent/webhooks/`, leaves other routes alone, rejects compression, and enforces a 1 MiB limit. Set the same `httpNodeRoot` in both locations. If you isolate `httpAdminRoot` under a non-overlapping path, the route-local raw parser can read the stream directly. The receiver fails closed when earlier middleware has already consumed the bytes. Never reserialize JSON for HMAC verification.

Set `SENT_WEBHOOK_BASE_URL` to the public HTTPS **origin**, without a path; the package appends `httpNodeRoot` and its deterministic receiver path. Real Sent rejects loopback and private destinations. For localhost, use a disposable HTTPS tunnel that exposes only the webhook receiver path. Do not expose an unauthenticated Node-RED editor. A tunnel is a development prerequisite, not a package dependency. Stop the tunnel after QA and remove any remaining test subscriptions.

Use a stable, unique `SENT_INSTANCE_ID` for each runtime installation. If absent, the user-directory path is used. Moving the user directory or changing instance/account/profile/node identities changes ownership; remove old subscriptions before doing that. Multiple runtime processes must not share a trigger identity.

**New Event** accepts selected `message.*` subtypes, the entire `message` family, or `templates`, with optional template-name filters. Dynamic event lookup uses `/v3/webhooks/event-types`. **New Message Received** always registers only `message.received`. Selection is converted into canonical `event_types` parents and `event_filters` suffixes.

On deploy, a trigger lists and deletes only exact ownership matches, creates its webhook and keeps the returned signing secret in memory. It becomes blue/active only after success. Closing deletes its own subscription. After a crash, a new deployment removes matching stale subscriptions and recreates them because a read may return `signing_secret: null`. Cleanup scans at most 2,000 search results and fails rather than registering endlessly. A cleanup failure is logged without secrets and is retried through orphan recovery on the next deployment. API permission failures require fixing the account and redeploying.

The receiver verifies the exact bytes using HMAC-SHA256 over `id.timestamp.rawBody`, base64-decoded `whsec_` secret, constant-time comparison, matching webhook ID, and a five-minute timestamp window. It validates the envelope and event header, then acknowledges before downstream dispatch. Verified ignored/duplicate events still receive 2xx.

Trigger outputs contain the full event in `msg.payload`, `event.event` or `event.field` in `msg.topic`, and non-secret ID/type/timestamp/dedupe metadata under `msg.sent.webhook`.

Dedupe uses inbound message ID; outbound message ID + status; template ID + status; otherwise an envelope hash. It retains approximately seven days, bounded to 10,000 entries per trigger (oldest entries can be evicted earlier at capacity). Configure a synchronous context store such as `localfilesystem` for restart persistence; default memory context resets. Filesystem context flushes asynchronously, so a crash may lose recent cache updates. Node removal may delete its context. This is an acknowledgment-first integration, not a durable queue: downstream processing must remain idempotent, and a crash after acknowledgment can lose in-flight work. Use a durable application queue when that guarantee is required.

## Live QA

```sh
# Supply SENT_API_KEY securely in the process environment first.
# For triggers, also supply SENT_WEBHOOK_BASE_URL and SENT_INSTANCE_ID.
npm run demo:live
```

The live demo does not automatically inject actions. All provided sends have sandbox true. Set a valid contact or existing message ID before running those read examples. Number lookup can incur provider usage; choose a number you are authorized to query. Live webhook registration happens on deploy when the public URL is configured. Without a public URL, triggers show configuration errors and actions remain usable. Use Sent's `/v3/webhooks/{id}/test` or dashboard Test action to prove a real signed request reaches the receiver. Stop Node-RED normally to delete owned subscriptions. No real message is sent just to obtain an ID.

## Troubleshooting and security

- **Unknown node type:** ensure `@sentdm/node-red-sent` was installed in the user directory used by Node-RED, and restart. Check startup logs.
- **Options unavailable:** save and deploy the account, check authentication, confirm organization scope, then use manual IDs if the service is unavailable.
- **Webhook HTTP 500/raw body unavailable:** install the early middleware above before any body parser; restart, then redeploy.
- **Webhook 401:** check clock synchronization, raw-byte preservation, current ownership ID and newly issued secret. Old secrets intentionally fail after recreation.
- **429:** inspect `sent.error.retryAfter`; don't create a tight retry loop.
- **202 followed by BLOCKED:** check conversation eligibility, template approval and account standing/balance. For an SMS contact who has never replied, send an approved template before free-form text. Status and activities show the outcome, but Sent currently does not expose every internal reason code. If the cause remains unclear, give Sent support the message ID and request ID. Acceptance is not delivery.
- **Orphaned subscription:** restart with the original instance/account/profile/node IDs for automatic cleanup, or remove that owned webhook in Sent.

Configure Node-RED `adminAuth` in shared deployments. Lookups require the `sent.read` permission (or `*`). HTTP-node Basic Auth is separate and must be configured compatibly with Sent's webhook sender; HMAC verification is always enforced. Keep the editor and secrets off a public webhook tunnel. See [SECURITY.md](SECURITY.md).

## Development and release preparation

Production code is in `nodes/`; editor generation and the mock/demo harness are in `dev/`; tests use the official `node-red-node-test-helper`. Run `node dev/build-editor.js` after changing editor source and `node dev/build-flows.js` after changing examples. Run tests/lint, then `npm run qa:fresh`. Inspect `qa/pack-manifest.json` before any release. Package allowlisting excludes mock, tests, research, logs, local user directories and credentials.

Node.js 24 and Node-RED 5.0.7 are the tested development versions. Package engines require Node.js >=22.9 and Node-RED >=5.0.7 <6; this is not a claim that every version combination has been tested. Source and issue tracking are maintained at [sentdm/node-red](https://github.com/sentdm/node-red). This package includes the MIT license and Sent icon. Publishing to npm and submission to the Node-RED Flow Library are separate release actions; the demo and test scripts do not publish.

### Start the local demonstration

From a clone of the [source repository](https://github.com/sentdm/node-red), use Node.js 24 (minimum 22.9) and npm:

```sh
npm ci
npm test
npm run lint
npm run demo:mock
```

Open [localhost:1880](http://localhost:1880). The command packs the actual package, installs that tarball and Node-RED 5.0.7 in project-local `.demo/`, starts the mock on loopback port 1881, deploys examples, exercises all ten user-facing nodes, and keeps Node-RED running. It does not use `~/.node-red`. Both ports must be available. Stop with Ctrl-C to delete mock subscriptions and stop both servers. Re-running resets the supplied demonstration flows; export your edits first. `.demo/` retains Node-RED context/settings but is excluded from npm and git.

The three tabs are **Sent - Actions**, **Sent - Webhooks**, and **Sent - End to End**. Click an Inject button to run an action; open Debug to inspect its complete message. On Webhooks, **Generate signed samples** sends fresh, correctly signed local mock requests through both real trigger receivers. The end-to-end example extracts the accepted recipient ID before reading status and activities. Fictional +1 202-555-01xx numbers are used throughout. Packaged examples keep sends in sandbox and console logging disabled; the mock-only runner enables persistent fixture sends and local diagnostic logging using its fixed fake credential. The packaged mock account does not automatically use a live environment credential.

`npm run qa:fresh` creates a new `.fresh-*` directory, installs the tarball with a fresh Node-RED runtime, executes and verifies examples, writes evidence under `qa/`, and stops that runtime. Stop any existing demo before running this command.

### Test a local tarball

To test local source changes, build and install a tarball:

```sh
# In this package's source directory:
npm pack
# In your chosen Node-RED user directory:
npm install /absolute/path/to/TARBALL_FILENAME.tgz
```

Replace `/absolute/path/to/TARBALL_FILENAME.tgz` with the full path to the tarball printed by `npm pack`. Restart Node-RED after installation. The local demo and test tools require the source repository and are not included in the published package.
