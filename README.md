# Lake Arrowhead . Town

A Cloudflare Worker publishes an append-only community news feed and hosts uploaded images. The homepage preserves the existing design and four selectable themes.

```text
POST /api/digests → authenticate and validate → serialized publisher → R2 post + manifest + index
POST /api/images  → authenticate and validate → R2 image → public image URL
POST /api/rebuild → durable background job → migrate legacy sources → rebuild the same snapshot
GET  /           → read published HTML from R2
```

New posts rebuild the homepage without a Git commit, deployment, or CI run. Every submission creates a new post, including duplicate requests. Corrections are follow-up posts.

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

### 2. Create buckets

Run once, skipping resources that already exist:

```sh
npx wrangler r2 bucket create lakearrowheadtown-content-preview
npx wrangler r2 bucket create lakearrowheadtown-content
```

### 3. Bootstrap preview

The normal deployment script expects an existing local and remote publishing credential. For the first installation, deploy the code directly, then provision the secret:

```sh
npx wrangler deploy --env preview
npm run secret -- preview
npm run deploy:preview
```

The final command deploys the code and durably queues the first rebuild. It prints a job ID and a status command, then exits without waiting for the rebuild to finish.

```sh
npm run rebuild:status -- preview JOB_UUID
node scripts/smoke-preview.mjs https://lakearrowheadtown-preview.harold-martin.workers.dev --verify-edge
```

The smoke check uploads an image, appends three labeled posts (including a duplicate and a follow-up), checks public routes and ETags, and queues a rebuild. `--verify-edge` additionally requires real Cloudflare compression and an image cache hit. It leaves all test data in the preview bucket. The script accepts only the configured preview hostname or `http://localhost:<port>`.

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

## Local development and verification

Create a local preview credential without changing any remote secret:

```sh
npm ci
node --input-type=module <<'JS'
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync('.dev.vars.preview')) {
  writeFileSync('.dev.vars.preview', `API_SECRET=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
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

Migration backs up `.dev.vars`, preserves other variables, and refuses to overwrite a different production credential.

For production curl examples:

```sh
. ./.secrets/production.vars
export API_SECRET
export SITE_URL=https://lakearrowhead.town
```

For preview, source `.dev.vars.preview` and use the preview URL. For local testing, source the same file and set `SITE_URL=http://localhost:8787`. An automated publisher should get its token from its own secret store.

If a secret upload fails, upload the same saved value rather than generating another:

```sh
. ./.secrets/production.vars
printf '%s' "$API_SECRET" | npx wrangler secret put API_SECRET --env=''
# Preview: source .dev.vars.preview and use --env preview.
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
curl --fail-with-body "$SITE_URL/api/digests" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/digest.json
```

Successful publication returns `200 {"ok":true,"url":"/"}` after the source, manifest, and index writes complete.

- Every request appends a post. There is no upsert, editing API, deletion API, or idempotency key. A rerun can create duplicates; publish a follow-up to correct a previous post.
- The server assigns a unique ID, receipt timestamp, and Los Angeles date inside the serialized publisher. Any top-level `date`, `id`, or `received_at` sent by the client is ignored. Item `posted_at` values retain their original meaning and display in Los Angeles time.
- `title`, `source`, `group`, and `headline` are required nonempty strings. `body` and `category` may be empty; `items: []` creates an empty post. Categories accept arbitrary strings; items retain submitted order.
- Item timestamps require real calendar dates and an explicit timezone (`Z` or an offset). Source links must be absolute HTTP(S) URLs without credentials.
- Markdown is rendered with raw HTML disabled and unsafe link protocols blocked. Plain-text fields are escaped. JSON requests are limited to 1 MiB, including streamed requests.

A publish selects every published post received today and during the preceding six Los Angeles dates, newest receipt first. The homepage labels its date range and last publication time. It stays unchanged between posts, even when its covered week is old. There is no scheduled refresh. Template rebuilds retain the exact published selection and timestamp.

R2 has no transaction spanning these objects. Index replacement is the commit point, and a failure can leave private source or manifest objects. After a timeout or `500`, check the homepage before posting again: publication may have completed, and another POST can create a duplicate.

## Upload images

