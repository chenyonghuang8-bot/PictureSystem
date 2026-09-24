# Phase 5C Public Share UI Implementation

Status: IMPLEMENTED. Schema, migrations, backend APIs, rate limiting, original download, QR, and analytics are unchanged.

Baseline:

- `docs/progress/PHASE-05C-PUBLIC-SHARE-UI-DESIGN.md`
- `project-spec/UI_REFERENCE.md`
- existing album detail, photo grid, and warm gallery styles

`PHASE_4_PRODUCTION_READY: NO`.

## Components

Album detail shows a `分享` action. Opening it lists this album’s shares and offers an expiration of 7 or 30 days.

`ShareLinkResult` shows the share link and `复制链接` only after `POST` succeeds. Closing the panel or refreshing the page drops that link. The list never receives a token.

`ShareList` shows the album name, created time, expiration, and stopped time. A live share offers `停止访问`. The confirmation says `停止该分享链接访问` and does not say `删除分享`.

`PublicShare` is a photo page without the family shell. The grid requests `thumbnail`. The viewer requests `preview`. A failed preview says `没有找到`.

## Pages

`/albums/[albumId]` keeps the existing album detail and adds share management.

`/share/[token]` loads the public album. An unusable link renders `PublicShareMissing`: `没有找到` and `这个链接无法打开。` The page sets `noindex` and `no-referrer`. It does not show family navigation, member information, or management controls.

## API Usage

Internal calls:

- `POST /api/v1/albums/:albumId/share` with `{ expiresAt }`
- `GET /api/v1/shares?familyId=`
- `DELETE /api/v1/shares/:shareId` with `{}`

Public calls:

- `GET /api/v1/share/:token`
- `GET /api/v1/share/:token/media/:mediaId/derived/thumbnail`
- `GET /api/v1/share/:token/media/:mediaId/derived/preview`

The public server fetch does not send the session cookie. Image URLs are built only for `thumbnail` and `preview`.

## Security

The raw token is shown only inside the link returned by create. List parsing rejects a payload that includes a token. The public page rejects a payload that includes a location field. Visible copy does not include a storage key, an original path, GPS, family data, or a member list. A removed preview and every rejected public link use the same not-found copy, without saying whether the link is invalid, expired, or revoked.

## Tests

`apps/web/components/gallery/share.test.ts` covers the album share entry, the one-time copy link, the share list fields, the stop-access confirmation, create / list / revoke requests, a public thumbnail and preview page, one not-found state for an invalid or 404 link, a removed preview, and rejection of GPS or a token on the list.

Targeted result: 6 share tests PASS, plus the existing gallery page tests. `@family-album/web` typecheck PASS.

Browser check on `http://127.0.0.1:3000`: both `/share/not-a-token` and a well-formed unknown token render the title `分享`, the heading `没有找到`, and the line `这个链接无法打开。` Family navigation is absent. The album management screen requires a signed-in session, so the share button was not exercised in the browser.

## Schema Impact

```text
Schema: NO
```

## Migration

```text
Migration: NO
```

## Findings

P0: none.

P1: none.

P2: public rate limiting remains unimplemented. This task does not add it.

P3: QR and analytics remain deferred.

```text
PUBLIC_SHARE_UI_IMPLEMENTATION_PASS: YES
```
