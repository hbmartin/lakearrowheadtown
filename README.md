# Lake Arrowhead . Town

A Cloudflare Worker publishes daily community digests and hosts uploaded images. The existing HTML design and four selectable themes are shared by the homepage and daily permalinks.

Digest publishing works like this:

```text
POST /api/digests → authenticate and validate → serialized publisher → R2 JSON + HTML
POST /api/images  → authenticate and validate → R2 image → public image URL
GET  /           → read the published homepage from R2
```

Posting a digest rebuilds the homepage immediately. Publishing content does not require a Git commit, code deployment, or CI run.

[Cloudflare setup](#set-up-cloudflare) · [Local development](#development) · [Authentication](#authentication-and-secrets) · [Publish a digest](#publish-a-digest) · [Upload an image](#upload-an-image) · [Operations](#operations-and-troubleshooting)

## Set up Cloudflare

### 1. Install the tools and sign in

You need Node.js 24 or newer, npm, a Cloudflare account with Workers and R2 enabled, and access to the domain's DNS and registrar settings. Enable R2 in the Cloudflare dashboard if you have not used it before.

Run these commands from the repository root:

```sh
npm ci
npx wrangler login
npx wrangler whoami
```

Confirm that Wrangler is signed into the account that will own the Worker, R2 buckets, and domain. If you use several accounts, select one explicitly:

```sh
export CLOUDFLARE_ACCOUNT_ID=your-cloudflare-account-id
```

The project uses the Wrangler version installed by `npm ci`.

### 2. Review the configuration

[`wrangler.jsonc`](wrangler.jsonc) defines both deployments. Production uses the top-level configuration; preview uses `env.preview`.

| Setting | Production | Preview |
| --- | --- | --- |
| Worker name | `lakearrowheadtown` | `lakearrowheadtown-preview` |
| R2 bucket | `lakearrowheadtown-content` | `lakearrowheadtown-content-preview` |
| R2 binding | `SITE_BUCKET` | `SITE_BUCKET` |
| Durable Object binding | `PUBLISHER` | `PUBLISHER` |
| Durable Object class | `DigestPublisher` | `DigestPublisher` |
| `SITE_ORIGIN` variable | `https://lakearrowhead.town` | Empty; uses the request origin |
| Publishing secret | `API_SECRET` | Separate `API_SECRET` |
| Custom domain | `lakearrowhead.town` | None |

Wrangler provisions the SQLite-backed Durable Object class and separate namespaces during deployment. You do not need to create a database or publisher object manually. The secret is configured separately from the checked-in variables.

For another domain or account, update the Worker names, bucket names, production route, and production `SITE_ORIGIN` before deploying. `SITE_ORIGIN` must contain only the scheme and hostname, with an optional port and no additional path. It determines the absolute URLs returned by uploads and the canonical URLs embedded in rendered pages.

Keep both R2 buckets private: leave their public development URLs disabled and do not attach an R2 custom domain. The Worker exposes the public image and HTML routes through its R2 binding. No S3 credentials are needed. See [using R2 from Workers](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/).

### 3. Create the R2 buckets

Run these commands once, skipping buckets that already exist:

```sh
npx wrangler r2 bucket create lakearrowheadtown-content-preview
npx wrangler r2 bucket create lakearrowheadtown-content
```

Use separate buckets for preview and production so verification posts and uploads do not appear on the live site.

### 4. Deploy and verify preview

```sh
npm run deploy:preview
npm run secret -- preview
```

The first command uploads the Worker and configures its bindings. The second generates and uploads a random publishing secret, saving a local copy in `.dev.vars.preview`. On an existing installation, reuse the existing secret unless you intend to rotate it.

Wrangler prints the deployed `workers.dev` URL. This project's preview is [lakearrowheadtown-preview.harold-martin.workers.dev](https://lakearrowheadtown-preview.harold-martin.workers.dev).

Run the live smoke check:

```sh
node scripts/smoke-preview.mjs https://lakearrowheadtown-preview.harold-martin.workers.dev
```

The check uploads an image, creates and replaces two clearly labeled verification digests, and checks public retrieval, authentication, and ETag revalidation. It leaves that content in the preview bucket. The script accepts this project's exact preview hostname or `http://localhost:<port>`; if you change the deployed preview hostname, update its allowlist in [`scripts/smoke-preview.mjs`](scripts/smoke-preview.mjs).

### 5. Connect the production domain

In the Cloudflare dashboard, add `lakearrowhead.town` as a domain in the same account as the Worker. Review the imported DNS records and copy any missing records, including records used for email, subdomains, and certificate-authority permissions.

For a domain currently hosted elsewhere:

1. Check whether DNSSEC is enabled at the current provider. Follow [Cloudflare's DNSSEC migration instructions](https://developers.cloudflare.com/dns/dnssec/) before changing nameservers if an old DS record is present.
2. At the registrar, replace the current authoritative nameservers with the exact pair Cloudflare assigns to this zone. Domain registration can remain with the existing registrar.
3. Wait for Cloudflare's domain overview to report the zone as **Active**. During propagation, some visitors may still reach the previous host.
4. Remove any conflicting DNS record at the exact hostname being assigned to the Worker. Preserve unrelated records.

The checked-in `routes` entry uses `custom_domain: true`, so deploying the Worker attaches it to `lakearrowhead.town`. Cloudflare manages the domain's Worker DNS record and HTTPS certificate. This requires an active zone in the same account; see [Worker custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

### 6. Deploy production and configure its secret

```sh
npm run deploy
npm run secret -- production
```

Production is the top-level Wrangler environment. Do not use `--env production`; there is no named environment with that name in the configuration. The package scripts select the correct environment automatically.

The production secret is saved in `.dev.vars`. Supply its `API_SECRET` value to the server or job that will post digests and images. Keep the preview and production credentials separate. Both POST endpoints return `503` until a valid secret is configured.

Check the site and confirm that an unauthenticated upload is rejected:

```sh
curl --fail-with-body -I https://lakearrowhead.town/
curl -i -X POST https://lakearrowhead.town/api/digests
```

Expect `200` for the homepage and `401` for the POST. Before the first digest, the homepage displays an empty state. Production also has a `workers.dev` hostname printed by Wrangler, but its image URLs and canonical links still use the configured production `SITE_ORIGIN`.

## Development

Local development does not require remote buckets or a deployed Worker. Install dependencies and create a local credential file if one does not already exist:

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

Open http://localhost:8787. Local development uses emulated R2 and Durable Object storage under `.wrangler/`; it does not publish to the remote preview or production buckets. Generating the file above does not upload or rotate a remote secret. `.dev.vars.example` also documents the required variable.

```sh
npm run typecheck
npm test
npm run build
```

Tests use the Cloudflare Workers runtime with local R2 and a real publisher Durable Object. `build` bundles a production deployment without uploading it.

To exercise the local endpoints using the generated credential:

```sh
node scripts/smoke-preview.mjs http://localhost:8787
```

## Authentication and secrets

Both upload endpoints require `Authorization: Bearer <API_SECRET>`. Public HTML and image retrieval does not require authentication. No browser admin UI or browser CORS API is provided.

Generate a secret during initial setup or rotate one deliberately:

```sh
npm run secret -- preview
npm run secret -- production
```

Each command generates 32 random bytes encoded as 64 hexadecimal characters, uploads the value using Wrangler secrets, and saves it in `.dev.vars.preview` or `.dev.vars` with owner-only permissions. The files are ignored by Git. Previous local values are backed up in the ignored `.secrets/` directory. Update the posting client's environment variable after rotation; the previous token stops authenticating once the remote update takes effect. A missing secret or one shorter than 32 characters disables publishing with a `503` response.

For production requests below, load the production credential without printing it:

```sh
. ./.dev.vars
export API_SECRET
export SITE_URL=https://lakearrowhead.town
```

For the remote preview, source `.dev.vars.preview` instead and set `SITE_URL` to the preview URL. For local development, use that same local file and `SITE_URL=http://localhost:8787`. The credentials must match the target environment. In an automated posting job, set `API_SECRET` in that job's secret store and `SITE_URL` in its environment.

If a secret upload fails after saving the generated value locally, retry that same saved value with Wrangler rather than generating another one:

```sh
# Preview: source .dev.vars.preview, then use --env preview instead.
. ./.dev.vars
printf '%s' "$API_SECRET" | npx wrangler secret put API_SECRET --env=''
```

See [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) for manual secret management. Do not put the token in `wrangler.jsonc` or client-side code.

## Publish a digest

Prepare a JSON file using [`examples/digest.json`](examples/digest.json). Change its date, title, timestamps, and items to the content you intend to publish. The request shape is:

```json
{
  "date": "2026-10-16",
  "title": "Morning Facebook digest — Fri Oct 16",
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

Publish the file with the matching environment's credential:

```sh
curl --fail-with-body "$SITE_URL/api/digests" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/digest.json
```

All shown fields are required. `title`, `source`, `group`, and `headline` must be nonempty strings; `body` and `category` may be empty strings. `items` may be an empty array.

- `date` is a real `YYYY-MM-DD` calendar date. It identifies the digest; reposting the date replaces the complete previous digest, including its items.
- `body` is Markdown. Raw HTML is escaped, and unsafe Markdown link protocols are blocked. Markdown images can reference URLs returned by the image endpoint.
- `posted_at` must be an ISO timestamp including `Z` or an explicit offset. The timestamp may be outside the digest day. Items retain submitted order; displayed timestamps use `America/Los_Angeles`.
- `category` accepts any string, including an empty string. Categories do not control rendering or validation beyond their type. `items: []` publishes an empty daily digest.
- `group_url` and `post_url` must be absolute HTTP(S) URLs without embedded credentials.
- The request body is limited to 1 MiB, including for streamed requests without a Content-Length header.

Successful creates and corrections both return:

```json
{"ok":true,"url":"/digests/2026-10-16"}
```

The response is sent after the source JSON, daily HTML, and homepage HTML have been written. Publishing is serialized through a single internal Durable Object to prevent overlapping homepage rebuilds. R2 does not support a transaction across these objects: a failed publish can leave partial writes and returns `500`. Reposting the same date safely repairs the pages.

The homepage contains today and the preceding six dates in Los Angeles, newest date first, omitting missing dates. Its window is computed when a digest is posted and remains unchanged between posts. Backdated and future digests always have daily permalinks but appear on the homepage only when their date is in that window. Daily pages and images are retained indefinitely.

To correct a digest, send the entire replacement payload with the same `date`. This is an upsert, not a partial update: omitted previous items are removed. Dates are the only identity key; changing `source` or `title` does not create a second digest for that day. No listing, pagination, deletion, or standalone Markdown endpoint is implemented.

## Upload an image

```sh
curl --fail-with-body "$SITE_URL/api/images" \
  -H "Authorization: Bearer $API_SECRET" \
  -F 'file=@photo.jpg;type=image/jpeg'
```

Supply exactly one multipart field named `file`. JPEG, PNG, WebP, and GIF files are accepted up to 10 MiB. The declared media type must match the file signature. SVG is not supported. Validation checks signatures, not full image decoding or image re-encoding.

```json
{"ok":true,"url":"https://lakearrowhead.town/images/<sha256>.jpg"}
```

Identical bytes return the same URL. Images are immutable and cached for a year. Reference them in a digest body with `![Description](https://lakearrowhead.town/images/<sha256>.jpg)`.

The normal workflow is to upload images first, put the returned URLs into item Markdown, then publish the digest. Let curl generate the multipart boundary; do not manually set the request's `Content-Type` header when using `-F`.

## Public routes and errors

| Route | Behavior |
| --- | --- |
| `/`, `/index.html` | Pre-rendered weekly homepage |
| `/digests/YYYY-MM-DD` | Pre-rendered daily permalink |
| `/images/<sha256>.<extension>` | Public uploaded image |
| `/favicon.svg` | Site favicon |

Public routes support GET and HEAD; HTML and images support ETag revalidation. HTML requires revalidation and bypasses Cloudflare CDN caching so corrections are visible immediately. Source JSON, bucket listing, and arbitrary bucket paths are private. GET requests do not render Markdown or query the publisher's database.

Errors are JSON: `{"ok":false,"error":"Short explanation"}`. Statuses include `400` for invalid input, `401` for failed authentication, `404` for unknown public routes, `405` for unsupported methods, `413` for oversized requests, `415` for unsupported media types, and `500`/`503` for storage or configuration failures. Credentials and submitted content are not logged on errors.

## Operations and troubleshooting

### Deploy code changes

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run deploy:preview
node scripts/smoke-preview.mjs https://lakearrowheadtown-preview.harold-martin.workers.dev
npm run deploy
```

Normal code deployments reuse the existing buckets, publisher namespaces, and secrets. Run secret generation only when provisioning or rotating credentials. No cron schedule is configured.

Rendered pages are stored independently from the Worker bundle. After a template or styling change, the next digest publish rebuilds the homepage with the new template. Repost a retained digest's complete payload to refresh that daily permalink as well. Redeploying code alone does not regenerate existing R2 HTML.

### Inspect resources and logs

In the Cloudflare dashboard, use **Workers & Pages** to inspect each Worker, its bindings, variables, secrets, custom domain, and logs. Use **R2 Object Storage** to inspect the corresponding bucket. The stored keys are:

| R2 key | Contents |
| --- | --- |
| `digests/YYYY-MM-DD.json` | Private source payload used for rebuilds |
| `pages/digests/YYYY-MM-DD.html` | Rendered daily permalink |
| `pages/index.html` | Rendered weekly homepage |
| `images/<sha256>.<extension>` | Uploaded image |

Live logs are also available from the CLI:

```sh
npx wrangler tail --env preview
# Or production:
npx wrangler tail --env=''
```

### Resolve common problems

| Symptom | Check |
| --- | --- |
| Domain still reaches the previous host | Registrar nameservers, Cloudflare zone activation, DNS propagation, and the Worker's custom-domain assignment. |
| `401 Unauthorized` | Use the exact `Bearer` header and the secret for the target environment. If a key was rotated, update the posting job. |
| `503 Publishing secret is not configured` | Upload `API_SECRET` to the correct Worker; it must be at least 32 characters. Allow the secret update to propagate. |
| `503 Site origin is not configured correctly` | Set `SITE_ORIGIN` to an HTTP(S) origin without a path, credentials, query string, or fragment. |
| `400` on a digest | Check the JSON error message, required fields, real date, absolute source URLs, and timezone-bearing timestamps. |
| `413` on an upload | Keep digest JSON within 1 MiB and each image within 10 MiB. |
| `415` on an image | Use multipart `file`, a supported image format, and the matching file media type. |
| Daily page exists but the digest is absent from the homepage | Its `date` must be today or one of the preceding six dates in Los Angeles when the latest publish occurred. The example date must be updated for current posts. |
| Homepage still shows last week's content | The window advances only when another digest is posted. No background refresh runs. |
| `500` after publishing | Inspect Worker logs and the `SITE_BUCKET`/`PUBLISHER` bindings, then retry the same complete payload. A retry repairs partial writes. |

Keep the buckets and publisher namespace when rolling back Worker code. Code rollback does not restore previous digest contents; restore content by reposting the desired payload for its date. There is no automatic content deletion or retention cleanup.
