# Lake Arrowhead . Town

A Cloudflare Worker publishes an append-only community news feed and hosts uploaded images. The homepage preserves the existing design and four selectable themes.

```text
POST /api/digests → authenticate and validate → serialized publisher → R2 post + manifest + index
POST /api/images  → authenticate and validate → R2 image → public image URL
POST /api/rebuild → durable background job → migrate legacy sources → rebuild the same snapshot
GET  /           → read published HTML from R2
```

New posts rebuild the homepage without a Git commit, deployment, or CI run. New story URLs append to the feed. Repeated source URLs within the seven-day receipt window are skipped; changed wording at the same URL is also skipped.

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

The smoke check uploads an image, submits three labeled batches (a new story, a duplicate no-op, and a distinct follow-up) and rejects an empty batch, checks public routes and ETags, and queues a rebuild. It also parses `/rss.xml`, verifies full text/images and discovery links, checks HEAD, and confirms duplicate-only submissions preserve the RSS ETag. `--verify-edge` additionally requires real Cloudflare compression and an image cache hit. It leaves all test data in the preview bucket. The optional URL defaults to the configured preview hostname; an explicit URL may come before or after the flag. Only that hostname or `http://localhost:<port>` is accepted. Unknown flags and extra URLs fail before credentials are read or requests are sent.

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

Each push to `main`, including a merged pull request, runs validation and then deploys production. Failed validation stops deployment. The deploy command queues a durable homepage rebuild using production content and prints its job ID. Check that job as described below; a successful build means the rebuild was queued, not that it has finished. Preview remains available through `npm run deploy:preview`, with its own Worker and storage.

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
- Existing stories received today or during the preceding six Los Angeles calendar dates suppress new copies. Receipt dates, not `posted_at`, govern this window; retries never refresh it. Hidden items also count: correcting an out-of-window `posted_at` at the same URL remains a duplicate. Within a request the first new occurrence wins. Historical duplicate copies remain visible. The earliest receipt supplies duplicate references, with ascending post ID and item position breaking ties.
- Publishing and duplicate detection share the serialized queue. The committed manifest governs modern source membership, including eligible repaired `omitted_posts`; orphan source objects do not suppress retries. Eligible legacy sources also participate during migration. A repaired or legacy historical copy wins over an incoming copy. If the request is entirely duplicate, it still makes no writes: its returned historical identity may remain omitted from the homepage until a later publication containing new content.
- There is no editing, deletion, listing, preflight, individual-post page, or idempotency-key endpoint. `url` always points to `/`; post IDs are private diagnostic identifiers, not public permalinks. See the manual cleanup runbook below for corrections at the same source URL.
- Omit top-level `date`, `id`, and `received_at`: none is required, and submitted values are ignored. The server assigns a unique ID, UTC ISO `received_at`, and `YYYY-MM-DD` date in `America/Los_Angeles` inside the serialized publisher. For example, receipt at `2026-10-19T01:00:00Z` gives date `2026-10-18`. Item `posted_at` remains the original source timestamp, not the receipt timestamp. Deduplication follows seven Los Angeles calendar dates, including DST boundaries, rather than a rolling 168 hours.
- `title`, `source`, `group`, and `headline` are required nonempty strings. `body` and `category` may be empty; submitted `items: []` receives a `400` validation error before writes. Historical empty sources remain readable. Categories accept arbitrary strings. Digest titles and receipt times remain private; the homepage displays item headlines.
- Item timestamps require real calendar dates and an explicit timezone (`Z` or an offset). Source links must be absolute HTTP(S) URLs without credentials.
- Markdown is rendered with raw HTML disabled and unsafe link protocols blocked. Plain-text fields are escaped. JSON requests are limited to 1 MiB, including streamed requests.

A publish retains sources received today and during the preceding six Los Angeles dates. The homepage combines their items into one feed, showing only items whose original `posted_at` falls within those same seven calendar dates in Los Angeles. Items appear newest first under one heading per populated day; equal timestamps preserve source and submitted item order, and preexisting historical duplicate copies remain visible. Older and future-day items and empty digests create no sections. Source timestamps describe already-published material; this feed does not schedule future posts.

