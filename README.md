# Lake Arrowhead . Town

A Cloudflare Worker publishes community news, supports caller-scoped batch retraction, and hosts uploaded images. The homepage preserves the existing design and five selectable themes.

```text
POST /api/digests[?dry_run=true] → validate + serialized dedup → preview or atomic publication
GET  /api/digests?client_ref=... → authenticate → committed batch identity and state
POST /api/posts/:post_id/retract → authenticate owner + 24-hour window → atomic retraction
GET  /api/posts   → authenticate → committed snapshot → recent stories and updates
POST /api/posts/:post_id/items/:item_index/updates → serialized publisher → source revision + snapshot
POST /api/images  → authenticate and validate → R2 image → public image URL
POST /api/rebuild → durable background job → migrate legacy sources → rebuild the same snapshot
GET  /           → read published HTML from R2
```

New posts rebuild the homepage without a Git commit, deployment, or CI run. New story URLs append to the feed. Exact source URLs on stories retained in the 30-day history are skipped, including URLs attached as updates; changed wording at the same URL is also skipped.

## Traffic and power alerts

The homepage displays separate **Traffic** and **Power** lists above stories, sorted by latest observation within each list. Rows expand to show the latest effective details and official source. Current and upcoming notices appear; empty groups disappear. Recurring work notices cover the entire announced period, with daily work hours in `detail`. Scheduled power notices remain scheduled until an explicit stage update confirms power is off. Alerts and weather are composed into the stored homepage when sources change. Page visits serve that completed HTML without reading alert or weather state. Visitors reload to see a new publication. A failed derived homepage write preserves the previous complete page and durable pending intent for the next source event or manual rebuild.

The external watcher collects and verifies conditions. This server does not poll traffic or power providers. Use the existing `Authorization: Bearer <API_SECRET>` credential. All API replies include `request_id`, `X-Request-ID`, `X-API-Version: 3`, and no-store headers. Public pages require no credential.

| Endpoint | Behavior |
| --- | --- |
| `POST /api/alerts` | Publish one opening, update, confirmation, or resolution immediately. |
| `POST /api/alerts?dry_run=true` | Validate and preview the effective alert and expiry with zero writes. |
| `GET /api/alerts?days=30` | Read effective state and history, 20 alerts per page; `fields=index` omits history/detail. |
| `GET`/`HEAD /api/alerts/{alert_id}` | Read one retained identity with full or compact fields. |
| `POST /api/alerts/confirmations` | Batch 1–100 checks with independent outcomes and one publication commit; supports dry-run. |
| `GET /api/alerts?client_ref=...` | Recover a committed submission after a timeout, including retracted submissions. |
| `POST /api/alerts/ALERT_ID/entries/ENTRY_ID/retract` | Undo one submission within its original 24-hour receipt window. |

### Submission fields

Each submission requires `client_ref`, `phase`, `source`, `source_url`, and `observed_at`. Phases are `open`, `update`, and `resolved`. `source` is `caltrans`, `nws`, or `sce`; `source_url` is an absolute HTTP(S) URL without embedded credentials. Every timestamp requires an explicit timezone. Requests must be UTF-8 JSON and fit within 1 MiB. Plain text is escaped and Markdown details disable raw HTML and unsafe links.

An opening also requires `category`, `kind`, `headline`, and its location/status fields. Omit `alert_id` on openings; updates and resolutions require the returned `alert_id`. Both `category` and `kind` stay fixed for that alert. Other public fields may be corrected. Updates inherit omitted values; explicit `null` clears optional fields. Nested `power` patches preserve omitted members. An update must leave the effective alert valid. Observations older than the latest surviving observation return `409 stale_observation`.

| Category | Kinds | Additional fields |
| --- | --- | --- |
| `traffic` | `closure`, `chain-control`, `one-way`, `construction`, `storm`, `hazard` | `routes` and/or a named `area`; chain controls require `chain_level` (`R1`, `R2`, `R3`). |
| `power` | `outage`, `planned-outage`, `psps` | Required named `area` and `power.stage`; optional `power.customer_count`. |

Supported routes are `SR-18`, `SR-189`, `SR-330`, `SR-138`, and `SR-173`. A notice may list several routes once, or use an `area` such as “San Bernardino Mountains” without enumerating roads. Power alerts use an area rather than road fields.

Power stages are separate from the alert lifecycle: `outage` requires `in-effect`; `planned-outage` supports `scheduled` and `in-effect`; `psps` supports `watch`, `warning`, `scheduled`, and `in-effect`. The server never infers that power is off from the passage of `starts_at`. Customer counts are nonnegative integers, labeled “potentially affected” until the stage is `in-effect`. Use optional `source_event_id` for the provider outage or warning ID. It is metadata, not a deduplication key.

Shared optional fields are Markdown `detail`, `starts_at`, `expected_end`, and `source_event_id`. For power, `expected_end` is the estimated restoration or end of the notice. It must not precede `starts_at`. See [traffic](examples/traffic-alert.json), [planned power](examples/power-alert.json), and [PSPS](examples/psps-alert.json) examples. The examples are illustrative; replace them with verified observations and fresh timestamps before submitting.

Success is `200` with `ok`, `request_id`, `alert_id`, `entry_id`, `client_ref`, submission `status`, effective `state`, **`expires_at`**, the submitted `entry`, and `alert` containing the effective fields and full `history`. Submission statuses are `published` and `duplicate`; lookup uses `found`. Preview replies also have `dry_run: true`, `committed: false`, and `checked_at`. Preview UUIDs are provisional; persist IDs from the committed response or lookup.

### Expiry and required confirmations

Lifecycle states are `open`, `resolved`, `expired-unconfirmed`, and `retracted`. Upcoming timing and power stages are independent. `expires_at` is returned by submissions, lookups, lists, retractions, and previews:

- With `expected_end`: `expires_at = expected_end + 24 elapsed hours`.
- Without `expected_end`: `expires_at = latest surviving observed_at + 24 elapsed hours`, even for an upcoming notice.
- Resolved or retracted: `expires_at = null`.

At the exact deadline, an unconfirmed alert becomes `expired-unconfirmed` in API reads. The static homepage retains its built snapshot until the next source-driven or manual build; it displays the snapshot time and confirmation expiration. No expiration build is scheduled. Conditions-only recomposition retains the existing snapshot time and HTML when only the generated snapshot clock would change, including during a persistent subsystem failure. Relevant recovery/provenance metadata can still change, and pending intent remains until both components render successfully. Healthy component content changes still publish. This adds no expiry or midnight refresh. **The caller must schedule confirmation before the returned `expires_at`**, including when nothing has changed. A strictly change-only watcher is insufficient for open-ended conditions. Confirm an unchanged condition by submitting `phase: "update"` with the existing `alert_id`, a new persisted `client_ref`, and fresh `observed_at`:

```json
{
  "client_ref": "power-confirmation-2026-10-22-01",
  "phase": "update",
  "alert_id": "REPLACE_WITH_COMMITTED_ALERT_ID",
  "source": "sce",
  "source_url": "https://www.sce.com/outages-safety/outage-center/check-outage-status",
  "observed_at": "2026-10-22T09:45:00-07:00"
}
```

A fresh update may reactivate an expired alert on the same identity. If the previous `expected_end` is obsolete, extend it from a verified source or clear it with `"expected_end": null`; a fresh observation alone does not override an inherited end. Always schedule the next check from the newly returned `expires_at`, with enough lead time for retries. Keep `observed_at` as the time of actual verification rather than the time of a later retry.

Resolve only after a confirming observation. Submit the same required fields with a new `client_ref`, existing `alert_id`, `phase: "resolved"`, and optional `detail` such as “Provider confirms power restored” or “Caltrans no longer reports the restriction.” A resolved alert requires a new opening for a later occurrence; it cannot be reopened by update. A new power stage is an ordinary update, for example `"power": { "stage": "in-effect", "customer_count": 125 }` when a scheduled interruption actually begins.

### Batched confirmations and coalesced history

`POST /api/alerts/confirmations[?dry_run=true]` accepts `{ "confirmations": [...] }`, with 1–100 checks and a 1 MiB body limit. Every check contains only `client_ref`, `alert_id`, `source`, `source_url`, and `observed_at`. References share the existing alert namespace. Checks cannot change content, location, power stage, expected end, or lifecycle; use an ordinary update or resolution for those changes. Existing observation ordering, future-time acceptance, expiry, and 30 LA receipt-date retry rules apply. A confirmation does not override an inherited expected end. Expired-unconfirmed alerts may be confirmed; resolved/retracted alerts require a new opening.

**Caller rollout:** committed writes to `POST /api/alerts/confirmations` default to disabled in both environments; ordinary alert updates remain enabled. During this rollout, authenticated batch write attempts with a valid envelope return `503 confirmations_not_enabled` with `publication_status: "not_attempted"`, `retryable: false`, and no `Retry-After`; no checks are committed. Disable automatic HTTP-503 retries for this application code. Keep confirming unchanged conditions through ordinary `POST /api/alerts` requests with `phase: "update"`, as shown above, until the backend operator confirms batching is enabled for your target environment. Callers can prepare and test batches with `POST /api/alerts/confirmations?dry_run=true` while writes are disabled. A successful preview does not prove writes are enabled or reserve state or references. Switch the caller to batch writes only after backend enablement; each environment must be enabled separately.

Continue handling a definite `confirmations_not_enabled` rejection after enablement, including during a later rollback: fall back to ordinary updates for those checks. Persist distinct batch and ordinary-update references for each logical check before sending either form, keep the original verification `observed_at`, and mark the logical check complete once fallback succeeds. Never later submit the abandoned batch form. For example, persist separate `check-123:batch` and `check-123:update` references, each within the existing reference limit. A transport failure or `publication_status: "unknown"` does not authorize fallback; look up the batch references or retry the unchanged batch to avoid duplicate confirmations.

The response returns ordered `items` and `counts: { submitted, confirmed, duplicates, failed }`. Valid checks commit in one snapshot replacement; item errors do not block other checks. `ok: true` means the batch was processed, so inspect every item. Only the first valid check for each alert is eligible within a batch. Envelope errors reject the whole request. An uncertain storage outcome returns a batch-level error with `publication_status`; look up each reference or retry the unchanged batch. Previews return provisional IDs, `dry_run: true`, `committed: false`, and `checked_at`. Duplicate-only, failed-only, and preview batches create no new alert publication.

Full alert reads accept `history=coalesced`, which aggregates consecutive confirmations sharing a content revision and source attribution into entries with `entry_type: "confirmation"`, `retractable: false`, and `confirmation_run` containing run ID, count, first/latest observation and receipt times. `history=full` remains the default and expands each check into an update-shaped entry. Both forms preserve original material updates; old no-change updates are not reclassified. History mode is pinned in pagination cursors; `fields=index` omits history and cannot be combined with a `history` parameter. Compact responses include `confirmation_count` and optional `last_confirmed_at`.

New confirmations cannot be retracted (`403 confirmation_not_retractable`), including through preview. Correct a mistaken condition with an ordinary observation; if a future latest observation prevents correction, contact the operator. Existing material updates retain their original retraction rules. Individual compact immutable check records support reference recovery and legacy expansion; new checks never copy the previous check payloads.

**Operator rollout:** keep `ALERT_CONFIRMATIONS_ENABLED: "false"` while deploying and verifying compatible readers. Then change `env.preview.vars.ALERT_CONFIRMATIONS_ENABLED` in `wrangler.jsonc` to `"true"`, use `npm run deploy:preview`, and run the preview smoke checks. Enable production in a later configuration change only after compatible production readers have fully rolled out and preview verification has passed. Tell API callers which environment is enabled before they switch to batch writes. Alert storage converts lazily to version 2 on confirmation; old objects stay intact. Once conversion begins, roll back only to code supporting both alert storage formats. For local verification, use `npx wrangler dev --env preview --var ALERT_CONFIRMATIONS_ENABLED:true`.

### Retries, reconciliation, and corrections

Persist one exact, case-sensitive `client_ref` per intended submission before sending it; reuse the unchanged payload after timeouts. References are nonblank strings of at most 128 Unicode characters without control characters. References are unique across traffic and power submissions for the original 30 Los Angeles receipt dates, including the receipt date. Alert references have their own namespace, separate from digest references. Appending updates or retracting entries does not extend an older reference’s window. An identical retry returns the original `entry_id` without writes; different content using a retained reference returns `409 client_ref_conflict`, including in dry-run. Object key order and equivalent timestamp offsets/fractional spellings do not affect retry identity. Timestamp comparisons preserve all nine accepted fractional digits; original submitted values remain unchanged. Different intended conditions may share a source URL; URLs are never used to merge alerts. Openings and previews may return advisory `possible_duplicate_alert` warnings with candidate IDs and `source_event_id` or `location` reasons. Provider event identity takes precedence; otherwise routes and normalized area are compared together. Warnings never block or merge openings.

`GET /api/alerts?days=30` supports `days=1..30` and defaults to 30. It includes every current or upcoming alert regardless of its opening date, plus conditions with server-received activity or retractions in the selected LA receipt-date window. Each result includes the entire history, original entry/client references, and retraction timestamps. `published_at` identifies the last committed alert operation; `as_of` fixes the time used to derive expiry. Follow `next_cursor` until null, preserving `days` or omitting it. Signed cursors pin both snapshot and `as_of`, so intervening publication, retraction, or expiry cannot skip or change later pages. Start a new read to obtain newer state. Use `fields=index` for effective fields, revision, latest receipt time, and confirmation summary without Markdown details or history. `fields=full` is the default; the representation is pinned in pagination cursors. `GET`/`HEAD /api/alerts/{alert_id}` reads one retained alert directly, including identities outside the collection date window, with the same `fields` choices. Reference lookup accepts one `client_ref` without `days`, `cursor`, or `fields`.

Ordinary alert submissions and entry retractions, including previews, accept `history=full|coalesced`. The default remains full history; opt into coalesced mutation replies to avoid loading every confirmation payload. Full-history cost remains proportional to the history requested.

Retraction uses the exact token that published the target entry and must first commit less than 24 elapsed hours after that entry’s server receipt. Token rotation loses self-retraction access to older-token entries. Retracting an update or resolution replays surviving entries and can reopen or expire the condition; retracting an opening removes the whole alert. History is preserved. If later field-clearing updates depend on the target change, correct their effective fields before retraction (`409 retraction_dependency_conflict`). Repeated authorized retractions return `already_retracted`, including after the initial deadline. Retraction accepts `?dry_run=true` to preview the resulting effective alert and expiry with `committed: false` and `checked_at`, without publication or homepage-intent writes. Authorization, deadlines, and dependency validation still apply, and execution rechecks current state. After the deadline, an operator must repair the immutable alert revision and atomically publish a replacement snapshot rather than editing story sources. Then run and await a normal homepage rebuild: replacing private alert state alone does not refresh the stored banner.

Alert revisions and snapshots are independent of story and calendar storage. Only replacement of `alerts/current.json` commits an operation; orphan artifacts do not create receipts or public conditions. An uncertain write response may have committed: look up `client_ref` or retry unchanged. Reads and public history never expose publishing-token fingerprints. Existing Worker logs include sanitized alert operations and conditions composition failures.

## Homepage weather

