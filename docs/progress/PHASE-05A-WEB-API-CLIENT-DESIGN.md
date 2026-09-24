# Phase 5A Web API Client Design

Status: DESIGN ONLY. This document does not change code, configuration, schema, or migrations.

Baseline:

- `docs/progress/PHASE-05A-WEB-UI-IMPLEMENTATION-DESIGN.md`
- Phase 5A Web UI preflight: Next.js 16.3.3 App Router in `apps/web`, tokens in `packages/ui-tokens`, no fetch client, no Tailwind, no `packages/ui`
- Session cookie from `apps/api/src/auth/http.ts`: `__Host-family_session`, `Path=/`, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`
- Gallery reads already exist: timeline, album list, album media, album detail, derived thumbnail and preview

`PHASE_4_PRODUCTION_READY: NO`.

## 1. Same Origin Strategy

The browser talks only to the Next.js origin. Next.js forwards `/api/v1/*` to the existing API process.

```text
Browser  --cookie-->  Next.js origin  --rewrite-->  API origin
```

The API stays the only place that checks the session and album ACL. Next.js does not reimplement membership, album visibility, or derived authorization.

Why this shape:

- `__Host-family_session` is stored for the host that sends `Set-Cookie`. It cannot carry a `Domain`, and it is not sent to a second host.
- Web on port 3000 and the API on another port are different hosts. A browser `fetch` straight to the API would not include the cookie set for the Web host, and a cookie set by the API host would not be visible to Web JavaScript or to a different host.
- A Next.js rewrite makes login, gallery JSON, and derived image URLs share the Web host. The browser stores and sends the cookie for that host. The rewrite copies the `Cookie` request header to the API and copies `Set-Cookie` back without adding `Domain`.

The rewrite destination is a server-only origin, named `FAMILY_ALBUM_API_ORIGIN` in the design. It is not a `NEXT_PUBLIC_` variable and it is not written into the client bundle.

The browser-facing host must be a secure context. The cookie is `Secure`. `next dev --hostname 127.0.0.1` is plain HTTP today. Implementation uses a browser host that will actually store this cookie, and does not remove `Secure`, `HttpOnly`, or the `__Host-` prefix.

Gallery Phase 5A only needs GET. Those requests do not send `Origin` in the same way as a JSON POST. The existing JSON origin allowlist stays on mutating routes. This design does not widen it and does not add a Bearer token.

## 2. Authentication

The cookie remains HttpOnly. Client components cannot read it, and they must not try through `document.cookie`.

Server components and route handlers may read the cookie jar with the Next.js server `cookies()` API. They forward the raw `Cookie` header on the server-side API call. They do not put the token, the cookie value, or the cookie header into props, serialized state, logs, or the client bundle.

Client components call same-origin relative URLs. The browser attaches the cookie because the URL is the Next host. The client passes `credentials: "same-origin"` and does not set `Authorization`.

401 handling:

- `GET /api/v1/me` is the gate for the gallery shell.
- Status 401 or body code `UNAUTHENTICATED` means signed out. The shell shows a quiet signed-out state and does not request timeline, albums, or derived bytes.
- Phase 5A does not add a login screen. There is no login route in `apps/web` today.
- The client does not retry 401 and does not clear the cookie itself. Logout stays on the existing API.

Hidden albums, deleted albums, and a missing family already return `NOT_FOUND` from the API. The UI uses the same not-found state for those responses. It does not show a message that distinguishes “hidden from you” from “missing”.

## 3. API Client

One wrapper lives under `apps/web/lib`. The Web package depends on `@family-album/contracts`. The wrapper is the only place that builds gallery URLs.

Base URL on the client is the relative path `/api/v1`. Server-side calls use the incoming Web origin plus that path, or the server-only API origin with the forwarded cookie. Both stay off the client bundle except the relative `/api/v1` prefix.

Wrapper behavior:

- `GET` only for this phase.
- Sends no body and no `Authorization`.
- Accepts `application/json` for document calls.
- On a JSON error, parses `authErrorResponseSchema`. Known codes stay `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `INVALID_REQUEST`, and `SERVICE_UNAVAILABLE`.
- On success, parses the matching strict schema and returns the parsed value: `meResponseSchema`, `familyTimelinePageSchema`, `albumsResponseSchema`, `galleryMediaPageSchema`, or `galleryMediaDetailSchema`.
- A body that fails the schema becomes a client-side unavailable error. The UI does not render the raw body.
- Derived bytes are not parsed as JSON. The grid and viewer use same-origin image URLs.

Error mapping shown to a member:

| Result | UI |
| --- | --- |
| 401 `UNAUTHENTICATED` | Signed-out state. Stop gallery reads. |
| 404 `NOT_FOUND` | Not-found or empty state. |
| 403 `FORBIDDEN` | Generic unavailable state. |
| 503, network failure, invalid JSON | Quiet retry-later state. One user retry, no tight loop. |
| Derived 404 or 503 | Warm placeholder. No other image kind. |

Public messages from `createAuthErrorResponse` are already generic. The UI may show that message for a validated code. It does not append stack traces, SQL, or the response text when validation fails.

## 4. Next.js Integration

`next.config.ts` gains a rewrite, and nothing else in this design:

```text
/api/v1/:path*  ->  ${FAMILY_ALBUM_API_ORIGIN}/api/v1/:path*
```

`transpilePackages` gains `@family-album/contracts` when the Web package imports it. Token transpilation stays as it is.

Server components:

- Root gallery layout loads `GET /api/v1/me`.
- A 401 renders the signed-out shell.
- A membership supplies `familyId` and `familyName`. Phase 5A uses the first membership when several exist.
- The first timeline or album page may be loaded on the server. The cursor for the next page stays in the page component.

Client components:

- Month grouping, infinite scroll, viewer open and close, and the next cursor request.
- They call the same wrapper. They do not import the API origin.

Images:

- Thumbnail: `/api/v1/media/{mediaId}/derived/thumbnail`
- Preview: `/api/v1/media/{mediaId}/derived/preview`
- Use a normal `img` whose `src` is that same-origin path.
- Do not use the Next.js image optimizer for these URLs. The optimizer would fetch as the server, can drop the member cookie, and can cache a private image outside the member session.
- `alt` is a generic photo label. Captions do not include GPS, filenames, or storage keys.

## 5. Security

- The session cookie stays `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and host-only. JavaScript never reads it. Logs never print it.
- The client never receives a storage key, original path, filesystem location, or original URL. Those fields are not in the gallery schemas. The wrapper rejects unexpected JSON keys because the schemas are strict.
- Derived URLs contain only `mediaId` and `thumbnail` or `preview`. A kind outside that pair is not requested.
- ACL stays on the API. A hidden album id typed into the address bar gets the API `NOT_FOUND`. The client does not decide visibility from `effectivePermissions` alone and then still render a grid.
- 404 remains 404. The UI must not convert it into a 403 explanation that reveals a hidden album.
- Viewer state only chooses which loaded id to display. Opening the viewer does not grant access. Detail and preview still go through the API.
- No original fallback when preview is missing.

## 6. Files Plan

Expected edits, not made by this document:

- `apps/web/next.config.ts`: rewrite and contracts transpile entry.
- `apps/web/package.json`: depend on `@family-album/contracts`.
- `apps/web/lib/api.ts`: fetch wrapper, error mapping, schema validation.
- `apps/web/lib/gallery.ts`: timeline, album, media, detail, and derived URL helpers.
- Gallery components under `apps/web/components/gallery/`: call the wrapper and render signed-out, empty, not-found, and placeholder states.
- `apps/web/app/layout.tsx` and the gallery pages: server `me` read and the pages named in the UI design.

No schema change. No migration. No API route change. No cookie flag change.

## Deferred

- Login and logout screens
- Family switcher when `me.memberships` has more than one family
- Upload placement after the existing upload flow
- Search, memories, map, favorites, video, and AI

## Schema Impact

```text
Schema change: NO
```

## Migration Required

```text
Migration: NO
```

## Findings

P0: none.

P1: the current Web dev server is `http://127.0.0.1:3000`. The session cookie is `Secure`. Implementation has to use a browser host that stores that cookie. The cookie flags stay unchanged.

P2: Phase 5A has no Web login page. A 401 can only show a signed-out state until a later auth screen exists.

P3: several memberships use the first `me.memberships` entry. A switcher is later work.

```text
API_CLIENT_DESIGN_PASS: YES
READY_FOR_IMPLEMENTATION: YES
```