The footer labels the post-date range and last publication time. Feed contents and calendar datelines stay unchanged between publications, even when the covered week is old. There is no scheduled feed refresh. In the browser, post timestamps display relative ages such as “3 hr ago” or “2 days ago”; they update each minute while the page is visible and when returning to the page. Timestamps ahead of the reader’s clock retain future labels such as “in 3 min”. Each age is rendered once for reading and copying, including double-click and drag selection. Full Los Angeles timestamps use native browser tooltips, which screen readers may announce alongside the age; original `datetime` values stay intact. Without JavaScript, absolute timestamps display once. Daily headings and footer dates stay absolute. Template rebuilds retain the exact published selection, date window, and publication timestamp, while applying the current layout.

The masthead reads “Lake Arrowhead . Town” with a centered accent dot; the browser page title remains “News from Lake Arrowhead . Town”. Its type uses `clamp(1.5rem, 6.3vw, 3.5rem)` and can wrap on narrow screens. The palette icon shares the masthead row inside a 44px circle with a solid theme-surface background and a control-colour border. It has no button shadow and scrolls with the header. It opens a five-theme picker and remembers the selected theme in a cookie. Arrow keys apply and save themes while keeping the picker open; clicking a theme or pressing Space/Enter selects it, closes the picker, and returns focus to the button. Escape keeps the selected theme and closes; Tab continues normal navigation, and outside clicks or leaving the window dismiss the panel. An open panel stays attached to the masthead when it scrolls away; resizing fits it to the viewport without moving the page. Night Sky adds a navy dark theme with pale text and static stars; it is selected manually, and device dark-mode preference does not change the default Deep Lake & Lodge theme. Themes use subtle woodgrain, dock boards, mist contours, paper, and star textures that follow the document, strongest at the masthead and page edges. Background colour washes retain their existing strength.

At widths up to 600px, 16px side gutters, compact header/article spacing, quiet 13px daily headings, and 20–22px story headlines bring the first story higher on the page. Group links are hidden on mobile while post times and categories remain visible. Body text stays 16px with a 1.6 line height, and full stories, images, captions, and links remain available without expansion. Desktop retains group links. Daily headings have no redundant rule below them. Headline links fill their heading’s width, underline on hover, and show a rectangular outline without an underline on keyboard focus, including when hovered. Body-only thumbnails and footer placement remain in use.

If a historical source is missing, contains malformed JSON, or fails digest validation, a new publication omits that post and logs its ID, R2 key, and a fixed reason. Its reference is retained privately as `omitted_posts` in the manifest and reconsidered on later publications until its original receipt date leaves the seven-day window. Successful responses retain the same format. Storage outages and unexpected failures still fail publication instead of omitting content.

R2 has no transaction spanning these objects. Index replacement is the commit point, and a failure can leave private source or manifest objects. After a timeout or a response with `retryable: true`, retry the unchanged payload within its original seven-calendar-date receipt window. If the index committed, the repeated URLs resolve to their committed identities; otherwise the retry can publish them. Non-retryable rendering, configuration, or internal failures require repair first. After that window, check the saved response, logs, and publication before retrying because suppression has expired.

The Worker uses the versioned `publishV2` Durable Object RPC. During deployment skew, an unavailable method, failed RPC, or invalid reply returns `503 service_unavailable` with `publication_status: "unknown"`; it never falls back to another publish call. The legacy `publish` method retains throw-on-failure behavior for old Workers and the successful reply shape understood by the previous preview Worker.

This intentionally corrects the earlier `500 publish_failed` response for digest publishing RPC failures while retaining `X-API-Version: 2`. All publishing clients are controlled; coordinate their updates before the next production rollout. Clients must handle unfamiliar error codes with a readable fallback and use `retryable` and `publication_status` for retry decisions rather than matching only `publish_failed`. A missing or unusable publisher binding instead returns `503 configuration_error`, `retryable: false`, and `publication_status: "not_attempted"`: publication was never invoked and the configuration needs operator repair. No API-version negotiation or alternate publishing call is provided.

