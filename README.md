# Lake Arrowhead . Town

A Cloudflare Worker publishes daily community digests and hosts uploaded images. The existing HTML design and four selectable themes are shared by the homepage and daily permalinks.

## Development

Requires Node.js 24 or newer and a Cloudflare account with Workers and R2 enabled.

```sh
npm ci
cp .dev.vars.example .dev.vars.preview
# Replace the example API_SECRET with a long random local credential.
npm run dev
```

Open http://localhost:8787. Local development uses emulated R2 and Durable Object storage under `.wrangler/`; it does not publish to the remote preview or production buckets. The initial homepage displays an empty state until a digest is posted.

```sh
npm run typecheck
npm test
npm run build
```

Tests use the Cloudflare Workers runtime with local R2 and a real publisher Durable Object. `build` bundles a production deployment without uploading it.

## Authentication and secrets

Both upload endpoints require `Authorization: Bearer <API_SECRET>`. Public HTML and image retrieval does not require authentication. No browser admin UI or browser CORS API is provided.

Generate and upload independent 32-byte random secrets:

```sh
npm run secret -- preview
npm run secret -- production
```

These commands also save the credentials in `.dev.vars.preview` and `.dev.vars`, respectively, with owner-only permissions. The files are ignored by Git. Rotation uses the same commands; previous local values are backed up in the ignored `.secrets/` directory. Update the posting client's environment variable after rotation. A missing secret or one shorter than 32 characters disables publishing with a `503` response.

For examples below, load the credential without printing it:

```sh
set -a
. ./.dev.vars.preview
set +a
SITE_URL=http://localhost:8787
```

## Publish a digest

```sh
curl --fail-with-body "$SITE_URL/api/digests" \
  -H "Authorization: Bearer $API_SECRET" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/digest.json
```

The JSON body contains `date`, `title`, `source`, and `items`. Each item contains `group`, `group_url`, `headline`, `body`, `post_url`, `category`, and `posted_at`. The example in `examples/digest.json` illustrates the contract.

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

## Public routes and errors

| Route | Behavior |
| --- | --- |
| `/`, `/index.html` | Pre-rendered weekly homepage |
| `/digests/YYYY-MM-DD` | Pre-rendered daily permalink |
| `/images/<sha256>.<extension>` | Public uploaded image |
| `/favicon.svg` | Site favicon |

Public routes support GET and HEAD; HTML and images support ETag revalidation. HTML requires revalidation and bypasses Cloudflare CDN caching so corrections are visible immediately. Source JSON, bucket listing, and arbitrary bucket paths are private. GET requests do not render Markdown or query the publisher's database.

Errors are JSON: `{"ok":false,"error":"Short explanation"}`. Statuses include `400` for invalid input, `401` for failed authentication, `404` for unknown public routes, `405` for unsupported methods, `413` for oversized requests, `415` for unsupported media types, and `500`/`503` for storage or configuration failures. Credentials and submitted content are not logged on errors.

## Deployment

The production Worker is `lakearrowheadtown`; preview is `lakearrowheadtown-preview`. Each has its own publisher namespace and R2 bucket. Production's `SITE_ORIGIN` is fixed to `https://lakearrowhead.town`; preview derives image/permalink origins from its request URL so it also works locally.

```sh
npx wrangler login
npx wrangler r2 bucket create lakearrowheadtown-content-preview
npx wrangler r2 bucket create lakearrowheadtown-content
npm run deploy:preview
npm run secret -- preview
node scripts/smoke-preview.mjs https://lakearrowheadtown-preview.harold-martin.workers.dev
```

Bucket creation is a one-time setup step. The smoke check publishes clearly labeled verification content to the isolated preview bucket, uploads an image, checks replacement and public retrieval, and never reads or writes production content.

Before deploying production on the domain:

1. Import the existing DNS records into the Cloudflare zone for `lakearrowhead.town`, preserving unrelated records and certificate-authority permissions.
2. Set the registrar's authoritative nameservers to the ones assigned by Cloudflare and wait for the zone to become active. If DNSSEC is enabled, follow Cloudflare's migration instructions for removing the old DS record before changing nameservers.
3. Deploy and provision the production secret:

```sh
npm run deploy
npm run secret -- production
```

`wrangler.jsonc` attaches the Worker to the domain and provisions the SQLite-backed publisher class. No cron schedule is configured. Keep the previous nameserver configuration available until DNS and HTTPS are verified. Roll back application code with Wrangler's version rollback while retaining the R2 buckets and publisher namespace; rendered content is retained separately from code deployments.