```sh
curl --fail-with-body "$SITE_URL/api/images" \
  -H "Authorization: Bearer $API_SECRET" \
  -F 'file=@photo.jpg;type=image/jpeg'
```

Use exactly one multipart `file`. JPEG (`image/jpeg`), PNG, WebP, and GIF files up to 10 MiB are supported. The canonical media type must match the signature; aliases, generic/missing types, SVG, and contradictory types receive `415`. Signatures are checked without full image decoding or re-encoding. Let curl generate the multipart boundary.

The response is `200 {"ok":true,"url":"https://lakearrowhead.town/images/<sha256>.jpg"}`. Identical bytes return the same URL. Images have one-year immutable browser and Cloudflare Workers cache policies; an edge cache miss reads R2. See [Workers Caching configuration](https://developers.cloudflare.com/workers/cache/configuration/).

Upload images first, include their returned URLs as `![Description](https://lakearrowhead.town/images/<hash>.jpg)` in Markdown, then publish. Two image uploads may process concurrently per isolate; excess requests return `503` with `Retry-After: 1` before their bodies are processed.

## Rebuilds, migration, and operations

Normal code deployments queue background rebuilds automatically:

```sh
npm run deploy:preview
npm run deploy
```

These commands require matching local credentials and do not rotate secrets. They report success after code deployment and durable job creation, not after rendering. A failure to enqueue is a command failure even if code deployment already succeeded. Fix the credential/connection issue and use `rebuild` to queue work without redeploying. If `SITE_URL` was set for local testing, unset it before deployment; deployment scripts reject localhost rebuild targets.

```sh
npm run rebuild -- preview
npm run rebuild:status -- preview JOB_UUID
npm run rebuild:resume -- preview JOB_UUID
# Use production instead of preview for the live site.
```

Status includes the job ID, phase, migration count, timestamps, and queued/running/completed/failed state. Check it manually. Application failures pause at the first error and retain the current HTML until a successful replacement. Resume after repairing the cause. Later queued jobs report `blocked_by` when a failed earlier job blocks them. There are no external alerts or automatic application retries.

Jobs use persistent Durable Object state and one-shot alarms, surviving object eviction. Migration and rendering share the publishing queue. The initial job imports old `digests/YYYY-MM-DD.json` files in checkpointed batches of 25, using their R2 upload times as receipt times. Stable legacy IDs and conditional writes prevent duplicate imports after interruption. Existing sources and old daily HTML remain private backups. Normal publishing merges legacy/imported identities during migration.

For the initial snapshot, the old stored index's upload time supplies the publication time and date-window anchor. If there is no index, the latest legacy receipt time is used. Later rebuilds use the published manifest so they cannot advance the date window or introduce uncommitted source posts.

| R2 key | Contents |
| --- | --- |
| `posts/YYYY-MM-DD/<id>.json` | Private server-dated source posts |
| `publications/<uuid>.json` | Immutable private snapshot manifests |
| `pages/index.html` | Public rendered index; metadata references its manifest |
| `images/<sha256>.<extension>` | Immutable uploaded images |
| `digests/*.json`, `pages/digests/*.html` | Retained private legacy backups |

Only `/`, `/index.html`, `/images/<hash>.<extension>`, and `/favicon.svg` are public. Old daily routes return `404`. Sources, manifests, bucket listings, and config files are never exposed. There is no archive listing or public administration UI.

HTML supports HEAD and weak ETag revalidation, requires revalidation, permits compression, and bypasses edge caching. Image GETs use Workers Caching. Protected APIs always return `no-store` JSON. Error statuses include `400`, `401`, `404`, `405`, `409` for invalid job resume, `413`, `415`, and `500`/`503`. Logs omit credentials and payloads.

```sh
npx wrangler tail --env preview
npx wrangler tail --env=''
```

Use the Cloudflare dashboard to inspect Worker bindings, variables, secrets, logs, and private R2 objects. During rollout, verify preview smoke checks with `--verify-edge`, confirm the rebuild completed, and inspect all four themes before deploying production. Rolling back code does not roll back R2 content; preserve source objects and manifests. Do not run the previous upsert-based Worker against the migrated bucket.