## Search, sharing, and browser metadata

[`src/site.ts`](src/site.ts) holds the shared name, description, production origin, colors, and versioned artwork paths. Empty pages, publications, and template rebuilds all render the same complete metadata through [`src/metadata.ts`](src/metadata.ts): canonical URL, application name, robots, Open Graph, Twitter large-image cards, favicon/touch-icon links, and the web manifest. The theme picker continues to update the browser's theme color.

The description and 1200 × 630 share card describe the site consistently, regardless of current headlines. JSON-LD connects the `WebSite`, homepage `CollectionPage`, and an ordered `ItemList` of exactly the visible headlines and original source URLs, including visible duplicates. It does not expose digest titles, stored post IDs, or storage references. `dateModified` uses the saved publication time and is absent before first publication.

Only `https://lakearrowhead.town` is indexable. Preview, localhost, alternate production hostnames, and invalid-origin configurations receive `X-Robots-Tag: noindex`, including HEAD and 304 responses. An invalid `SITE_ORIGIN` still permits stored homepage HTML and RSS, uploaded images, bundled artwork/icons, and the manifest to load; robots rules omit sitemap advertising and the sitemap returns 404. Publishing and rendering an empty fallback homepage or RSS feed still require a valid origin and return 503 when it is invalid. Preview HTML also carries a `noindex` meta tag. Production HTML served from an alternate hostname retains the production canonical URL; its response header enforces `noindex` on that hostname. Crawling remains allowed so search engines can read the directive.

| Public resource | Behavior |
| --- | --- |
| `/rss.xml` | Full-content RSS 2.0 feed matching the homepage's saved seven-day selection and ordering. Includes images, categories, source links, and stable opaque GUIDs. |
| `/robots.txt` | Allows public content, disallows `/api/`, and advertises the sitemap only on the production origin. |
| `/sitemap.xml` | Production only; lists the canonical homepage. `lastmod` comes from the manifest referenced by the committed index, never the current clock or a rebuild's R2 upload time. Missing/malformed metadata omits the date; storage outages return an error. |
| `/site.webmanifest` | English browser-mode manifest with relative root URLs, theme colors, and 192/512px icons. |
| `/favicon.svg`, `/favicon.ico` | SVG mark and conventional ICO fallback; cached for one day. |
| `/assets/social-card-v1.png` | 1200 × 630 branded share image. |
| `/assets/favicon-v1.ico`, `/assets/favicon-48-v1.png` | ICO with 16/32/48px frames and 48px PNG favicon. |
| `/assets/apple-touch-icon-v1.png` | 180px Apple touch icon. |
| `/assets/icon-192-v1.png`, `/assets/icon-512-v1.png` | Square manifest icons. |

These routes support GET, HEAD, and ETag revalidation. Versioned artwork has one-year immutable caching. Robots and manifest responses are cached for one hour; the sitemap and RSS revalidate like the homepage and bypass CDN caching. Artwork is bundled with the Worker and needs no upload to R2. Source artwork and fonts are not public routes.

Subscribe at `https://lakearrowhead.town/rss.xml` or use the footer's **RSS feed** link. Pages also advertise one absolute RSS autodiscovery link. Each RSS description includes the complete safe Markdown-rendered story, its images, and linked group/original-post attribution. Relative body links and images resolve against the publication's site origin. XML-invalid characters become replacement characters; raw HTML and unsafe Markdown link protocols remain disabled. RSS dates use GMT: item `pubDate` comes from `posted_at`, and `lastBuildDate` comes from the saved publication time. Before first publication, RSS is a valid empty channel without `lastBuildDate`.