Open Sun publishes `town-card.json` (schema version 1) alongside its other data files at `https://raw.githubusercontent.com/hbmartin/open-sun/data/town-card.json`. The document carries station identity, explicit imperial units, true observation/rainfall dates, forecast issue time, a short outlook, and 24 absolute hourly timestamps with fractional rain probabilities and normalized 90%/60%/30% temperature intervals. The shared fixture in `test/fixtures/town-card.json` is also tested by Open Sun's Python publisher and TypeScript weather helpers.

Production and preview independently poll every ten minutes with conditional requests. A valid changed document is stored privately as `weather/town-card.json` and triggers a conditions-only replacement of the homepage. Malformed stored weather can be replaced by a valid upstream document; its old ETag is not used conditionally. Upstream fetching occurs outside the publisher queue, and stale concurrent responses cannot replace newer data. Invalid versions, station identity, units, hourly spacing, probabilities or bands are rejected; failures retain the last accepted data and complete page. An unchanged document makes no homepage write, except to recover an already pending source-driven composition. Logs include `weather_pull`, `weather_pull_failed`, `conditions_composed`, and `conditions_composition_failed`.

The weather card is full-width with its 24-hour chart on desktops without alerts. With alerts, the desktop row is 60% alerts / 40% weather. Below 960px, alerts stack above a compact weather summary. Clicking the compact card or its keyboard-accessible button opens a separate details card; without JavaScript details are visible. The chart is pre-rendered SVG, scrolls horizontally when needed, and has accessible hourly values. Its window and all displayed conditions remain anchored to the publication; there are no browser data requests or scheduled expiry, aging, midnight or chart-advancement builds. Existing theme/font and news timestamp interactions continue independently.

Weather/alert-only replacements preserve news HTML, footer publication dates, RSS/archive references and storage metadata. News publication and template rebuilds also compose current conditions. If auxiliary data fails, otherwise valid news publishes with an accessible conditions-unavailable notice and private pending-recovery metadata; source-read APIs still report their errors. Alerts and weather render independently: healthy components remain visible while failed components receive accessible unavailable notices. Empty stored weather documents count as damage. Unavailable notices precede the conditions row, preserving the joined desktop weather panels. Conditions metadata overflow uses `503 index_metadata_too_large`, retains the prior page and pending intent, and does not imply an invalid repair request; repair validation retains `400 invalid_repair_target`. Recovery markers clear only after both components render successfully, including when only metadata changes. Conditions-only bootstrap timestamps never establish a news publication date. Alert source commits retain their existing API certainty contract: if derived homepage composition fails after the source commits, its durable pending marker survives eviction and retries on the next source event (including a duplicate retry) or manual rebuild. No new public API or publishing secret is introduced.

Rollout order: publish Open Sun's document first, deploy preview and run its explicit rebuild, verify the weather after the next poll, then deploy production and verify its explicit rebuild. A normal deploy queues its existing one-off template rebuild; polling only triggers additional builds on changed data. Do not edit the weather snapshot or alert files in R2 manually.

## Set up Cloudflare

### 1. Install and sign in

Use Node.js 24 or newer, npm, and a Cloudflare account with Workers and R2 enabled. Run commands from the repository root:

```sh
npm ci
npx wrangler login
npx wrangler whoami
# If you have multiple accounts:
export CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
```

[`wrangler.jsonc`](wrangler.jsonc) defines production at the top level and a separate `preview` environment. There is no named `production` environment.

| Setting | Production | Preview |
| --- | --- | --- |
| Worker | `lakearrowheadtown` | `lakearrowheadtown-preview` |
| R2 bucket | `lakearrowheadtown-content` | `lakearrowheadtown-content-preview` |
| R2 binding | `SITE_BUCKET` | `SITE_BUCKET` |
| Durable Object binding | `PUBLISHER` | `PUBLISHER` |
| Publisher class | `DigestPublisher` | `DigestPublisher` |
| `SITE_ORIGIN` | `https://lakearrowhead.town` | Empty; uses the request origin |
| Local credential | `.secrets/production.vars` | `.dev.vars.preview` |