RSS and HTML share the exact saved seven-day selection, including equal-time ordering and historical duplicate copies. Each stored item has a stable opaque GUID derived from its private post identity and original item position; rebuilds and new publications retain existing GUIDs. RSS is rendered into a private immutable R2 object before the homepage commit stores its reference alongside the manifest reference. A failed feed write or uncommitted homepage replacement cannot expose a newer RSS snapshot. Duplicate-only submissions make no writes. Later source damage does not alter materialized RSS; omission on a new publication follows the same rules as HTML. Private RSS object keys and source IDs are never public routes or feed fields.

Regenerate artwork locally with Node.js 24+ after installing dependencies:

```sh
npm run artwork
```

The generator uses the existing tree path from `favicon.svg`, editable SVG templates in `assets/source/`, and bundled Instrument Serif / DM Sans fonts with their SIL Open Font Licenses. It does not require network access or installed system fonts. The share card uses the site's default cream and forest-green palette. Commit generated PNG/ICO files along with source changes. When replacing released artwork bytes, bump the versioned filenames in the site constants and Worker imports so immutable caches remain correct.

Code deployment alone does not update an existing R2 homepage. Use the normal `deploy:preview` or `deploy` command, which queues a rebuild, and check its job until completed. Until that rebuild or a new publication commits, pre-RSS homepages have no feed reference and `/rss.xml` returns 503 with `Retry-After: 60`; discovery links also appear only after the homepage is rebuilt. A missing referenced RSS object returns the same 503 and requires a rebuild to restore it. Storage outages remain errors rather than producing a false empty feed. Then check the rendered homepage and RSS subscription/discovery links, `/rss.xml`, `/robots.txt`, `/sitemap.xml` on production, the manifest, and its linked images. Rebuilds apply metadata changes while retaining the saved feed selection and publication timestamp. Search engines and social platforms may take time to refresh their own cached previews.

## Upload images

```sh
[ -n "${API_SECRET:-}" ] && curl --fail-with-body "$SITE_URL/api/images" \
  -H "Authorization: Bearer $API_SECRET" \
  -F 'file=@photo.jpg;type=image/jpeg'
```

Use exactly one multipart `file`. JPEG (`image/jpeg`), PNG, WebP, and GIF files up to 10 MiB are supported. The canonical media type must match the signature; aliases, generic/missing types, SVG, and contradictory types receive `415`. Signatures are checked without full image decoding or re-encoding. Let curl generate the multipart boundary.