Wrangler provisions the SQLite-backed publisher and separate namespaces. Keep R2 buckets private, with public development URLs disabled and no R2 custom domain. The Worker exposes only the specified public routes; no S3 credentials are required. See [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

For another domain or account, update the Worker names, buckets, route, and `SITE_ORIGIN`, plus the URL defaults and target allowlists in [`scripts/maintenance.mjs`](scripts/maintenance.mjs). `SITE_ORIGIN` must be an HTTP(S) origin without credentials, a path, query, or fragment.
Also update the production indexing origin in [`src/site.ts`](src/site.ts) when changing domains.

### 2. Create buckets

Run once, skipping resources that already exist:

```sh
npx wrangler r2 bucket create lakearrowheadtown-content-preview
npx wrangler r2 bucket create lakearrowheadtown-content
```

### 3. Bootstrap preview

The normal deployment script expects an existing publishing credential in the build environment or a local file, matching the remote secret. For the first installation, deploy the code directly, then provision the secret:

```sh
npx wrangler deploy --env preview
npm run secret -- preview
npm run deploy:preview
```

The final command deploys the code and durably queues the first rebuild. It prints a job ID and a status command, then exits without waiting for the rebuild to finish.

```sh
npm run rebuild:status -- preview JOB_UUID
node scripts/smoke-preview.mjs --verify-edge
```

The smoke check verifies compact/direct alert reads, retraction previews, gated/enabled confirmation batches, coalesced history, and reconciliation bootstrap/deltas, then confirms API version 3 with a read, previews digests and appends, verifies compact reads and batch-reference lookup, publishes/retracts a separate cleanup fixture twice, reads recent stories, appends a source update and retries it, uploads an image, submits three labeled batches (a new story, a duplicate no-op, and a distinct follow-up) and rejects an empty batch, checks public routes and ETags, and queues a rebuild. It also checks daily archives and their PNG cards, local resource pages, WOFF2 serving, image dimensions/loading, and structured metadata. It parses `/rss.xml`, verifies full text/images, creator/media extensions and discovery links, checks HEAD, and confirms duplicate-only submissions preserve the RSS ETag. `--verify-edge` additionally requires real Cloudflare compression and an image cache hit. It leaves all test data in the preview bucket. The optional URL defaults to the configured preview hostname; an explicit URL may come before or after the flag. Only that hostname or `http://localhost:<port>` is accepted. Unknown flags and extra URLs fail before credentials are read or requests are sent.

### 4. Connect the domain

Add `lakearrowhead.town` as a Cloudflare zone in the same account as the Worker. Review imported DNS records and copy any missing email, subdomain, and certificate-authority records.

1. Follow [Cloudflare's DNSSEC migration instructions](https://developers.cloudflare.com/dns/dnssec/) if the previous provider has an active DS record.
2. At the registrar, replace the old authoritative nameservers with Cloudflare's assigned pair.
3. Wait for the zone to become **Active**. During propagation, visitors may still reach the previous host.
4. Remove conflicting records at the exact hostname assigned to the Worker; preserve unrelated records.

The production `custom_domain: true` route lets Cloudflare manage Worker DNS and HTTPS certificates. See [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

### 5. Bootstrap production

```sh
npx wrangler deploy --env=''
npm run secret -- production
npm run deploy
npm run rebuild:status -- production JOB_UUID
curl --fail-with-body -I https://lakearrowhead.town/
curl -i -X POST https://lakearrowhead.town/api/digests
```

Expect `200` for the homepage and `401` for the unauthenticated POST once the secret is configured. Before any posts, the page shows an empty state and canonical metadata. Production image URLs use the configured `SITE_ORIGIN` even when requests arrive through its `workers.dev` hostname.

### 6. Deploy production automatically from `main`

Connect the existing `lakearrowheadtown` Worker to `hbmartin/lakearrowheadtown` in **Settings > Builds > Connect**. Use [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) with these settings:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` (repository root) |
| Build command | `npm run typecheck && npm test && npm run build` |
| Deploy command | `npm run deploy` |
| Preview builds | Disabled for this production Worker |
| Build secret | `PRODUCTION_API_SECRET`, containing the existing production `API_SECRET` value |

The committed `.node-version` selects Node.js 24. Cloudflare installs dependencies before the build command. Add `PRODUCTION_API_SECRET` as an encrypted **build** secret; the Worker's runtime `API_SECRET` is configured separately and is not automatically available to builds. Use the existing token from `.secrets/production.vars`, migrating it from `.dev.vars` first if necessary. Do not run `npm run secret` just to set up Builds, because that rotates the publishing token. Update the build secret whenever the runtime token is rotated.

Each push to `main`, including a merged pull request, runs validation and then deploys production. The production trigger watches all paths, so documentation-only merges also run this pipeline. Failed validation stops deployment and no rebuild is queued. After a successful deployment, `npm run deploy` queues one durable homepage rebuild using production content and prints its job ID. Check that job as described below; a successful build means the rebuild was queued, not that it has finished. Preview remains available through `npm run deploy:preview`, with its own Worker and storage.

The deployment and maintenance commands prefer the environment-specific `PRODUCTION_API_SECRET` or `PREVIEW_API_SECRET` process variable when present, then fall back to the matching local credential file. An invalid process variable fails instead of falling back. Credentials must contain at least 32 printable ASCII characters with no spaces or control characters, so they survive the Node-to-Workers header encoding boundary unchanged. ASCII punctuation is accepted; hexadecimal is not required. Invalid credentials fail with a value-free error before deployment or requests; valid tokens are used unchanged. Secret provisioning and migration continue to use local files.

Credential saves always use single-quoted dotenv assignments and verify that they read back unchanged. Apostrophes are rejected on file writes with a value-free error; those tokens remain supported through environment variables, explicit script overrides, and existing credential reads. Existing files are not rewritten automatically. The shell examples below read credentials as data through Node, preserving literal punctuation and ignoring executable-looking settings elsewhere in the file.

## Local development and verification

Create a local preview credential without changing any remote secret:

```sh
npm ci
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { saveCredential } from './scripts/credentials.mjs';
if (!existsSync('.dev.vars.preview')) {
  saveCredential('preview', randomBytes(32).toString('hex'));
}
JS
npm run dev
```

Open http://localhost:8787. R2 and Durable Objects are emulated under `.wrangler/`; local posts do not modify deployed buckets.

```sh
npm run typecheck
npm test
npm run build
npx wrangler deploy --env preview --dry-run --outdir dist/preview
node scripts/smoke-preview.mjs http://localhost:8787
```

Tests exercise the Workers runtime, R2, Durable Object alarms/eviction, and local tooling. Build commands above are deployment dry runs. The local smoke check intentionally appends data and queues a local rebuild. It cannot verify Cloudflare edge caching or compression.

### Coverage and Codecov

Run `npm run test:coverage` to measure Worker application code under `src/` with Vitest's V8 provider. This command also runs the Node tooling tests without collecting their coverage. Regular `npm test` runs keep coverage disabled.

Coverage output is ignored by Git. Open `coverage/index.html` for the HTML report; `coverage/lcov.info` is the report uploaded to Codecov. The terminal also shows a coverage summary. No minimum coverage thresholds are configured.

The GitHub Actions **Coverage** workflow runs type checking and both test suites on pull requests, pushes to `main`, and manual dispatch. After successful checks, it uploads the LCOV report using `codecov/codecov-action@v7`. Test failures fail the workflow; Codecov upload failures are non-blocking. Fork pull requests run the checks but skip the upload, as do requests without an available token. Jobs have a 20-minute limit and superseded PR runs are cancelled. `codecov.yml` explicitly makes project and patch checks informational.

To enable uploads, sign in to [Codecov](https://app.codecov.io/gh/hbmartin/lakearrowheadtown), activate `hbmartin/lakearrowheadtown`, and copy its repository upload token. Add the token in GitHub under **Settings > Secrets and variables > Actions > New repository secret**, named `CODECOV_TOKEN`. After the first successful workflow run, confirm the report appears on the matching commit in Codecov. Production deployment continues through the existing Cloudflare Workers Builds integration.

## Credentials and rotation

All publishing and maintenance operations require `Authorization: Bearer <API_SECRET>`. Scheme names are case-insensitive; the token is exact. Public page and image retrieval require no credentials.

Provision or deliberately rotate a secret:

```sh
npm run secret -- preview
npm run secret -- production
```

These commands generate 32 random bytes as 64 hexadecimal characters and upload them using Wrangler secrets. They update only `API_SECRET`, preserve unrelated variables, and back up the previous complete credential file in ignored `.secrets/`. Files have owner-only permissions. A failed upload leaves the generated value available locally for retry. Update the posting client after rotation; old tokens stop authenticating once the update takes effect.

Production credentials live in `.secrets/production.vars`, outside Wrangler's automatic local-development files. To move an existing production credential from `.dev.vars` without rotating or uploading it:

```sh
npm run secret:migrate-production
```

Migration backs up `.dev.vars`, preserves other variables, and refuses to overwrite a different production credential. A rejected file write can leave a private recovery backup while keeping the original files intact.

Production provisioning warns if `API_SECRET` is still present in `.dev.vars`, then continues without changing that file. Prefer migrating before rotation. After a confirmed successful rotation, back up `.dev.vars` and remove only its obsolete `API_SECRET` assignment, preserving other settings. The migration command will refuse to replace the new production token with a different old token. If uploading the new secret fails, the previous remote token may still be live; keep the backup until recovery is complete. Warnings never print token values.

For production curl examples:

```sh
API_SECRET="$(node --input-type=module -e 'import { readCredential } from "./scripts/credentials.mjs"; process.stdout.write(readCredential("production"));')" &&
  export API_SECRET SITE_URL=https://lakearrowhead.town
```

For preview, change the reader argument to `"preview"` and use the preview URL. For local testing, use that reader and set `SITE_URL=http://localhost:8787`. A failed read leaves `API_SECRET` empty, so the guarded curl examples below do not send a request. An automated publisher should get its token from its own secret store.

If a secret upload fails, upload the same saved value rather than generating another:

```sh
API_SECRET="$(node --input-type=module -e 'import { readCredential } from "./scripts/credentials.mjs"; process.stdout.write(readCredential("production"));')" &&
  printf '%s' "$API_SECRET" | npx wrangler secret put API_SECRET --env=''
# Preview: change the reader argument to "preview" and use --env preview.
```

A missing secret or one shorter than 32 characters disables protected endpoints with `503`. See [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## Publish posts

Prepare [`examples/digest.json`](examples/digest.json) with actual titles, source links, summaries, and item timestamps:

```json
{
  "title": "Morning Facebook digest",
  "source": "facebook-groups",
  "items": [
    {
      "group": "Lake Arrowhead 360 Group",
      "group_url": "https://facebook.com/groups/2241141482782874/",
      "headline": "Community update",
      "body": "A **Markdown** summary.\n\n[Read more](https://example.com/update).",
      "post_url": "https://facebook.com/groups/2241141482782874/permalink/4816273571936306/",
      "category": "announcement",
      "posted_at": "2026-10-16T07:12:00-07:00"
    }
  ]
}
```

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/digests" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/digest.json
```

Successful publication returns `200` after the source, manifest, and index writes complete. The response extends the original `ok`/`url` fields:

```json
{
  "ok": true,
  "url": "/",
  "request_id": "request-uuid",
  "post": { "id": "post-uuid", "date": "2026-10-18", "received_at": "2026-10-18T18:00:00.000Z" },
  "duplicate": false,
  "counts": { "submitted": 2, "published": 1, "duplicates": 1 },
  "items": [
    { "index": 0, "status": "published", "post_id": "post-uuid", "item_index": 0 },
    { "index": 1, "status": "duplicate", "post_id": "earlier-post-uuid", "item_index": 2 }
  ]
}
```

`index` is the submitted item position; `item_index` is the position in the identified stored batch. An all-duplicate request returns `post: null`, `duplicate: true`, and zero published stories. It performs no writes and does not change the homepage, publication timestamp, or ETag. Mixed batches set `duplicate: false` and store only their new stories.

- Duplicate identity is the exact validated `post_url` string, including query strings and fragments. No URL normalization, tracking-parameter removal, or fuzzy content matching occurs. Batch labels, source labels, wording, and other item fields do not change that identity.
- Stories retained in the 30-day history suppress new copies of their original and appended URLs. Receipt dates, not `posted_at`, govern this window; retries never refresh it. A genuine appended source extends only its story's retention. Hidden items also count: correcting an out-of-window `posted_at` at the same URL remains a duplicate. Within a request the first new occurrence wins. Historical duplicate copies remain visible. The earliest source receipt supplies duplicate references, with ascending post ID, item position, and update position breaking ties.
- Publishing and duplicate detection share the serialized queue. The committed manifest governs modern source membership, including eligible repaired `omitted_posts`; orphan source objects do not suppress retries. Eligible legacy sources also participate during migration. A repaired or legacy historical copy wins over an incoming copy. If the request is entirely duplicate, it still makes no writes: its returned historical identity may remain omitted from the homepage until a later publication containing new content.
- Dry-run preflight and whole-batch self-retraction are available as described below. Individual story editing and idempotency keys are not provided. `url` always points to `/`; post IDs identify targets for authenticated reads and appends, not public permalinks. See the manual cleanup runbook below for corrections at the same source URL.
- Omit top-level `date`, `id`, and `received_at`: none is required, and submitted values are ignored. The server assigns a unique ID, UTC ISO `received_at`, and `YYYY-MM-DD` date in `America/Los_Angeles` inside the serialized publisher. For example, receipt at `2026-10-19T01:00:00Z` gives date `2026-10-18`. Item `posted_at` remains the original source timestamp, not the receipt timestamp. Deduplication follows 30 Los Angeles calendar dates, including DST boundaries, rather than a rolling 720 hours.
- `title`, `source`, `group`, and `headline` are required nonempty strings. `body` and `category` may be empty; submitted `items: []` receives a `400` validation error before writes. Historical empty sources remain readable. Categories follow the advisory [category vocabulary v1](#category-vocabulary-v1-and-advisory-warnings) below; arbitrary strings remain accepted. Digest titles and receipt times remain private; the homepage displays item headlines.
- Item timestamps require real calendar dates and an explicit timezone (`Z` or an offset). Source links must be absolute HTTP(S) URLs without credentials.
- Markdown is rendered with raw HTML disabled and unsafe link protocols blocked. Plain-text fields are escaped. JSON requests are limited to 1 MiB, including streamed requests.

A publish retains each story for 30 Los Angeles dates after its latest genuine server-received addition. The homepage shows stories whose original post or any update has a source `posted_at` within the published seven-day window. Cards appear newest first under the day of their newest in-window source activity; a future-day source never hides another eligible source. Original timestamps remain visible, and updates appear beneath the original body, oldest source timestamp first, with attribution and source links. Equal activity timestamps preserve source and item order, and historical duplicate copies remain visible. Empty digests create no sections. Source timestamps describe already-published material; this feed does not schedule future posts.

The footer labels the post-date range and last publication time. Feed contents and calendar datelines stay unchanged between publications, even when the covered week is old. There is no scheduled feed refresh. In the browser, post timestamps display relative ages such as “3 hr ago” or “2 days ago”; they update each minute while the page is visible and when returning to the page. Timestamps ahead of the reader’s clock retain future labels such as “in 3 min”. Each age is rendered once for reading and copying, including double-click and drag selection. Full Los Angeles timestamps use native browser tooltips, which screen readers may announce alongside the age; original `datetime` values stay intact. Without JavaScript, absolute timestamps display once. Daily headings and footer dates stay absolute. Template rebuilds retain the exact published selection, date window, and publication timestamp, while applying the current layout.

The masthead reads “Lake Arrowhead . Town” with a centered accent dot; the browser page title is “Lake Arrowhead News, Alerts & Events | Lake Arrowhead . Town”. Its type uses `clamp(1.5rem, 6.3vw, 3.5rem)` and can wrap on narrow screens. The palette icon shares the masthead row inside a 44px circle with a solid theme-surface background and a control-colour border. It has no button shadow and scrolls with the header. It opens a five-theme picker and remembers the selected theme in a cookie. Arrow keys apply and save themes while keeping the picker open; clicking a theme or pressing Space/Enter selects it, closes the picker, and returns focus to the button. Escape keeps the selected theme and closes; Tab continues normal navigation, and outside clicks or leaving the window dismiss the panel. An open panel stays attached to the masthead when it scrolls away; resizing fits it to the viewport without moving the page. Night Sky adds a navy dark theme with pale text and static stars; it is selected manually, and device dark-mode preference does not change the default Deep Lake & Lodge theme. Themes use subtle woodgrain, dock boards, mist contours, paper, and star textures that follow the document, strongest at the masthead and page edges. Background colour washes retain their existing strength.

A 48px circular “Back to top” arrow appears at the lower left as soon as the page scrolls away from the top. It sits 16px from the edges plus device safe-area insets and follows the selected theme. Its border fills clockwise from 12 o’clock according to the fraction of the page’s scrollable distance already covered, with no numeric label. Progress adjusts to viewport and content-height changes, including loaded images. Activation scrolls smoothly to the top, or immediately when reduced motion is enabled. The button stays visible while scrolling upward until the top is reached, then hides; if it holds keyboard focus, focus returns to the masthead home link without scrolling again. It is hidden on pages without scrolling, without JavaScript, and when printing.

At widths up to 600px, 16px side gutters, compact header/article spacing, quiet 13px daily headings, and 20–22px story headlines bring the first story higher on the page. Group links are hidden on mobile while post times and categories remain visible. Body text stays 16px with a 1.6 line height, and full stories, images, captions, and links remain available without expansion. Desktop retains group links. Daily headings have no redundant rule below them. Headline links fill their heading’s width, underline on hover, and show a rectangular outline without an underline on keyboard focus, including when hovered. Body-only thumbnails and footer placement remain in use.

If a historical source is missing, contains malformed JSON, or fails stored-content validation, a new publication omits that post and logs its ID, R2 key, and a fixed reason. Its reference is retained privately as `omitted_posts` in the manifest and reconsidered on later publications until its latest server receipt leaves the 30-day window. Reads report `omitted_post_ids`; damage to a referenced readable source or the selected append target returns an operator-repair error. Storage outages and unexpected failures still fail publication instead of omitting content.

R2 has no transaction spanning these objects. Index replacement is the commit point, and a failure can leave unreferenced source, manifest, or archive artifacts. Independent artifact writes use at most four concurrent requests, preserve ordering for the same key, and all finish before the homepage index is replaced. A failed write settles other in-flight requests and prevents index replacement. After a timeout or a response with `retryable: true`, retry the unchanged payload within its original 30-calendar-date receipt window. If the index committed, the repeated URLs resolve to their committed identities; otherwise the retry can publish them. Non-retryable rendering, configuration, or internal failures require repair first. After that window, check the saved response, logs, and publication before retrying because suppression has expired.

The Worker uses the versioned `publishV2` Durable Object RPC. During deployment skew, an unavailable method, failed RPC, or invalid reply returns `503 service_unavailable` with `publication_status: "unknown"`; it never falls back to another publish call. The legacy `publish` method retains throw-on-failure behavior for old Workers and the successful reply shape understood by the previous preview Worker.

This intentionally corrects the earlier `500 publish_failed` response for digest publishing RPC failures with `X-API-Version: 3`. All publishing clients are controlled; coordinate their updates before the next production rollout. Clients must handle unfamiliar error codes with a readable fallback and use `retryable` and `publication_status` for retry decisions rather than matching only `publish_failed`. A missing or unusable publisher binding instead returns `503 configuration_error`, `retryable: false`, and `publication_status: "not_attempted"`: publication was never invoked and the configuration needs operator repair. No API-version negotiation or alternate publishing call is provided.

## Calendar admission and retries

**Behavior change:** newly submitted events whose final included Los Angeles date precedes today return `400 validation_failed`, including previews. Mixed requests fail atomically before writes. All-day end dates remain exclusive, and events ending earlier today remain eligible for today's calendar. Stored-source validation remains time-independent.

Known duplicates are recognized before admission checks and retain their original IDs for 30 LA receipt dates without refreshing the window; future occurrences remain deduplicated regardless of receipt age. Private immutable indexes avoid rereading unchanged event batches during publication. Legacy indexes use committed references only. Identity remains source URL, all-day flag, and start time: distinct events in one post at the same start time still require a future identity-design change. Editing/retraction and new duration/horizon limits are deferred.

Calendar renders share a bounded 16-entry per-isolate cache keyed by publication, LA date, and origin. New publications/date changes invalidate it; failed renders are evicted. Browser refresh moves forward only and requires a persisted session guard, preventing reload loops with skewed clocks or unavailable storage.

### Restore a damaged event deduplication index

If an event publication reports `manifest_damaged` for `events/dedup-index/<hash>.json`, restore that exact immutable object from a verified private backup. The `dedup_index` pointer in `events/current.json` and the sanitized manifest diagnostic identify the key; verify its content hash and binding before retrying the unchanged event request. Do not delete the pointer or rebuild it solely from current/upcoming event references: the index also retains finished occurrences for their original 30 Los Angeles receipt dates, and those sources may no longer be selected. Missing/corrupt referenced indexes remain fail-closed; this runbook adds no raw-source rediscovery or event-editing endpoint.

## Incremental reconciliation across stories, alerts, and calendar

Authenticated `GET`/`HEAD /api/changes` bootstraps current state. Apply all pages, then persist the final `sync_cursor`. Subsequent polls use `/api/changes?since=CURSOR`; subsequent pages use `/api/changes?cursor=PAGE_CURSOR`. Do not combine or repeat these parameters. The API remains version 3 and returns:

```json
{
  "ok": true,
  "as_of": "2026-10-22T18:00:00.000Z",
  "changes": [
    { "resource": "story", "identity": { "post_id": "UUID", "item_index": 0 }, "operation": "upsert", "revision": "SHA256", "data": {} },
    { "resource": "alert", "identity": { "alert_id": "UUID" }, "operation": "remove" }
  ],
  "next_cursor": null,
  "sync_cursor": "OPAQUE_CHECKPOINT"
}
```

Pages contain at most 20 changes in stable resource/identity order, and `as_of` stays fixed through pagination. `sync_cursor` is null until the final page; save it only after successfully applying every page. Upserts replace the local resource with current public data; removals delete that identity. Story data flattens the existing full-read batch metadata and individual item, including updates. Event data matches full calendar event records. Alert data contains the effective alert and coalesced history. Private storage keys and publishing fingerprints are not data fields. Reapplying pages is safe when clients upsert/delete by the complete resource identity.

The reconciliation dataset matches `/api/posts?days=30`, `/api/alerts?days=30&history=coalesced`, and `/api/events?days=30`. These are API history/calendar windows, separate from the homepage's seven-day story visibility. The feed reports net state, not every intermediate operation. Resolved/retracted alerts remain upserts while retained; resources outside the dataset or removed by supported repairs generate removals. Expiry, upcoming status, and date-window entry/exit are evaluated at each checkpoint, even without writes. Weather-only homepage composition and cosmetic rebuilds do not create story changes.

The publisher briefly captures all three committed snapshots under serialization, then compares private revision-bound indexes and loads only changed source bodies, with at most four simultaneous reads across nested alert histories. New story/event publications prepare indexes before committing. Calendar snapshots are immutable; old mutable manifests are frozen on first capture. Committed legacy publications and repaired manifests with stale indexes build a cache bound to immutable source identities once. Unchanged polls with indexes do not load historical source bodies. `changes_read_result` logs change/returned counts, historical source-read counts, and cache bytes written without content or cursors.

Cursors use the server's persistent signing key with a separate reconciliation namespace and expire after 30 elapsed days from the target capture. This differs from LA receipt-date retention. Invalid cursors return `400 invalid_cursor`; expired ones return `410 resync_required` and require a new bootstrap. Index or requested changed-source damage returns an error, never a false empty result. Preserve all referenced immutable artifacts for advertised cursor lifetimes; this release introduces no deletion/garbage collection. Raw overwrites of immutable sources/manifests are unsupported: create replacement revisions and install supported publication/repair snapshots. Copied story manifests may keep an old sync index; the source binding forces a fresh cache. Existing legacy full reads remain a fallback. Install a committed manifest through the normal rebuild before using this endpoint on a raw pre-migration digest bucket; an alert-only unpublished homepage can bootstrap immediately.

Roll out clients by bootstrapping through this endpoint (rather than combining independent full reads with a later cursor), applying every page, and atomically saving the resulting checkpoint with local state. On interruption, resume the pinned page sequence or replay it using the previous saved checkpoint. Keep the existing alert confirmation scheduler; synchronization alone does not renew alerts. Conditional GET, weather synchronization, and new event-editing endpoints are outside this release.

The preview smoke check covers bootstrap, pagination, changed stories/events, update retries, and retraction removals. It retracts its story fixture and leaves one clearly labeled calendar fixture until that day's calendar window ends. Run against the preview hostname or local Wrangler only; the ordinary smoke script continues to reject production origins.

## Category vocabulary v1 and advisory warnings

The canonical category vocabulary, version **1**, is `alert`, `announcement`, `discussion`, `event`, `traffic`, and `weather`. Values match exactly: lowercase only, without trimming or normalization. An empty string means uncategorized and produces no warning. Other strings, including `Traffic`, are accepted and stored exactly as submitted with an `unknown_category` warning. Historical categories remain readable as-is, without migration or read-time warnings. Hard rejection would require a separately approved future major API version; this addition keeps `X-API-Version: 3` and existing storage formats.

Successful digest and append responses may include one top-level `warnings` array. Warnings apply only to newly published stories or newly appended sources, including proposed writes in a dry-run. Duplicate items and duplicate appends produce no warnings; append warnings inspect only the submitted update, without rechecking the target story. Warnings never change `ok`, statuses, counts, identities, or `publication_status`. The array is omitted when empty. Reads and error responses do not include warnings; malformed fields still receive their normal validation errors.

| Code | Condition |
| --- | --- |
| `unknown_category` | A new digest item's nonempty category is outside vocabulary v1. |
| `posted_at_in_future` | A new story or update timestamp is more than 15 minutes ahead of server time. |
| `posted_at_stale` | A new story or update timestamp is more than 720 elapsed hours before server time. Deliberate backfills remain accepted. |

Exactly 15 minutes ahead and exactly 720 hours old do not warn. Timestamp comparisons use instants, regardless of the submitted timezone offset. Both timestamp warnings include UTC ISO `server_time`: the existing publisher operation time used for `received_at` and dry-run `checked_at`, captured inside the serialized publisher. The stale cutoff uses elapsed time and is separate from retention's 30 Los Angeles calendar dates.

Each warning contains `field`, `code`, a readable `message`, and the exact submitted `value`. Digest warnings additionally include the submitted zero-based `index`, independent of the stored `item_index`. They appear in submitted item order, category before timestamp. For example, the following warnings accompany newly published items at indexes 3 and 5:

```json
{
  "warnings": [
    {
      "index": 3,
      "field": "items[3].category",
      "code": "unknown_category",
      "message": "Category 'trafic' is not in category vocabulary v1 (alert, announcement, discussion, event, traffic, weather). Accepted as submitted.",
      "value": "trafic"
    },
    {
      "index": 5,
      "field": "items[5].posted_at",
      "code": "posted_at_in_future",
      "message": "posted_at is more than 15 minutes ahead of server time; check the source timestamp and timezone.",
      "value": "2026-10-21T06:12:00-07:00",
      "server_time": "2026-10-20T23:12:00.000Z"
    }
  ]
}
```

Append warnings use the same shape without `index`, with `field: "posted_at"`; existing response identity fields retain their meaning:

```json
{
  "warnings": [
    {
      "field": "posted_at",
      "code": "posted_at_stale",
      "message": "posted_at is more than 30 elapsed days old; check the source timestamp or confirm the intended backfill.",
      "value": "2026-08-01T12:00:00-07:00",
      "server_time": "2026-10-20T23:12:00.000Z"
    }
  ]
}
```

These checks diagnose source timestamps without changing feed selection. A timestamp later today can still be eligible because the feed uses Los Angeles source dates; a future-day source falls outside the saved window and never hides another eligible source. Warnings do not schedule content or promise automatic future appearance. Review them in a dry-run before publishing to catch timezone mistakes without committing content.

## Preview publishing against committed history

`POST /api/digests?dry_run=true` and `POST /api/posts/{post_id}/items/{item_index}/updates?dry_run=true` accept the normal JSON payload and authentication. They run the same validation, deduplication, reference-conflict checks, archive preparation, image inspection, HTML rendering, and RSS rendering as a real operation. All proposed writes stay in memory: source objects, archives, share cards, image-metadata caches, reference records, and Durable Object storage remain unchanged. Duplicate-only requests follow the same early no-op path as real publishing.

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/digests?dry_run=true" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/digest.json
```

Successful previews return the normal per-item `published`/`duplicate` or append `appended`/`duplicate` results, plus `dry_run: true`, `committed: false`, and `checked_at`. They include the same advisory warnings for proposed new sources as real submissions. Duplicate identities identify their actual owners. Newly proposed post IDs and append positions are provisional, including intra-batch duplicate references to a proposed item. A later real submission recomputes everything in the queue and may return different identities/results. Previews reserve neither URLs nor references, and cannot predict a later storage-write failure.

Omit `dry_run` or use `dry_run=false` to publish. Other values and repeated parameters return `400 invalid_dry_run` before publisher invocation. Preview errors retain normal validation/error codes and always report `publication_status: "not_attempted"`; invoked preview errors also carry `dry_run: true` and `committed: false`. Missing preview RPCs fail closed with no fallback to a publishing call. Retraction, image upload, rebuild start, and rebuild resume reject any `dry_run` parameter (including `false` or an empty value) with `400 invalid_dry_run` before reading a body or invoking a mutation; they do not provide previews.

Before enabling preview requests, complete deployment and verify a read response carries `X-API-Version: 3` (for example `GET /api/posts?fields=index`, whose response must identify `fields: "index"`). Older Workers ignore the dry-run query and can publish it as an ordinary submission. Use a complete rollout, without mixing older and new HTTP writers for these clients.

## Look up a committed batch

Add an optional `client_ref` to a digest. It is an exact, case-sensitive, nonblank string of at most 128 Unicode characters, without control characters; no trimming or normalization is performed. Choose a new reference for each intended new batch. Publishing echoes it, and both full and compact post reads include it.

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body --get "$SITE_URL/api/digests" \
  -H "Authorization: Bearer $API_SECRET" \
  --data-urlencode 'client_ref=morning-2026-10-20-01'
```

Authenticated GET/HEAD lookup returns `200 {"ok":true,"client_ref":"morning-2026-10-20-01","post":{"id":"post-uuid","date":"2026-10-20","received_at":"2026-10-20T18:00:00.000Z"},"status":"published","request_id":"..."}`. After retraction the same identity returns `status: "retracted"` and `retracted_at`. A missing reference returns `404 batch_not_found`. Exactly one `client_ref` parameter is required. All lookup replies use `Cache-Control: no-store`. Lookup never discovers raw legacy digests; without a committed manifest it returns `404 batch_not_found`. A malformed direct archive pointer does not prevent lookup through a valid committed manifest and history index. Unexpected lookup failures emit a sanitized `batch_lookup_failed` event in addition to HTTP diagnostics.

References are unique site-wide for the original 30 Los Angeles receipt dates, including the receipt date. A request that would create a second batch using a retained reference returns `409 client_ref_conflict`, including in dry-run. References are lookup-only metadata: a duplicate-only retry returns ordinary URL deduplication results with `post: null`, rather than replaying an earlier response. A duplicate-only submission creates no record for a new reference. Lookup survives retraction, source damage/omission, and token rotation; appends never extend the reference window. After a timeout, look up the reference to learn which batch committed. Uncommitted orphan artifacts cannot create a lookup result.

## Retract your own batch

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body -X POST "$SITE_URL/api/posts/POST_ID/retract" \
  -H "Authorization: Bearer $API_SECRET"
```

No body is required. A first retraction must arrive less than 24 elapsed hours after the batch's original server receipt, using the exact token that published it. Appends do not extend the deadline. The server stores a private SHA-256 token fingerprint; callers cannot supply or override ownership. Everyone sharing a token shares ownership, and rotation loses self-retract access to batches published with the old token. Historical batches without recorded ownership require the operator runbook.

Success returns `200 {"ok":true,"post_id":"post-uuid","status":"retracted","retracted_at":"2026-10-20T19:00:00.000Z","request_id":"..."}`. It removes the whole batch, including appended sources, from the current homepage, RSS, daily archive contents, and full/compact story reads. Its original and appended URLs become publishable again unless another eligible story owns them. The reference remains reserved until its original lookup window ends. Retraction advances publication time while preserving original receipt identities.

The operation commits an immutable empty source revision and retraction record with the new snapshot; it preserves original private sources and historical snapshots. Cached or previously downloaded content cannot be withdrawn. Repeating the request with the same token returns `status: "already_retracted"` and the original timestamp, with no writes, including after the 24-hour deadline while its 30-day record remains available. Rebuilds preserve retractions. Missing posts return `404 post_not_found`; missing/mismatched ownership returns `403 retract_forbidden`; an expired first retraction returns `409 retract_window_expired`. Retraction failures use the existing publication certainty/retry contract. After an uncertain commit, reconcile its original reference or retry promptly with the original token. A first retraction must commit within 24 hours of the original receipt; an uncommitted attempt cannot use the 30-day digest retry window. A previously committed retraction remains safely repeatable while its batch record is retained. If retraction removes the last story from a day, that day leaves the archive listing and sitemap and its dated route returns 404; other stories on shared days remain.

## Read recent stories and append sources

Both endpoints use the same `Authorization: Bearer <API_SECRET>` credential and return `Cache-Control: no-store`. Topic matching belongs to the caller: the server attaches a source only to the explicit story target and never merges stories by wording.

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/posts?days=7" \
  -H "Authorization: Bearer $API_SECRET"
```

`GET /api/posts` (also HEAD) defaults to seven Los Angeles calendar dates of server receipt activity; `days` accepts integers from 1 through 30. An appended source makes its story recent even if the original source timestamp is old. Results contain up to 20 matching batches per page. Follow `next_cursor`, keeping the same `days` and `fields` or omitting them; the signed cursor pins the publication, original read time, representation, and next batch position even while new content publishes. Cursors use a private signing key retained in publisher storage across restarts. Invalid days or cursors return 400 with a readable message and restart suggestion.

Story reads load immutable committed manifests and source revisions outside the publishing queue, so slow reads do not hold up publishing and rebuilds. Sources load in ordered batches of up to four without fetching beyond the completed page. Concurrent first reads share a transaction-backed cursor-key initialization; a failed initialization can retry on a later request. Publishing, appends, previews, retractions, and rebuild operations remain serialized.

```json
{
  "ok": true,
  "request_id": "request-uuid",
  "days": 7,
  "as_of": "2026-10-20T18:00:00.000Z",
  "published_at": "2026-10-20T17:00:00.000Z",
  "message": "Published stories are ready to review.",
  "posts": [{
    "post_id": "post-uuid",
    "title": "Morning digest",
    "source": "facebook-groups",
    "date": "2026-10-19",
    "received_at": "2026-10-19T18:00:00.000Z",
    "items": [{
      "item_index": 2,
      "group": "RimTraffic",
      "group_url": "https://facebook.com/groups/rimtraffic/",
      "headline": "Highway closure",
      "body": "Original Markdown summary.",
      "post_url": "https://facebook.com/groups/rimtraffic/permalink/123/",
      "category": "traffic",
      "posted_at": "2026-10-19T10:00:00-07:00",
      "last_received_at": "2026-10-20T17:00:00.000Z",
      "latest_activity_at": "2026-10-20T07:12:00-07:00",
      "updates": [{
        "update_index": 0,
        "group": "RimTraffic",
        "post_url": "https://facebook.com/groups/rimtraffic/permalink/456/",
        "body": "Both lanes have reopened.",
        "posted_at": "2026-10-20T07:12:00-07:00",
        "received_at": "2026-10-20T17:00:00.000Z"
      }]
    }]
  }],
  "omitted_post_ids": [],
  "next_cursor": null
}
```

Use `GET /api/posts?days=30&fields=index` for reconciliation without Markdown. The envelope includes `fields: "index"`; batches contain only `post_id`, `date`, `received_at`, optional `client_ref`, and `items`. Each item contains `item_index`, `post_url`, `posted_at`, `last_received_at`, `latest_activity_at`, and `updates`; each update contains `update_index`, `post_url`, `posted_at`, and `received_at`. Titles, attribution text, story bodies, and update notes are excluded. Original item/update indexes, filtering, ordering, omitted IDs, and pagination match full reads. Omitted `fields` or `fields=full` returns the full representation. Invalid/repeated fields return `400 invalid_fields`; switching representations during pagination returns `400 invalid_cursor`. Existing cursors represent full reads.

Version 3 compact reads load the immutable `history-index/<sha256>.json` object selected by the committed manifest, without fetching source bodies. The same object retains bounded private batch records for reference lookup and retraction authorization; its integrity is checked against its content hash. Legacy v1/v2 compact reads project their sources until a rebuild or new publication materializes v3 metadata. Rebuilds preserve original receipt windows and do not assign ownership to old posts. Missing/damaged committed compact metadata returns an error instead of an empty result. This history index and retraction records commit through the same homepage replacement as HTML, RSS, and archives.

Each returned story includes its complete original fields and update history. `item_index` is its original zero-based position, so filtered results can have gaps. Updates retain append order and stable `update_index` values in the API; display order uses source timestamps. `latest_activity_at` describes the newest source timestamp, including future timestamps; public feed eligibility still uses the saved seven-day source-date window. Read responses expose no storage keys. An empty history returns an empty `posts` array; an initial unpublished site also has `published_at: null`.

Append one source with `POST /api/posts/{post_id}/items/{item_index}/updates`. Use the IDs returned by reads or digest publishing:

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/posts/POST_ID/items/ITEM_INDEX/updates" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/story-update.json
```

Required fields are `post_url`, `group`, and timezone-explicit `posted_at`. Optional `group_url` must be an absolute HTTP(S) URL without credentials; optional `body` defaults to an empty string, creating an attributed source link without a note. Markdown follows the original story's safety rules. Server-assigned receipt fields and incoming digest `updates` are ignored. Appends do not edit the original headline, body, category, or timestamp.

Success returns `200 {"ok":true,"url":"/","request_id":"...","status":"appended","post_id":"...","item_index":2,"update_index":0,"message":"..."}` after the homepage and RSS commit. A repeated exact URL returns `status: "duplicate"`, a readable `message`, and a structured `suggestion` containing `action`, `message`, `method`, and `path`. Its identity points to the existing owner, which can differ from the requested target. `update_index` is present when that owner is an update; otherwise the owner is an original story. Digest duplicate items have the same message/suggestion and optional update index. Changed wording at an existing URL is still a duplicate, and duplicates perform no writes.

Unknown, expired, or absent item targets return `404 story_not_found` with a suggestion to read `/api/posts?days=30` or publish a new digest. Errors include readable `message` and structured `suggestion` alongside the existing `error`, `code`, and diagnostics. Append failures use the same `retryable` and `publication_status` contract as digest publishing. Appending through `appendUpdateV1` never falls back to another write method when RPC transport fails.

Updates write immutable private source revisions. The committed index chooses the exact manifest, source revisions, and RSS; abandoned revision or manifest objects do not affect reads or deduplication. Manifest version 3 retains 30 days of story receipt activity and selects a compact history index; versions 1 and 2 remain readable. History starts from the existing committed selection and fills forward; older raw files are not imported into the history automatically. Expired items can remain in private batch files to preserve positions but do not participate in reads, feed selection, or deduplication. No automatic deletion of private objects is introduced.

Deploy to preview, run `node scripts/smoke-preview.mjs --verify-edge`, and check the queued rebuild's status before production rollout. The smoke check also reads stories, appends an update, retries it, and verifies matching HTML/RSS and unchanged duplicate ETags. Once a version 3 manifest is committed, rollback requires code that understands version 3, its compact history index, publisher ownership, retraction records, immutable source revisions, and archive references; older writers reject it. Back up the index, sources, manifests, and archive catalogues before operator repairs. Do not downgrade manifest versions or redeploy an incompatible writer against this bucket.

## Search, sharing, and browser metadata

[`src/site.ts`](src/site.ts) holds the shared name, description, production origin, colors, and versioned artwork paths. Empty pages, publications, and template rebuilds all render the same complete metadata through [`src/metadata.ts`](src/metadata.ts): canonical URL, application name, robots, Open Graph, Twitter large-image cards, favicon/touch-icon links, and the web manifest. The theme picker continues to update the browser's theme color.

The description and 1200 × 630 share card describe the site consistently, regardless of current headlines. JSON-LD connects the `WebSite`, homepage `CollectionPage`, and an ordered `ItemList` of exactly the visible headlines and original source URLs, including visible duplicates. It does not expose digest titles, stored post IDs, or storage references. `dateModified` uses the saved publication time and is absent before first publication.

Only `https://lakearrowhead.town` is indexable. Preview, localhost, alternate production hostnames, and invalid-origin configurations receive `X-Robots-Tag: noindex`, including HEAD and 304 responses. An invalid `SITE_ORIGIN` still permits stored homepage HTML and RSS, uploaded images, bundled artwork/icons, and the manifest to load; robots rules omit sitemap advertising and the sitemap returns 404. Publishing and rendering an empty fallback homepage or RSS feed still require a valid origin and return 503 when it is invalid. Preview HTML also carries a `noindex` meta tag. Production HTML served from an alternate hostname retains the production canonical URL; its response header enforces `noindex` on that hostname. Crawling remains allowed so search engines can read the directive.

| Public resource | Behavior |
| --- | --- |
| `/rss.xml` | Full-content RSS 2.0 feed matching the homepage's saved seven-day selection and ordering. Includes images, categories, source links, and stable opaque GUIDs. |
| `/robots.txt` | Allows public content, disallows `/api/`, and advertises the sitemap only on the production origin. |
| `/sitemap.xml` | Production only; lists the canonical homepage, archive index, published daily archives, and evergreen resource pages. `lastmod` comes from the manifest referenced by the committed index, never the current clock or a rebuild's R2 upload time. Missing/malformed metadata omits the date; storage outages return an error. |
| `/site.webmanifest` | English browser-mode manifest with relative root URLs, theme colors, and 192/512px icons. |
| `/favicon.svg`, `/favicon.ico` | SVG mark and conventional ICO fallback; cached for one day. |
| `/assets/social-card-v1.png` | 1200 × 630 branded share image. |
| `/assets/favicon-v1.ico`, `/assets/favicon-48-v1.png` | ICO with 16/32/48px frames and 48px PNG favicon. |
| `/assets/apple-touch-icon-v1.png` | 180px Apple touch icon. |
| `/assets/icon-192-v1.png`, `/assets/icon-512-v1.png` | Square manifest icons. |

These routes support GET, HEAD, and ETag revalidation. Versioned artwork has one-year immutable caching. Robots and manifest responses are cached for one hour; the sitemap and RSS revalidate like the homepage and bypass CDN caching. Artwork is bundled with the Worker and needs no upload to R2. Source artwork and TTF fonts are not public routes. The Worker serves generated, versioned WOFF2 fonts under `/assets/fonts/` with immutable caching.

Subscribe at `https://lakearrowhead.town/rss.xml` or use the footer's **RSS feed** link. Pages also advertise one absolute RSS autodiscovery link. The channel includes a 48px image and a 15-minute TTL. Each item includes its source group as `dc:creator` and, when available, its first original/update Markdown image as `media:content`, with known dimensions and type. WebSub is deferred. Each RSS description includes the complete safe Markdown-rendered story, its images, and linked group/original-post attribution. Relative body links and images resolve against the publication's site origin. RSS text deliberately normalizes CRLF and lone CR line endings to LF; existing LF characters remain unchanged. XML-invalid characters become replacement characters; raw HTML and unsafe Markdown link protocols remain disabled. RSS dates use GMT: item `pubDate` comes from `posted_at`, and `lastBuildDate` comes from the saved publication time. Before first publication, RSS is a valid empty channel without `lastBuildDate`.

RSS and HTML share the exact saved seven-day selection, including equal-time ordering and historical duplicate copies. Attached updates appear in each story's RSS description; ordering follows latest eligible activity, while `pubDate` keeps the original source timestamp. Each stored item has a stable opaque GUID derived from its private post identity and original item position; rebuilds, appends, and new publications retain existing GUIDs. RSS is rendered into a private immutable R2 object before the homepage commit stores its reference alongside the manifest reference. A failed feed write or uncommitted homepage replacement cannot expose a newer RSS snapshot. Duplicate-only submissions make no writes. Later source damage does not alter materialized RSS; omission on a new publication follows the same rules as HTML. Private RSS object keys and source IDs are never public routes or feed fields.

GUIDs remain unkeyed deterministic SHA-256 fingerprints, not a confidentiality boundary. Predictable legacy IDs and item positions can be inferred by comparing candidate hashes. No hashing secret or per-item identity migration is required; existing GUIDs remain unchanged.

Regenerate artwork locally with Node.js 24+ after installing dependencies:

```sh
npm run artwork
```

The generator uses the existing tree path from `favicon.svg`, editable SVG templates in `assets/source/`, and bundled Instrument Serif / DM Sans fonts with their SIL Open Font Licenses. It does not require network access or installed system fonts. The share card uses the site's default cream and forest-green palette. Commit generated PNG/ICO files along with source changes. When replacing released artwork bytes, bump the versioned filenames in the site constants and Worker imports so immutable caches remain correct.

Code deployment alone does not update an existing R2 homepage. Use the normal `deploy:preview` or `deploy` command, which queues a rebuild, and check its job until completed. Until that rebuild or a new publication commits, pre-RSS homepages have no feed reference and `/rss.xml` returns 503 with `Retry-After: 60`; discovery links also appear only after the homepage is rebuilt. A missing referenced RSS object returns the same 503 and requires a rebuild to restore it. Storage outages remain errors rather than producing a false empty feed. Then check the rendered homepage and RSS subscription/discovery links, `/rss.xml`, `/robots.txt`, `/sitemap.xml` on production, the manifest, and its linked images. Rebuilds apply metadata changes while retaining the saved feed selection and publication timestamp. Search engines and social platforms may take time to refresh their own cached previews.


## Daily archives and local resources

Daily pages at `/YYYY/MM/DD/` preserve community news after it leaves the homepage. Day headings link to these pages, and **Older news** in the footer opens `/archive/`, with dates listed newest first. All dates use `America/Los_Angeles`. A story appears on each day with original or appended source activity; later updates refresh its existing archived copies without removing earlier activity days. Each page has a dated title, canonical URL, description and a 1200 × 630 share image featuring its first headline. The homepage's existing branded social image remains static.

The first rebuild seeds only the currently saved visible seven days. The first new publication also seeds that previous visible snapshot before processing the new one, even if the previous snapshot is stale. Older manifests, orphan source objects and operator backups are not scanned. Future visible publications are retained permanently. The seven-day homepage/RSS selection, 30-day API history, and duplicate rules are independent of archive retention.

Private content-addressed `archive-days/*.json` objects hold complete daily content and known image dimensions. An immutable `archive-catalogs/*.json` object maps dates to data and share images, with stable story identities and meaningful modification times. The committed publication's optional `archives` reference selects that catalogue. These objects and `/assets/daily/<sha256>.png` cards are written before the existing index commit. Failed writes leave the previous public catalogue and sitemap intact. Public reads never list raw sources; missing or damaged committed archive data returns `503 archive_damaged` with operator-repair guidance and no `Retry-After`, while an unpublished or invalid date returns `404`. Increment `DAILY_CARD_VERSION` when changing the daily card design; affected archive entries regenerate their immutable PNG without changing content modification times. Daily HTML uses the current shared template, so template changes do not require rewriting historical content. Rebuilds preserve content modification times.

The index also stores an optional `archives` custom-metadata pointer in the same commit as its manifest and RSS pointers. This direct pointer is authoritative for archive pages, the sitemap, and publication preparation. Archive pages read it without fetching the manifest; older indexes fall back to their manifest. If valid index and manifest pointers differ, the next publication or rebuild uses the index's catalogue and commits matching references. A present invalid or unavailable catalogue remains an error, including for the sitemap. Without a direct pointer, a missing, malformed, or structurally unusable referenced manifest returns non-retryable `503 archive_damaged` for both archive pages and the sitemap. An invalid publication timestamp alone omits the homepage's sitemap `lastmod`; it does not discard archive URLs. A valid direct catalogue remains publicly readable when its manifest is damaged, though publishing still requires a valid source manifest. Archive JSON uses locale-independent key ordering; serialization-only rewrites preserve content modification dates.

Daily PNG objects store private R2 custom metadata `cardInputHash`: the SHA-256 of the canonical JSON array `[date, leadingHeadline, DAILY_CARD_VERSION]`. Empty days are removed from the committed catalogue, including legacy empty entries encountered during rebuilds. Reuse requires a matching catalogue card version, an existing PNG, and its matching fingerprint; body-only edits do not render or rewrite a verified card. Missing PNGs, legacy PNGs without fingerprints, mismatched fingerprints, and card-version changes regenerate the content-addressed image. Metadata checks are cached within a publication and refreshed after writes. Ordinary publishing checks affected dates only. Every explicit rebuild checks all catalogued daily snapshots and cards in checkpointed chunks, including dates beyond source retention; unrelated historical image dimensions are preserved without rereading their source images. Full rebuild work therefore grows with the archive. Card-only repairs preserve content modification dates and daily JSON keys. Failures leave the prior index committed, and repeat rebuilds reuse verified cards.

Each publication shares a temporary image resolver across archive seeding, affected days, and homepage/RSS rendering. Each rebuild alarm likewise shares resolved image results and the two-request limiter across its daily staging views and final homepage/RSS preparation; newly discovered metadata is written through the current staging view. This cache is discarded between alarms. It resolves at most two owned images concurrently and caches successful, missing, and malformed results for that publication only. Later publications can discover repaired images. External image URLs are never fetched for dimensions.

Compact footer links include `/calendar/` and link to `/road-conditions/`, `/power-outages/`, and `/emergency-resources/`. These pages direct readers to verified official Caltrans, Southern California Edison and San Bernardino County resources. They do not mirror current incident status.

To repair an archive, back up the committed index, manifest, catalogue, and affected day records. Prepare corrected sources at new immutable revision keys and install a reviewed manifest through the guarded publication repair endpoint described below, which queues regeneration: archived copies of that selected source refresh, including deliberate removal of its items. For content already outside the selected source history, correct the affected private daily JSON records, write them at new SHA-256-based keys, update a copied catalogue with the new keys and honest modification times, then install its reference through a copied publication manifest and the guarded repair endpoint. Set the index's direct `archives` pointer to the same catalogue as the copied manifest, preserving its RSS pointer in that index commit. Preserve any private `legacy_receipts` metadata in the copied manifest. Keep the original objects for recovery; do not overwrite immutable data or cards. Run a rebuild to regenerate missing cards and cards whose recorded inputs no longer match the corrected headline. If generating a card manually through `dailyCard`, save its matching `cardInputHash`, catalogue card version, and content-addressed image reference; otherwise the next rebuild safely regenerates it. Verify the page, card, catalogue and sitemap together after regeneration completes. Rollback must retain v2 source revisions and archive catalogue references. During incomplete migration it must also preserve `legacy_receipts`; older releases that discard it can reintroduce expired backups. Releases without the optional direct index pointer continue using the manifest fallback and therefore require matching pointers.

Default browser fonts are self-hosted DM Sans and Instrument Serif with `font-display: swap`. Newsreader and Fraunces stylesheets load only for their active/restored themes. Regenerate committed WOFF2 files offline with `npm run fonts`; retain the adjacent font licenses and bump versioned filenames when replacing released bytes.

Normal pages and the public 404 page inline the same bundled theme initialization, essential palettes, font declarations, and browser theme-color update. The shared fragment owns the single theme-color meta tag before its update script. Normal pages also inline the decorative theme variables and textures; the 404 omits them while preserving all five themes. The 404 page restores the saved `lakearrowhead_theme` cookie before painting, including Night Sky, and uses the selected theme's fonts without adding a theme picker. Invalid or inaccessible cookies and disabled JavaScript retain the default Deep Lake & Lodge palette. Unknown optional-font names produce no request, and each required family loads once. Error rendering needs no R2 reads or publication data.

Template assembly requires exactly one `<!-- theme-head -->` marker inside `<head>` and throws during initialization if it is missing, duplicated, misspelled, or outside the head. Opening and closing head tags accept mixed casing. Shared `{{site.name}}`, `{{site.background}}`, and `{{site.foreground}}` placeholders are escaped for HTML text/attributes; bundled CSS accepts only the two six-digit hex color placeholders. Unsupported or unresolved site placeholders fail initialization. Node theme tests bundle the actual renderers in memory and execute their head scripts in document order.

## Responsive thumbnails

Owned content images with known dimensions use `<picture>` with explicit-format WebP sources and original-format `<img srcset sizes>` fallbacks on the homepage, daily archives, and story updates. The browser selects an on-demand thumbnail for the existing 96px mobile / 160px desktop boxes and display density. Portrait `sizes` account for the height limit. Originals, authored Markdown, upload responses, RSS images, external images, and share cards retain their existing formats and URLs.

`GET` and `HEAD /thumbnails/v2/<sha256>.<source-extension>/<edge>.<output-extension>` use canonical formats independent of Accept. Output may be WebP or the original format only; responses do not vary on Accept. Successful derivatives are retained privately in R2 and reused across edge locations. An actual cold HEAD returns a no-store 302 to the original without an ETag or transformation. A warm HEAD returns verified derivative metadata without reading image bodies. Conditional GET returns 304 only for a verified derivative; a cold conditional GET must generate and persist it first. Cold Workers Cache HEAD requests may internally fill through GET. Fallback `src` always uses a retained candidate.

`GET` and `HEAD /thumbnails/v1/<sha256>.<jpg|png|webp|gif>/<edge>` accept only edges 96, 160, 192, 288, 320, and 480, with no query parameters. The `IMAGES` binding reads original R2 bytes and resizes without cropping or upscaling. It preserves transparency and animation, serves quality-80 WebP when explicitly accepted, and otherwise retains the source encoding. Successful responses use one-year immutable browser and Workers caching, `Vary: Accept`, representation-specific weak ETags, and conditional 304 responses. Encoding changes require a new URL version.

Use **Images Free only**, with its 5,000 unique transformations per month; do not activate a paid plan. Check **Images & Stream → Transformations** usage and **Plans** before rollout. A quota error (`9422`), unavailable binding, or transformation failure logs `thumbnail_fallback` with a fixed reason and preset, then returns an uncached 302 to the original image. Missing originals stay 404. A fallback never acquires an immutable thumbnail cache entry. Cached derivatives remain available when the Images binding is unavailable or its quota is exhausted, but deleting the original still makes the thumbnail return 404. GET may write only private `thumbnail-cache/v1/` artifacts; HEAD never writes. The cache key includes source identity, edge, resolved format, and transformation recipe. Conditional writes select one winner under concurrent fills; damaged cache metadata is reconstructed. Complete encoded output must fit the existing 10 MiB image budget before persistence; larger or incomplete output falls back to the original. A conclusive oversized result stores only a private, versioned zero-byte outcome record bound to the source, recipe, edge, format, and limit, so later requests redirect without repeating the transform. This is never a verified image and never returns 304. Storage, quota, and interrupted-stream failures do not create oversized records; failed marker persistence may require another transform. Damaged records are reconstructed conditionally. Legacy v1 sources with absent or invalid public metadata cache validated detected dimensions/format privately under `thumbnail-cache/v1/source-metadata/`; thumbnails never rewrite originals or public metadata. Detection metadata persistence is best effort and happens after derivative lookup; a failed write does not hide an existing derivative or prevent successful encoding. The Worker schedules this optional write with `waitUntil`, so delivery does not wait for it; direct invocations without an execution context await it for compatibility. Derivative-cache persistence itself remains required before delivery. Unknown legacy formats probe the derivative before downloading the source only when negotiation yields the same output for every supported source type. Without that proof or stored metadata, an unavailable Images binding redirects without downloading the original. A successful derivative PUT serves its buffered bytes directly; losing fills read the stored winner. Independent original/cache reads run concurrently and settle before unused bodies are cancelled. No cache garbage collection is introduced. Diagnostics include `thumbnail_cache_hit` only for initial verified image delivery/revalidation requiring no encoding (a losing fill emits `thumbnail_cache_fill` with `outcome: "race"` instead), `thumbnail_cache_outcome_hit` for initial cached oversized redirects requiring no encoding (a transformed race loser emits only its fill-race event), `thumbnail_source_metadata_write_failed` for best-effort detection persistence failures, and `thumbnail_cache_fill` with bytes written, and fixed cache-failure reasons. Repeated identical transformations within a month and different output-format variants do not each consume another unique transformation. Six requested presets per image consume the allowance at roughly 833 distinct images monthly; only requested transformations count.

`npm run test:thumbnails:preview` uploads fixed JPEG, transparent PNG, and two-frame GIF fixtures to the allowlisted preview environment. It verifies encoding, alpha, animation, exact candidate widths, conditional requests, cache isolation/hits, and at least 90% JPEG download savings. It publishes preview verification stories and prints the temporary directory containing encoded files for visual inspection. It never writes production content and rejects localhost before reading credentials. Fixtures are local and importing the script performs no network or publication work. Local Images tests use a reduced-fidelity encoder; run the preview check before production deployment.

Deploy preview and complete the normal rebuild before checking real browsers at mobile/desktop sizes and 1×–3× density, then deploy production through the existing rebuild workflow. Daily archives render with the current template. To roll back, restore original-image markup and rebuild the homepage while retaining the versioned thumbnail endpoint for cached HTML.

## Upload images

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/images" \
  -H "Authorization: Bearer $API_SECRET" \
  -F 'file=@photo.jpg;type=image/jpeg'
```

Use exactly one multipart `file`. JPEG (`image/jpeg`), PNG, WebP, and GIF files up to 10 MiB are supported. The canonical media type must match the signature; aliases, generic/missing types, SVG, and contradictory types receive `415`. Signatures and readable positive image dimensions are checked without full image decoding or re-encoding. JPEG orientation is accounted for; truncated headers without dimensions receive `415`. Let curl generate the multipart boundary.

The response is `200 {"ok":true,"url":"https://lakearrowhead.town/images/<sha256>.jpg","width":1200,"height":800}` (plus the existing request ID). Dimensions are recorded privately in `image-metadata/<sha256>.json`. Identical bytes return the same URL. Images have one-year immutable browser and Cloudflare Workers cache policies; an edge cache miss reads R2. See [Workers Caching configuration](https://developers.cloudflare.com/workers/cache/configuration/).

Upload images first, include their returned URLs as `![Description](https://lakearrowhead.town/images/<hash>.jpg)` in Markdown, then publish. Two image uploads may process concurrently per isolate; excess requests return `503` with `Retry-After: 1` before their bodies are processed.

The first Markdown image appears at the upper left of the article body, with text wrapping beside and below it. Thumbnails fit within 160 × 160 px, or 96 × 96 px on screens up to 600 px wide, preserving the full image without cropping. Additional images keep their body positions and use the same size limits. Every image and article headline links to the original `post_url`; articles without images use the linked headline. Captions, formatting, and other body links are preserved. Moving an image adds no spaces: text on either side joins directly unless the author supplied whitespace. Leading caption breaks are removed; middle and trailing breaks remain. The first rendered content image uses `loading="eager"`; subsequent images, including update images, use `loading="lazy"`. All use `decoding="async"`. Owned uploaded images get intrinsic width/height attributes; publication and rebuilds backfill metadata for existing images from R2. External image URLs are never fetched for dimensions. These are rendering changes only: the stored Markdown and uploaded image bytes stay intact, and template rebuilds apply the layout to the existing published snapshot.

## Rebuilds, migration, and operations

Normal code deployments queue background rebuilds automatically:

```sh
npm run deploy:preview
npm run deploy
```

These commands require matching credentials from an environment-specific process variable or local file and do not rotate secrets. They report success after code deployment and durable job creation, not after rendering. A failure to enqueue is a command failure even if code deployment already succeeded. Fix the credential/connection issue and use `rebuild` to queue work without redeploying. If `SITE_URL` was set for local testing, unset it before deployment; deployment scripts reject localhost rebuild targets.

```sh
npm run rebuild -- preview
npm run rebuild:status -- preview JOB_UUID
npm run rebuild:resume -- preview JOB_UUID
# Use production instead of preview for the live site.
```

Status includes the job ID, phase, migration count, timestamps, and queued/running/completed/failed state. Check it manually. During archive work, optional `archive_progress: { completed_days, total_days }` reports progress separately from the legacy migration count. These counts describe archive preparation, so `completed_days` can equal `total_days` while the job is still running for final rendering, reconciliation, or commit. Use job `status: "completed"` to confirm completion. Counts can change when the job reconciles with a newer publication; private checkpoint keys and receipts are not returned. Application failures pause at the first error and retain the current HTML until a successful replacement. Resume the failed queue head after repairing the cause. Later queued jobs report `blocked_by` when a failed earlier job blocks them. There are no external alerts or indefinite automatic retries for fatal application failures. Publication conflicts reconcile automatically with persisted backoff.

Jobs use persistent Durable Object state and one-shot alarms, surviving object eviction. Archive work processes at most ten pending days per alarm and renders one PNG at a time, persisting completed artifacts and private versioned per-day receipts before continuing. Aggregate checkpoints retain references rather than PNG buffers and are written only for incomplete archive passes; terminal passes leave reusable per-day receipts without writing a final aggregate checkpoint. Receipt recovery counts against the same ten-day budget, so interruption cannot trigger an unbounded receipt scan. Between alarms, publishing, appends, and retraction remain available.

Mutations, rebuild alarms, and paginated story reads load selected sources in ordered batches of at most four, settling each batch before processing results in source order. Mutations preserve damaged-source omissions; fatal failures stop before another batch starts. Paginated reads do not prefetch beyond the remaining response capacity. Source bodies are not cached between alarms, so same-key operator corrections remain visible. Each chunk reconciles against the latest committed catalogue and source contents, invalidates changed day inputs, and drops removed days.

The final index check compares bytes and metadata with the same alarm snapshot that selected the rendered publication. The publishing queue prevents supported mutations from interleaving with rebuild finalization, so a rebuild cannot overwrite a newer queued publication. The final index PUT is conditional on the initial index ETag (or on absence for a new index). A rejected condition leaves the competing index intact and reports definite non-commit. ETags cover bytes, so concurrent raw R2 metadata edits are unsupported: install pointer repairs through the serialized publication repair endpoint. Do not combine ETag and upload-time conditions as a metadata guard; a matching ETag takes precedence over the date condition. A conflicting rebuild retains its job and archive receipts, reconciles fresh inputs, and retries after 1, 2, 4, 8, 16, then at most 30 seconds. Its persisted `next_retry_at` survives eviction and is included in job status. Fatal application failures still stop for repair.

Completed job checkpoints are unlinked from Durable Object state; unreferenced immutable R2 work artifacts follow the existing operator-managed cleanup policy. Migration and rendering share the publishing queue. The initial job imports old `digests/YYYY-MM-DD.json` files in checkpointed batches of 25, using their R2 upload times as receipt times. Stable legacy IDs and conditional writes prevent duplicate imports after interruption. Existing sources and old daily HTML remain private backups. Normal publishing merges legacy/imported identities during migration.

Legacy discovery during normal publishing continues until migration reports completion, even after a v2 manifest has been committed. Its existing seven-day Los Angeles receipt-date eligibility remains separate from the 30-day committed history window. Each incomplete-migration mutation needs one fresh paginated `digests/` listing so late arrivals remain discoverable; bootstrap shares that listing rather than repeating it. Completed migration disables raw discovery. A damaged legacy input can prolong this cost until an operator repairs it and resumes migration.

Existing committed references take precedence over legacy backups before the 30-day retention filter runs. While migration is incomplete, manifests also retain optional private `legacy_receipts` metadata mapping known legacy IDs to their original server receipt timestamps. Anchors come only from committed selected/omitted references and newly committed legacy sources, never refresh from reuploaded backups, and survive reference eviction. A known expired legacy identity cannot be reintroduced through raw discovery on a later publication. A successful publication or rebuild after confirmed migration completion removes these anchors; duplicate-only submissions remain write-free. This does not extend API URL deduplication beyond 30 days, expand archive seeding, or recover provenance already lost before these anchors were recorded. No older manifests, orphan sources, or operator backups are scanned to reconstruct it.

For the initial snapshot, the old stored index's upload time supplies the publication time and date-window anchor. Conditions replacements first preserve that time as private `news_published_at` metadata, so subsequent bootstrap uses the original anchor. Invalid saved anchors require backup restoration; conditions-only bootstrap objects remain excluded from news provenance. If there is no index, the latest legacy receipt time is used. Later rebuilds use the published manifest so they cannot advance the date window or introduce uncommitted source posts.

To restore an omitted post, a Cloudflare operator must restore valid source JSON at the exact R2 key identified in the warning, using the dashboard or Wrangler. Use the original saved request or a backup; imported legacy posts may still have their original `digests/*.json` backup. This project does not keep a second source copy for newer posts. Restoring a source does not change the homepage immediately: a subsequent publication containing new stories includes it again only if its original receipt date remains eligible. A matching API submission returns its historical duplicate identity and does not refresh its receipt time; a duplicate-only submission does not restore the homepage.

Template rebuilds neither read nor reconsider omitted references, even after restoration. If a selected source becomes damaged, the rebuild pauses and leaves the stored homepage unchanged. Restore that source and resume, or publish a new digest (which omits the damaged source) before resuming the job. Invalid legacy sources still pause migration and require repair before migration can finish.

A damaged-source rebuild records `error_code: "source_damaged"` on its failed job. The correlated `rebuild_failed` log identifies `source_key`, `post_id`, and the fixed `reason` (`missing`, `invalid_json`, or `invalid_digest`); it never includes the source contents or parser excerpts. Use that exact key when restoring a backup. Enqueue, status, and resume storage failures emit `rebuild_request_failed` with their internal `storage_error` and failed stage; the rejected HTTP RPC remains `503 service_unavailable`. Unconfirmed enqueue IDs are `candidate_job_id`, not persisted job IDs. Alarm startup failures emit `rebuild_alarm_failed` with a generated request ID, executing version/environment, and `job_id` only after an existing unfinished head is confirmed, then rethrow for bounded platform redelivery. Queue lookup stages carry `queue_entry_id` for the reference being read; an unreadable or entirely stale queue does not imply a confirmed job. These management/startup failures omit `publication_status`; they do not establish a job execution or homepage commit outcome. Actual execution failures retain `rebuild_failed` and their tracked commit certainty. After the job loads, events use its original request/job correlation.

`rebuild_failed` records a failed execution attempt, before saving the job's failed state. A successful `rebuild_failure_record` stage confirms that transaction completed; use status to inspect the current persisted job state. If that transaction also fails, `rebuild_failure_record_failed` records stage `rebuild_failure_record`, the persistence error code, `original_failed_stage`, `original_error_code`, tracked publication certainty, and the same request/job/version correlation. The alarm rethrows for bounded platform redelivery. Repeated attempts can therefore emit repeated execution failures without a persisted `failed` status. Repair the cause and use manual resume if the queue head is left queued/running without an alarm; do not infer job state from execution-event counts.

Cloudflare retries a throwing alarm up to six times. Once those attempts exhaust, the head job can remain `queued` or `running` with no scheduled alarm. After repairing storage/service availability, inspect its request/job logs and status, then run `npm run rebuild:resume -- preview JOB_UUID` (or the production equivalent). Resume also accepts an explicitly paused queued/running queue head even when an alarm exists or delivery is queued, or an unpaused head with no alarm or pending delivery; eligibility is checked under the serialized publisher. An accepted response is `202` with the job queued; poll until completion. A completed job, a job behind another valid job, or an active unpaused queued/running head with an alarm or pending delivery returns `409 job_not_resumable`. Missing requested jobs remain `404 job_not_found`. Status reads remain read-only and do not schedule recovery. No indefinite startup retry loop is added. A new enqueue can also schedule pending work, but manual resume avoids adding another job.

Rebuild status adds an optional `blocked` object with `reason`, applicable `job_id`/`repair_id`, and optional `retry_at`. Reasons are `manual_resume`, `unscheduled`, `failed_rebuild`, `repair_pending`, `repair_stalled`, `repair_damaged`, and `rebuild_checkpoint_damaged`; existing job-blocker `blocked_by` remains supported. Inspection is read-only. Waiting tools honor pending repair deadlines and stop immediately on other blockers with targeted recovery guidance. Repair re-POSTs wait through the entire trusted retry deadline in bounded sleep chunks; read-only status polling can continue every 30 seconds. Individual sleeps are capped at 30 seconds and the remaining overall timeout. Server `Retry-After` delays or deadlines interpreted against the response `Date` use monotonic time internally, so local clock skew cannot create one long sleep; absent timing headers fall back to bounded polling. Repair deadlines still apply to rebuild resume; use the guarded repair-resume endpoint to reset repair recovery. An absent alarm alone does not establish a manual pause: new jobs persist scheduling intent, and delivered alarm handlers register before joining the serialization queue. Existing explicit pauses are never automatically cleared.

All rebuild operations use the first existing unfinished job record as the effective queue head, skipping missing records and completed jobs. Status reads past those stale references without changing storage, so later queued jobs still report `blocked_by` when that head has failed. Enqueue also respects the effective failed head and does not schedule an alarm past it; it leaves stale references for alarm processing or an accepted resume to prune. Completed job records and timestamps remain unchanged.

Alarm processing logs `rebuild_queue_entry_missing` at error level for each missing leading record and `rebuild_queue_entry_completed` at info level for each stale completed reference. It transactionally prunes those leading references and continues at the first existing unfinished job. Detection events do not confirm removal; check the `rebuild_queue_repair` stage outcome. Accepted manual resumes prune stale leading references in the same transaction that queues the job and schedules its alarm. `rebuild_resume_queue_repair` times that enclosing transaction; its nested `rebuild_resume_write` timing supplies the primary failure stage if the transaction fails. These timings overlap and must not be summed. Rejected `409` and missing-job `404` resume requests change no queue, job, or alarm state; detection logs from rejected inspections remain enabled. Valid failed heads still pause later work; storage read failures never count as missing records. If all references are missing or completed, alarm processing clears the queue without rendering or changing publication objects, metadata, ETags, or completed job records.

A missing, malformed, or structurally invalid committed manifest returns `500 manifest_damaged`, `retryable: false`, and records that code on a failed rebuild job. Correlated logs identify `manifest_key` and a fixed `reason` (`missing`, `invalid_json`, or `invalid_manifest`); contents and parser excerpts remain excluded. Restore the exact committed manifest from a private backup, then resume. Do not delete the index's manifest reference or fall back to legacy discovery, which could select different content. Valid version-1 manifests without `omitted_posts` remain supported.

API version 2 intentionally changes the resume conflict code from `job_not_failed` to `job_not_resumable`, and adds `manifest_damaged`. Update controlled callers before production rollout; keep using `retryable` and publication certainty for retries and handle unfamiliar codes gracefully.

| R2 key | Contents |
| --- | --- |
| `posts/YYYY-MM-DD/<id>.json` | Private server-dated source posts |
| `publications/<uuid>.json` | Immutable private snapshot manifests |
| `pages/index.html` | Public rendered index; metadata references its manifest |
| `images/<sha256>.<extension>` | Immutable uploaded images |
| `archive-days/<sha256>.json`, `archive-catalogs/<sha256>.json` | Private immutable daily content and archive catalogues |
| `assets/daily/<sha256>.png` | Immutable public daily share cards |
| `digests/*.json`, `pages/digests/*.html` | Retained private legacy backups |

Public routes include `/`, `/index.html`, `/archive/`, published `/YYYY/MM/DD/` daily pages, `/road-conditions/`, `/power-outages/`, `/emergency-resources/`, `/images/<hash>.<extension>`, `/assets/daily/<hash>.png`, the versioned `/assets/fonts/` files, and the explicit metadata/artwork routes listed above. Invalid or unpublished daily dates and legacy `/digests/...` routes return `404`. Digest sources, publication manifests, private archive content/catalogues, bucket listings, artwork source files, and config files are never exposed. There is no public administration UI.

HTML and RSS support HEAD and weak ETag revalidation, require revalidation, permit compression, and bypass edge caching. Malformed `If-None-Match` conditions are ignored consistently for public GET and HEAD requests. Image GETs use Workers Caching. Protected APIs always return `no-store` JSON. Maintenance CLI errors preserve HTTP status even when Cloudflare returns non-JSON content.

Public non-API `404` responses use an HTML page, including missing image URLs. Other public errors remain minimal JSON; `/api` errors retain their structured JSON contract. All application error responses force `Cache-Control`, `Cloudflare-CDN-Cache-Control`, `CDN-Cache-Control`, and `Surrogate-Control` to `no-store`, enforce their content type and `X-Content-Type-Options: nosniff`, and have no body on HEAD. Header handling accepts every `HeadersInit` form without mutating it; targeted overrides preserve other headers such as `Allow`, `Retry-After`, authentication challenges, diagnostic headers, and intentional cookies. A conditional request to a missing resource remains `404`. The 404 page always sends `noindex` through its robots meta tag and `X-Robots-Tag` header; the origin-based indexing policy still applies independently. API paths are case-sensitive, so incorrectly capitalized paths such as `/API/posts` are unknown public paths.

RSS smoke checks require its MIME type on GET/HEAD 200 responses. A 304 need not contain `Content-Type`, but a present value must match the RSS MIME type; conditional checks still require the unchanged ETag, cache/indexing policy, and an empty body. The separate strict public HTML ETag check remains required before production rollout.

## API errors and request provenance

Every application-generated `/api` response has `X-Request-ID`, `X-Worker-Version` (Cloudflare version ID), and `X-API-Version: 3`. JSON API replies also include `request_id`; HEAD responses have no body. These headers identify the code handling the request independently of the stored homepage's age. Cloudflare edge/WAF failures that never reach the Worker may have a different response shape and no application request ID.

```json
{
  "ok": false,
  "error": "Digest validation failed",
  "code": "validation_failed",
  "request_id": "request-uuid",
  "retryable": false,
  "publication_status": "not_attempted",
  "details": [{ "path": "items[3].posted_at", "code": "invalid_timestamp", "message": "Expected an ISO timestamp with a real calendar date and explicit timezone." }],
  "details_truncated": false,
  "diagnostics": { "stage": "validation", "bytes_received": 5120, "body_complete": true, "body_sha256": "sha256-of-the-exact-received-bytes" }
}
```

Validation collects up to 50 field issues and rejects the entire batch before writes; `details_truncated` indicates additional issues. A non-object digest or item gets one structural issue without redundant child-field issues; later items are still checked. Malformed JSON and invalid UTF-8 have separate codes. Syntax details include zero-based UTF-16 `position` and one-based `line`/`column` only for recognized, bounds-checked parser-location formats; CRLF counts as one line break, and lone CR or LF each count as one. Unknown formats omit locations. Input excerpts are never returned or searched for locations. Complete authenticated digest bodies are fingerprinted before parsing. Partial or rejected-before-read bodies never receive a complete-body hash. Compare `body_sha256` against `shasum -a 256 payload.json` and use `--data-binary @payload.json` to investigate transmitted-byte differences.

`bytes_received` counts body bytes consumed by the Worker, not transport bytes received by Cloudflare. Optional `declared_body_bytes` is the unverified numeric Content-Length header. Rejecting that header before reading reports zero consumed bytes and `body_complete: false`. Multipart `body_complete` follows stream EOF independently of parsing: a fully read malformed form can report true. Public non-API errors other than the HTML 404 page retain a minimal `{ok, error}` body, with full diagnostic details in logs.

| Status | Codes / meaning | Caller action |
| --- | --- | --- |
| 400 | `invalid_utf8`, `invalid_json`, `validation_failed`, `invalid_multipart`, `invalid_file_field` | Correct encoding, syntax, fields, or multipart form. Empty digests report `empty_items` in validation details. |
| 401 | `unauthorized` | Supply the correct publishing credential. |
| 404 / 405 | `not_found`, `job_not_found`, `index_not_found`, `method_not_allowed` | Check the route or the `Allow` header. |
| 409 | `job_not_resumable`, `publication_changed`, `rebuild_blocked` | Resume an eligible failed, explicitly paused, or unscheduled queue head; active scheduled heads cannot resume. A stale repair requires a newly reviewed snapshot; unrelated failed rebuilds remain blocked. Duplicate digests return 200. |
| 413 / 415 | `body_too_large`, `unsupported_media_type`, `image_type_mismatch` | Respect the size limit and canonical media type/signature. |
| 500 | `storage_error`, `render_failed`, `body_read_failed`, `internal_error`, `manifest_damaged` | Storage/body transport failures are retryable; rendering, internal failures, and damaged manifests require operator repair. An uncertain publication outcome always allows unchanged-payload retry within its original receipt window. |
| 503 | `configuration_error`, `archive_damaged`, `legacy_recovery_required`, `uploads_busy`, `service_unavailable`, `publication_conflict`, `confirmations_not_enabled`, `repair_blocked` | Disabled batch confirmations are non-retryable and use ordinary-update fallback only after definite rejection. Inspect blocking repairs and honor their retry deadlines. Configuration, archive damage, and missing bootstrap metadata require operator repair; upload contention and unavailable publishing/rebuild RPCs are retryable. Uploads retain `Retry-After: 1`. |

`retryable` means an unchanged operation may reasonably succeed later; fix 4xx input errors rather than repeating them. Digest failures additionally report `publication_status`: `not_attempted` means no publication dispatch occurred, including rejection inside the publisher; `not_committed` means a failure before index replacement; `unknown` means an index write or RPC acknowledgement may have been lost; `committed` means the replacement is known to have completed. An unknown outcome is not a JSON error. Retry the identical payload only within the receipt-based deduplication window. A confirmed `committed` failure keeps the underlying error's retryability: the publication has completed, and the failure concerns subsequent processing. Reconcile the committed result first. A retryable digest or append may be repeated unchanged within its original history window; an already-completed retraction may be confirmed with the original token while its record remains retained, even after the initial 24-hour deadline. Such retries confirm the retained outcome and do not guarantee that failed subsequent processing runs again. Persistent follow-up failures and non-retryable committed errors require operator investigation.

## Recover missing publication metadata

Persisted migration completion with no index manifest pointer is inconsistent state. Publishing, append/retraction attempts, and rebuild execution stop with `503 legacy_recovery_required`, `retryable: false`, without rediscovering raw digests or replacing the homepage. A fresh initial migration still checkpoints as incomplete until its bootstrap publication commits. Guarded repair does not relax this check or enable raw legacy discovery.

Use the authenticated `GET /api/publication/repair` snapshot to obtain the existing index's R2 `version` and its `manifest`, `rss`, and `archives` pointers, even when a pointer is damaged. Back up the current index bytes and metadata plus the relevant immutable objects. This endpoint requires an existing stored index; a missing one returns `404 index_not_found` and needs backup reconstruction rather than an inferred publication.

Prepare corrected sources and manifests at new immutable keys. Preserve original source IDs, receipt dates, legacy receipts, archive history, and the intended saved publication selection. Never choose a manifest merely because its upload timestamp is newest: it may be an abandoned publication. Do not reset the migration-complete marker or enable raw rediscovery. Restore a known original selection from verified backups; do not include arbitrary orphan sources or refresh their receipts.

Create a reviewed JSON repair file containing:

```json
{
  "expected_version": "VERSION_FROM_SNAPSHOT",
  "manifest": "publications/00000000-0000-0000-0000-000000000001.json",
  "rss": "publications/00000000-0000-0000-0000-000000000001.rss.xml",
  "archives": null
}
```

Use the actual existing immutable object keys. `archives` must match the selected manifest, and may be null only when that manifest has no archive reference. The server validates the selected manifest, effective rebuild sources, history, catalogue, and RSS existence before writing. Legacy `digests/...` references are validated at the canonical `posts/...` keys that rebuilds consume after migration; during incomplete migration, an explicitly referenced raw legacy source may be validated when its canonical output is not yet present. Preparing a repair never discovers orphan sources. Missing or invalid candidate objects return `400 invalid_repair_target` with the affected key and reason, rather than claiming that live content is damaged. Storage transport failures remain server errors. Visible index HTML, HTTP metadata, and unrelated custom metadata are preserved until regeneration. Real index replacements rotate an opaque, non-rendering `publication-fence` comment, so repair may change raw HTML bytes and ETags without changing visible content or news dates. The fence remains unique across all supported writers, including conditions-only writes; no-op requests do not rotate it. Do not overwrite selected sources or install raw index metadata while publishing is active.

```sh
node scripts/maintenance.mjs snapshot preview
node scripts/maintenance.mjs repair preview reviewed-repair.json
# Use production instead of preview for the live site.
```

These use the existing publishing credential and destination allowlist. The repair command reports the result and follows its rebuild to completion without issuing a resume request. A configurable monotonic 30-minute overall deadline covers submission, reconciliation, and rebuild polling; each HTTP request remains capped at 30 seconds. When that deadline is reached with a known nonterminal rebuild, waiting tools allow exactly one final read-only status GET, bounded by the original deadline plus 30 seconds. Grace never submits or resumes work and never retries its final GET. A completed job succeeds only when the ordinary repair result is otherwise established; unresolved repair submission still requires snapshot reconciliation. Without a known job there is no grace request. Timeout means completion remains unconfirmed, not that the durable rebuild failed. Override the overall deadline with `--timeout-ms <positive integer>`, for example `node scripts/maintenance.mjs repair preview reviewed-repair.json --timeout-ms 600000`. Timeout and polling errors retain the committed repair's job ID and last status. A timeout stops the CLI, not the durable rebuild. A valid application error explicitly declaring `retryable: false` from the final status check (for example `401 unauthorized`, or `404 job_not_found` for a previously established job) retains its status, code, corrective message, job ID and last observed status. A reserved repair job awaiting activation may legitimately return `404 job_not_found`; that case remains unconfirmed. Non-JSON errors and malformed application errors, including errors missing explicit retryability, also remain unconfirmed during the final check. Transport failures, retryable failures, malformed replies and exhausted grace still report completion as unconfirmed. The final GET is never retried. Tests injecting both sleep and monotonic time must advance that clock when sleep resolves; a nonadvancing pair fails clearly instead of spinning.

`POST /api/publication/repair` accepts the same JSON and returns `publication`, `unchanged`, an optional `repair_id`, and the regeneration `job` for a changed repair. Pointer changes share publisher serialization with mutations and rebuilds. GET/HEAD snapshots use a body-free R2 HEAD outside that queue, so inspection remains available during rendering. An unrelated failed head returns `409 rebuild_blocked` before expensive validation or pointer changes.

Before replacing pointers, the publisher durably saves the reviewed version/ETag, target pointers, repair ID, reserved job, and reconciliation alarm. A private `lakearrowhead_repair_id` index metadata marker identifies the write after a lost acknowledgement. Complete proposed metadata must fit the 8,192-byte R2 limit before the journal or scheduling is changed; oversized requests return 400 without creating a blocker. Recovery rechecks the marker on both HEAD and GET results. A changed metadata version or a rejected retry does not establish that an earlier uncertain write failed; cancellation requires proof that the original condition cannot still commit. A failed head is left unchanged until the replacement commits. One transaction then records the result and activates exactly one regeneration job: a related failed head or repairable paused head is reused, otherwise the reserved job is queued. Reusing a paused head keeps its job ID, pause reason and manual scheduling; explicitly resume it after reviewing the repair. Unrelated paused heads return `409 rebuild_blocked`; damaged checkpoint/generation evidence stays blocked with backup-restoration guidance. Neither path changes pointers or adds another job. Recovery keeps reusable archive receipts and resets old conflict backoff on explicit resume or repair activation.

A stale version or rejected conditional repair returns `409 publication_changed`, `retryable: false`; a definite rejected PUT reports `publication_status: "not_committed"`. Fetch and review the current snapshot before preparing another repair. The CLI never silently refreshes a reviewed version. A repair that cannot yet be reconciled returns `503 repair_pending`, `retryable: true`, publication certainty, `details.repair_id`, `details.job_id`, `Retry-After`, and ISO UTC `retry_at`. Retry the **identical** repair file to recover its result; a confirmed commit retains its job ID even if activation bookkeeping fails. Repair reconciliation persists delays of 5, 10, 20, 40, 80, 160, then at most 300 seconds, and runs before later index writers. Identical early retries honor the saved deadline without dispatching or consuming attempts. After 10 failed attempts it stalls without further automatic wake-ups: approximately 20 minutes 15 seconds plus operation time for a new cycle. Explicit resume resets the budget while retaining the repair and reserved job identities. Status reads and previews never perform recovery. Other requests receive `repair_blocked` with a distinct blocker identity, never the other repair's commit certainty. It never replays against a different version or invents missing content. Ordinary digest/append/retraction commit conflicts retain their existing `503 publication_conflict` retry contract.

GET/HEAD `/api/publication/repair` additionally exposes `recovery` (null when idle), with state `pending|stalled|damaged`, attempts, known repair/job IDs, publication certainty, retry deadline, sanitized last error, and opaque `recovery_token`. After fixing the cause, POST `/api/publication/repair/resume` or `/cancel` with `{ "expected_recovery_token": "TOKEN_FROM_INSPECTION", "expected_version": "VERSION_FROM_INSPECTION" }` using the existing credential. Changed state returns `409 repair_recovery_changed`. Resume resets the attempt budget and retains the original job. Cancellation cannot undo committed content or force-clear an uncertain conditional write; `409 unsafe_repair_cancellation` requires reconciliation/resume. A known committed repair finishes activation instead. A damaged journal returns inspectable diagnostics: restore the private `publication_repair_pending` value and its referenced `repair-request:<hash>` record together from a verified Durable Object backup before resuming. Preserve input, ID, phase, certainty and reserved job; never fabricate a journal or delete an unknown-write gate. Inspection and cancellation cannot repair missing backup data.

Durable receipts are indexed by the canonical repair payload. Repeating an accepted repair returns `unchanged: true`, its original resulting publication snapshot, and its job without changing the current index, even after regeneration installs newer pointers. Use GET for the current snapshot. Already-installed pointers also remain a no-op, and existing version-based receipts remain readable. Retain completed repair records and receipts while acknowledgements may be retried; they follow the existing operator-managed cleanup policy.

After regeneration, verify stories, RSS, archives, and sitemap together. Retain immutable backups for recovery. Concurrent raw R2 metadata replacements remain unsupported; supported pointer changes must use this endpoint.

Damaged archive pointers, catalogues, or daily records return `503 archive_damaged` with operator-repair guidance and no `Retry-After`; API responses mark them non-retryable. Network/storage transport failures retain their normal retryability. Archive readers and mutations fail closed and never silently substitute an older catalogue. Batch lookup through a valid manifest/history remains independent of a damaged direct archive pointer.

### Rebuild generation rollout and recovery

Deploy the compatible-reader commit before enabling the generation-writing commits. New jobs expose optional `generation_id`; retries and explicit resumes keep it. A related repair creates a fresh generation on the same job. Its immutable private `rebuild-generation:JOB_ID:GENERATION_ID` handoff retains the preceding job, checkpoint, archive checkpoint and diagnostics. Repair activation changes index bytes to fence earlier conditional writes before installing a prepared v2 `rebuild-finalization:JOB_ID` checkpoint. It preserves an existing operator pause; it never resumes the job automatically. Repeating an accepted repair does not create another generation or queue entry.

V2 checkpoints bind the generation and distinguish `prepared` from `dispatching`. The latter is saved immediately before the conditional index PUT, after artifact preparation. Receipt recovery requires both `lakearrowhead_rebuild_id` and `lakearrowhead_rebuild_generation`; older-generation receipts do not complete repaired work. Legacy v1 checkpoints and jobs remain readable. A missing checkpoint may finalize from a matching receipt only when persisted migration is complete; otherwise restore the exact checkpoint from backup. Recovery retains pending conditions intent and never republishes a known completed generation. Damaged generation records require exact-object backup restoration. Preserve retained evidence; no garbage collection is introduced. Once generation writes begin, rollback requires generation-compatible readers.

## Cloudflare diagnostics

Production and preview explicitly persist invocation logs and traces at sampling rate 1, with source-map uploads and query-string redaction. Application logs contain metadata, request hashes, fixed validation paths, bounded hashed duplicate URLs, and sanitized exception classifications/stack locations. They exclude request bodies, submitted field values, credentials, and raw query strings. No rejected-payload archive, external provider, or alerts are configured.

Conditions composition failures emit `conditions_composition_failed` with sanitized `error_code` and stage while preserving committed source-operation success and pending intent. Upstream weather failures include `upstream_status` when available and cancel unused bodies; no upstream body or parser excerpt is logged. V1 and v2 thumbnail request summaries use their respective versioned route labels.

Structured `request_completed`, `request_error`, `operation_stage`, `publish_result`, `publish_failed`, `source_omitted`, and `rebuild_*` events carry request IDs, executing Worker version, environment, and available post/job IDs. Stage events measure authentication, body reading, parsing, validation, queue wait, source loading, duplicate filtering, rendering, and writes. Guarded mutations label the index/manifest-presence check `committed_snapshot_loading`; separate committed-publication reads, including batch lookup, use `publication_loading`; legacy discovery listings use `legacy_discovery`; and selected source-body loading uses `source_loading`. These stage labels distinguish the work instead of counting the guard as another source load. Rebuild state writes, checkpoints, and finalization have separate stages: transient recovery failures emit `rebuild_finalization_pending` before summary persistence, with `error_code`, generation identity when present and tracked certainty. Permanent recovery pauses emit `rebuild_paused` at error level before pause persistence; they retain uncertain/committed evidence and do not assert a failed publication. These failures remain recoverable without classifying the committed page as failed. A private `lakearrowhead_rebuild_id` receipt survives later index replacements, and a versioned durable finalization checkpoint lets eviction recovery complete the same job without another render or index write. A malformed checkpoint emits the distinct `rebuild_checkpoint_damaged` event before pause persistence, then persists an operator pause with `blocked.reason: "rebuild_checkpoint_damaged"`; restore that checkpoint from a verified backup before explicitly resuming, rather than deleting or fabricating commit evidence. Jobs expose optional `recovery: { code, stage, retryable, publication_status, failed_at }` with sanitized last-recovery diagnostics across eviction and bounded retry exhaustion. Committed certainty and unresolved earlier dispatches are retained independently of the current attempt. Explicit execution phases, rather than stage-name strings, route recovery. Definite pre-dispatch failures report non-commit; their obsolete summaries and finalization checkpoints are removed transactionally only when no earlier uncertain dispatch remains. Bookkeeping failures do not mark a committed or uncertain publication failed. Legacy finalization checkpoints remain readable and conservative. Explicit resume clears obsolete failure/pause fields while retaining committed or unresolved recovery evidence until reconciliation; successful completion clears recovery diagnostics. A failure to persist this summary emits `rebuild_recovery_record_failed` and rethrows for platform redelivery. Recovered finalization retains conditions intent until a fresh composition succeeds. Rebuild alarms retain the enqueue request ID and job ID, while recording their executing version. Request summaries include total duration, status/code, counts, publication outcome, declared/consumed byte counts, origin response ETags, and complete-body hashes when available. Detailed public-read and 404 events remain enabled.

Repairs emit `repair_result` with `publication_outcome: "repaired" | "unchanged"`, repair/job IDs when available, and accurate publication certainty. Snapshot and no-op requests report `not_attempted`; changed repairs report `committed`. Expected repair 4xx rejections log `repair_failed` at warning level; server failures remain errors. Recovery failures emit `repair_recovery_failed` with the underlying code and stage. Digest events use `publication_outcome: "published" | "duplicate" | "failed" | "preview" | "preview_failed"`. Preview success emits `preview_result`; preview failures always report `publication_status: "not_attempted"`, even when an RPC acknowledgement is lost. Actual retractions emit `retract_result` and `publication_outcome: "retracted"`. Repeated `already_retracted` requests report that distinct no-op outcome and omit a new-commit `publication_status`. Preparation stages carry `phase: "preparation"`; durable artifact writes carry `phase: "commit"`. Filter write latency metrics to the commit phase. Phases are scoped to artifact preparation and writes; rebuild finalization and failure-state recording have no artifact phase. Token fingerprints and raw client references are never logged. Rejected digest requests remain logged as failed requests with `publication_status: "not_attempted"`; disabled confirmation batches reject before the publishing queue and log at warning level with that certainty and a failed-request outcome; exclude that status when counting attempted publication failures. Duplicate-only success omits `publication_status`; it is not a failed commit. The `publisher_rpc` stage has both `transport_outcome` and application `outcome`: delivering a typed failure reply means transport `ok` and application `error`. Stage durations are inclusive: nested publication/legacy discovery, queue repair, and upload stages overlap and must not be summed as exclusive elapsed time. Active stages are restored after completion and failures retain their actual failed stage. Error codes and retryability come from operation boundaries, not stage-name matching. The `upload_admission` stage measures slot acquisition and identifies busy rejections, which consume no body and emit no `upload_slot_held` event. For admitted uploads, the `upload_slot_held` stage measures the full slot occupancy through body handling, image validation, and storage completion, including the nested `image_validation` and `image_write` stages; it does not measure admission-check latency.

Rebuild recovery summaries describe the last failure; an old `unknown` summary does not override a successful read showing no finalization checkpoint. Every supported index dispatch first saves that checkpoint. With no checkpoint and no proven commit, the next attempt can establish non-commit and report permanent source/render damage as a failed head that a related repair can reuse. A present legacy checkpoint with an unmatched receipt remains uncertain. Permanent failures during unresolved recovery pause with `recovery.retryable: false`, retaining the checkpoint and outcome evidence; correct the cause and explicitly resume, never force-clear an uncertain dispatch. A proven commit with a missing checkpoint finalizes from a matching job/generation receipt when persisted migration is complete; otherwise it pauses for backup restoration. Jobs optionally expose `pause_reason: "manual_resume" | "rebuild_checkpoint_damaged"`, independently of historical recovery codes. Resume clears the active pause reason; unrelated later pauses report their own reason. Legacy paused records retain their previous interpretation until rewritten. Rebuild request failures retain the repair gate's failed stage. Enqueue/resume management failures log `publication_status: "not_attempted"` for their requested operation; any blocking repair's certainty is separate, and existing HTTP certainty contracts are unchanged. Weather pending-intent and ETag persistence failures are classified as `storage_error`.

In the selected Worker's **Observability → Logs**, use the top-level structured fields below with these Query Builder recipes. In **Traces**, open the related invocation by time and Cloudflare invocation/trace metadata; cross-reference application request ID in its logs.

| Investigation | Filters | Group / measure |
| --- | --- | --- |
| One caller report | `request_id` equals the response's `X-Request-ID` | Chronological events across HTTP and publisher RPC |
| One rebuild job | `job_id = "JOB_UUID" OR candidate_job_id = "JOB_UUID"` | Include pre-commit enqueue stages and confirmed job events; follow their request IDs |
| Failures by release | `event = request_completed`, `status >= 500` | Count by `error_code`, `worker_version` |
| Duplicate behavior | `event = publish_result` | Sum `duplicates` and `published`; inspect `duplicate_url_hashes` |
| Attempted publication failures | `event = request_completed`, `operation = digest`, `publication_outcome = failed`, `publication_status != not_attempted` | Count by `error_code`, `publication_status`, `worker_version`; exclude requests rejected before invocation and duplicate no-ops |
| Digest availability failures | `event = request_completed`, `operation = digest`, `status >= 500` | Count by `error_code`, `worker_version`; include configuration and lookup failures with `publication_status = not_attempted` |
| RPC application failures | `event = operation_stage`, `stage = publisher_rpc`, `outcome = error` | Group by `transport_outcome` to separate delivered failures from transport failures |
| API latency | `event = request_completed`, `operation = digest` | p50/p95/max of `duration_ms` |
| Slow storage or queue | `event = operation_stage` | p95/max duration grouped by `stage` |
| Rebuild execution attempt failure | `event = rebuild_failed` | Count attempts, not persisted failed jobs; inspect job/request IDs, stage, and publication certainty, then read job status |
| Rebuild failure-state persistence failure | `event = rebuild_failure_record_failed` | Inspect persistence and original error codes/stages, job/request IDs, and publication certainty; correlate redelivery/manual recovery |
| Rebuild operator pause | `event = rebuild_paused OR event = rebuild_checkpoint_damaged` | Inspect `error_code`, `stage`, `generation_id`, and `publication_status`; correct the cause before explicit resume; do not count an uncertain publication as failed |
| Rebuild management failure | `event = rebuild_request_failed` | Inspect `stage`, `error_code`, `request_id`, and `job_id` or `candidate_job_id`; do not count as failed jobs |
| Rebuild startup failure | `event = rebuild_alarm_failed` | Inspect generated request ID, available job ID, version, and stage; correlate bounded deliveries and manual recovery |
| Missing queue entry detected | `event = rebuild_queue_entry_missing` | Inspect missing job ID and invocation/request ID; use queue-repair stage outcomes to confirm removal |
| Completed queue entry detected | `event = rebuild_queue_entry_completed` | Inspect stale completed job ID and invocation/request ID; use queue-repair stage outcomes to confirm pruning without re-execution |
| Queue lookup | `event = operation_stage`, `queue_entry_id = "JOB_UUID"` | Follow individual lookup attempts, including failed reads before any effective head is confirmed |

As of October 18, 2026, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) retain logs for 3 days on Free and 7 days on Paid, subject to account limits; [Workers traces](https://developers.cloudflare.com/workers/observability/traces/) retain 7 days. Full application sampling does not override platform limits, truncation, or [tracing limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/). Cloudflare announces observability pricing changes for December 1, 2026; consult current account settings rather than treating these retention/cost details as permanent. There is no separate long-term diagnostic archive.

The stored telemetry REST API requires the `Workers Observability Write` permission, which an existing Wrangler OAuth login may lack even when deployment and live tail work. A `403` from that API does not establish missing telemetry: inspect the existing dashboard session's stored events and linked traces instead. Do not expand credential permissions just to run verification.

Successful HTML responses with validators, including HEAD and 304 responses, add `Cache-Control: no-transform` to preserve their ETags through the edge. [Cloudflare HTML transformation features can remove weak ETags](https://developers.cloudflare.com/cache/reference/etag-headers/), while `no-transform` also disables automatic edge compression. The Worker therefore explicitly requests runtime gzip compression when the visitor accepts it, using `cf.clientAcceptEncoding` before the normalized request header, and sets `Vary: Accept-Encoding`. Other clients receive uncompressed HTML with the same weak validator. RSS and image policies are unchanged.

If an edge smoke check cannot find the homepage ETag, compare the public response with `request_completed.response_etag` in the same version's logs. The smoke check requires public GET/HEAD validators, conditional 304 responses, and compressed HTML when run with `--verify-edge`; an origin-only validator does not pass. Keep these checks strict and fix the response policy rather than changing account security settings.

## Manual whole-batch cleanup

Use self-retraction below for a batch published by the current token less than 24 hours ago. Use this runbook for an operator-reviewed correction outside that scope; rollout does not remove any existing production content.

1. Record the affected post ID from the API reply or correlated logs. Read the current guarded repair snapshot and inspect its exact committed manifest; use the selected source's exact key, including legacy `digests/...` references.
2. Back up the source, index bytes and metadata, manifest, history index, RSS, and catalogue. Keep private backups outside active source and publication prefixes. Preserve original bytes and receipt timestamps.
3. Prepare an immutable source revision with `items: []`, preserving the batch's other fields. Prepare a copied manifest referencing that revision, a matching content-addressed history index for version 3, and RSS. Preserve batch records, original receipt windows, publication time, archive history, and legacy receipts. Never overwrite the selected source or an existing immutable artifact.
4. Install the reviewed pointers with `node scripts/maintenance.mjs repair production reviewed-repair.json` (or `preview`). This serializes the index replacement and follows regeneration. If a related paused head is reused, inspect its retained pause, explicitly resume it, and await completion. A stale version requires reviewing a fresh snapshot; unrelated fatal errors remain explicit failures.
5. Verify the removed batch's stories are absent, other stories remain, and the receipt window/publication timestamp remain unchanged. The cleared source no longer reserves its URLs unless another eligible batch contains them.

To undo cleanup, prepare a new reviewed manifest/history/RSS using the preserved source revision and install it through the same guarded repair workflow. Rebuilds retain the selected snapshot: sources that already left that snapshot require a deliberate new publication. Clearing an omitted source does not itself change visible content; inspect `omitted_posts` separately when diagnosing a missing story.

```sh
npx wrangler tail --env preview
npx wrangler tail --env=''
```

Use the Cloudflare dashboard to inspect Worker bindings, variables, secrets, logs, and private R2 objects. During rollout, verify preview smoke checks with `--verify-edge`, confirm the rebuild completed, verify correlated log and trace records, and inspect the homepage before deploying production. Verify production version headers with read-only API requests; do not create diagnostic production posts. Rolling back code does not roll back R2 content; preserve source objects and manifests. Do not run the previous upsert-based Worker against the migrated bucket.