The response is `200 {"ok":true,"url":"https://lakearrowhead.town/images/<sha256>.jpg"}`. Identical bytes return the same URL. Images have one-year immutable browser and Cloudflare Workers cache policies; an edge cache miss reads R2. See [Workers Caching configuration](https://developers.cloudflare.com/workers/cache/configuration/).

Upload images first, include their returned URLs as `![Description](https://lakearrowhead.town/images/<hash>.jpg)` in Markdown, then publish. Two image uploads may process concurrently per isolate; excess requests return `503` with `Retry-After: 1` before their bodies are processed.

The first Markdown image appears at the upper left of the article body, with text wrapping beside and below it. Thumbnails fit within 160 × 160 px, or 96 × 96 px on screens up to 600 px wide, preserving the full image without cropping. Additional images keep their body positions and use the same size limits. Every image and article headline links to the original `post_url`; articles without images use the linked headline. Captions, formatting, and other body links are preserved. Moving an image adds no spaces: text on either side joins directly unless the author supplied whitespace. Leading caption breaks are removed; middle and trailing breaks remain. These are rendering changes only: the stored Markdown and uploaded image bytes stay intact, and template rebuilds apply the layout to the existing published snapshot.

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

Status includes the job ID, phase, migration count, timestamps, and queued/running/completed/failed state. Check it manually. Application failures pause at the first error and retain the current HTML until a successful replacement. Resume after repairing the cause. Later queued jobs report `blocked_by` when a failed earlier job blocks them. There are no external alerts or automatic application retries.

Jobs use persistent Durable Object state and one-shot alarms, surviving object eviction. Migration and rendering share the publishing queue. The initial job imports old `digests/YYYY-MM-DD.json` files in checkpointed batches of 25, using their R2 upload times as receipt times. Stable legacy IDs and conditional writes prevent duplicate imports after interruption. Existing sources and old daily HTML remain private backups. Normal publishing merges legacy/imported identities during migration.

For the initial snapshot, the old stored index's upload time supplies the publication time and date-window anchor. If there is no index, the latest legacy receipt time is used. Later rebuilds use the published manifest so they cannot advance the date window or introduce uncommitted source posts.

To restore an omitted post, a Cloudflare operator must restore valid source JSON at the exact R2 key identified in the warning, using the dashboard or Wrangler. Use the original saved request or a backup; imported legacy posts may still have their original `digests/*.json` backup. This project does not keep a second source copy for newer posts. Restoring a source does not change the homepage immediately: a subsequent publication containing new stories includes it again only if its original receipt date remains eligible. A matching API submission returns its historical duplicate identity and does not refresh its receipt time; a duplicate-only submission does not restore the homepage.

Template rebuilds neither read nor reconsider omitted references, even after restoration. If a selected source becomes damaged, the rebuild pauses and leaves the stored homepage unchanged. Restore that source and resume, or publish a new digest (which omits the damaged source) before resuming the job. Invalid legacy sources still pause migration and require repair before migration can finish.

A damaged-source rebuild records `error_code: "source_damaged"` on its failed job. The correlated `rebuild_failed` log identifies `source_key`, `post_id`, and the fixed `reason` (`missing`, `invalid_json`, or `invalid_digest`); it never includes the source contents or parser excerpts. Use that exact key when restoring a backup. Enqueue, status, and resume storage failures log their internal `storage_error` and failed stage in the Durable Object; the rejected HTTP RPC remains `503 service_unavailable`. Alarm startup failures log a generated request ID, executing version/environment, and the job ID when the queue was readable, then rethrow for platform redelivery without changing job state. After the job loads, events use its original request/job correlation and the existing failed-job/resume behavior.

| R2 key | Contents |
| --- | --- |
| `posts/YYYY-MM-DD/<id>.json` | Private server-dated source posts |
| `publications/<uuid>.json` | Immutable private snapshot manifests |
| `pages/index.html` | Public rendered index; metadata references its manifest |
| `images/<sha256>.<extension>` | Immutable uploaded images |
| `digests/*.json`, `pages/digests/*.html` | Retained private legacy backups |

Only `/`, `/index.html`, `/images/<hash>.<extension>`, and the explicit metadata/artwork routes listed above are public. Old daily routes return `404`. Digest sources, publication manifests, bucket listings, artwork source files, and config files are never exposed. There is no archive listing or public administration UI.

HTML and RSS support HEAD and weak ETag revalidation, require revalidation, permit compression, and bypass edge caching. Malformed `If-None-Match` conditions are ignored consistently for public GET and HEAD requests. Image GETs use Workers Caching. Protected APIs always return `no-store` JSON. Maintenance CLI errors preserve HTTP status even when Cloudflare returns non-JSON content.

## API errors and request provenance

Every application-generated `/api` response has `X-Request-ID`, `X-Worker-Version` (Cloudflare version ID), and `X-API-Version: 2`. JSON API replies also include `request_id`; HEAD responses have no body. These headers identify the code handling the request independently of the stored homepage's age. Cloudflare edge/WAF failures that never reach the Worker may have a different response shape and no application request ID.

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

`bytes_received` counts body bytes consumed by the Worker, not transport bytes received by Cloudflare. Optional `declared_body_bytes` is the unverified numeric Content-Length header. Rejecting that header before reading reports zero consumed bytes and `body_complete: false`. Multipart `body_complete` follows stream EOF independently of parsing: a fully read malformed form can report true. Public non-API errors retain a minimal `{ok, error}` body, with full diagnostic details in logs.

| Status | Codes / meaning | Caller action |
| --- | --- | --- |
| 400 | `invalid_utf8`, `invalid_json`, `validation_failed`, `invalid_multipart`, `invalid_file_field` | Correct encoding, syntax, fields, or multipart form. Empty digests report `empty_items` in validation details. |
| 401 | `unauthorized` | Supply the correct publishing credential. |
| 404 / 405 | `not_found`, `job_not_found`, `method_not_allowed` | Check the route or the `Allow` header. |
| 409 | `job_not_failed` | Only failed rebuild jobs can resume. Duplicate digests return 200. |
| 413 / 415 | `body_too_large`, `unsupported_media_type`, `image_type_mismatch` | Respect the size limit and canonical media type/signature. |
| 500 | `storage_error`, `render_failed`, `body_read_failed`, `internal_error` | Storage/body transport failures are retryable; rendering and internal failures require operator repair. An uncertain publication outcome always allows unchanged-payload retry within its original receipt window. |
| 503 | `configuration_error`, `uploads_busy`, `service_unavailable` | Configuration requires repair; upload contention and unavailable publishing/rebuild RPCs are retryable. Uploads retain `Retry-After: 1`. |

`retryable` means an unchanged operation may reasonably succeed later; fix 4xx input errors rather than repeating them. Digest failures additionally report `publication_status`: `not_attempted` means the publisher was never invoked; `not_committed` means a failure before index replacement; `unknown` means an index write or RPC acknowledgement may have been lost; `committed` means the replacement is known to have completed. An unknown outcome is not a JSON error. Retry the identical payload only within the receipt-based deduplication window.

## Cloudflare diagnostics

Production and preview explicitly persist invocation logs and traces at sampling rate 1, with source-map uploads and query-string redaction. Application logs contain metadata, request hashes, fixed validation paths, bounded hashed duplicate URLs, and sanitized exception classifications/stack locations. They exclude request bodies, submitted field values, credentials, and raw query strings. No rejected-payload archive, external provider, or alerts are configured.

Structured `request_completed`, `request_error`, `operation_stage`, `publish_result`, `publish_failed`, `source_omitted`, and `rebuild_*` events carry request IDs, executing Worker version, environment, and available post/job IDs. Stage events measure authentication, body reading, parsing, validation, queue wait, source loading, duplicate filtering, rendering, and writes. Rebuild state writes, checkpoints, and finalization have separate stages: a finalization failure can report a committed homepage with a failed job. Rebuild alarms retain the enqueue request ID and job ID, while recording their executing version. Request summaries include total duration, status/code, counts, publication outcome, declared/consumed byte counts, origin response ETags, and complete-body hashes when available. Detailed public-read and 404 events remain enabled.

Digest events use `publication_outcome: "published" | "duplicate" | "failed"`. Rejected digest requests remain logged as failed requests with `publication_status: "not_attempted"`; exclude that status when counting attempted publication failures. Duplicate-only success omits `publication_status`; it is not a failed commit. The `publisher_rpc` stage has both `transport_outcome` and application `outcome`: delivering a typed failure reply means transport `ok` and application `error`. Active stages are restored after completion and failures retain their actual failed stage. Error codes and retryability come from operation boundaries, not stage-name matching. The `upload_slot_held` stage measures the full slot occupancy through body handling, image validation, and storage completion, including the nested `image_validation` and `image_write` stages; it does not measure admission-check latency.

In the selected Worker's **Observability → Logs**, use the top-level structured fields below with these Query Builder recipes. In **Traces**, open the related invocation by time and Cloudflare invocation/trace metadata; cross-reference application request ID in its logs.

| Investigation | Filters | Group / measure |
| --- | --- | --- |
| One caller report | `request_id` equals the response's `X-Request-ID` | Chronological events across HTTP and publisher RPC |
| Failures by release | `event = request_completed`, `status >= 500` | Count by `error_code`, `worker_version` |
| Duplicate behavior | `event = publish_result` | Sum `duplicates` and `published`; inspect `duplicate_url_hashes` |
| Publication failures | `event = request_completed`, `operation = digest`, `publication_outcome = failed`, `publication_status != not_attempted` | Count by `error_code`, `publication_status`, `worker_version`; exclude requests rejected before invocation and duplicate no-ops |
| RPC application failures | `event = operation_stage`, `stage = publisher_rpc`, `outcome = error` | Group by `transport_outcome` to separate delivered failures from transport failures |
| API latency | `event = request_completed`, `operation = digest` | p50/p95/max of `duration_ms` |
| Slow storage or queue | `event = operation_stage` | p95/max duration grouped by `stage` |
| Rebuild failure | `event = rebuild_failed` | Inspect `job_id`, `request_id`, and `stage`; query those IDs |

As of October 18, 2026, [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) retain logs for 3 days on Free and 7 days on Paid, subject to account limits; [Workers traces](https://developers.cloudflare.com/workers/observability/traces/) retain 7 days. Full application sampling does not override platform limits, truncation, or [tracing limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/). Cloudflare announces observability pricing changes for December 1, 2026; consult current account settings rather than treating these retention/cost details as permanent. There is no separate long-term diagnostic archive.

The stored telemetry REST API requires the `Workers Observability Write` permission, which an existing Wrangler OAuth login may lack even when deployment and live tail work. A `403` from that API does not establish missing telemetry: inspect the existing dashboard session's stored events and linked traces instead. Do not expand credential permissions just to run verification.

If an edge smoke check cannot find the homepage ETag, compare the public response with `request_completed.response_etag` in the same version's logs. [Cloudflare HTML transformation features can remove weak ETags](https://developers.cloudflare.com/cache/reference/etag-headers/). A valid origin tag and working conditional requests do not establish that the public header is preserved. Keep the strict smoke check and resolve that edge behavior before production rollout; do not weaken the check or change account security settings as part of an unrelated deployment.

## Manual whole-batch cleanup

Use this only for an operator-reviewed correction; rollout does not remove any existing production content.

1. Pause every publishing client and wait for in-flight publishes and rebuild jobs to finish. Record the affected post ID from the API reply or correlated logs. For older posts, inspect the current manifest and its sources in the private R2 bucket.
2. Read `pages/index.html` custom metadata `manifest`, then inspect that exact manifest and find the affected `posts` entry. Use its exact `key`; legacy entries can point to `digests/...`, so do not guess the source path.
3. Download backups of the source JSON, current index, and manifest. Save a private source backup under `operator-backups/<timestamp>/<post-id>.json`, outside `posts/`, `digests/`, and `publications/`. Preserve all original fields and bytes in the backup. Do not delete the source or edit immutable manifests.
4. In the dashboard, replace only the selected source object's `items` with `[]`, preserving its other fields. Historical-source validation deliberately accepts this empty batch. The current rendered homepage has not changed yet.
5. Run `npm run rebuild -- production` (or `preview` for testing), then check `npm run rebuild:status -- production JOB_UUID` until completed. A failed job retains the old homepage: repair the source and resume using the existing command.
6. Verify the removed batch's stories are absent, other stories remain, and the receipt window/publication timestamp remain unchanged. Resume publishing clients. The cleared source no longer reserves its URLs, unless another eligible batch still contains them.

To undo cleanup, pause publishers again, restore the saved source at the exact original key, and rebuild/verify before resuming. Rebuilds retain the selected snapshot: sources that have already left that snapshot require a deliberate new publication instead. Clearing an omitted source does not itself change visible content; inspect `omitted_posts` separately when diagnosing a missing story.

```sh
npx wrangler tail --env preview
npx wrangler tail --env=''
```

Use the Cloudflare dashboard to inspect Worker bindings, variables, secrets, logs, and private R2 objects. During rollout, verify preview smoke checks with `--verify-edge`, confirm the rebuild completed, verify correlated log and trace records, and inspect the homepage before deploying production. Verify production version headers with read-only API requests; do not create diagnostic production posts. Rolling back code does not roll back R2 content; preserve source objects and manifests. Do not run the previous upsert-based Worker against the migrated bucket.
