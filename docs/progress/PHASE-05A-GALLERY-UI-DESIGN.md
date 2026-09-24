# Phase 5A Gallery UI Design

Status: DESIGN UPDATE ONLY. This document does not change code, schema, migrations, or the API implementation.

Baseline: `phase-4-complete` at `63cfee6`. Phase 5A album list, album media browse, album-scoped detail, and derived bytes already exist. `PHASE_4_PRODUCTION_READY: NO`.

Visual authority:

- `project-spec/UI_REFERENCE.md`
- `project-spec/ui/app-preview.png`
- `project-spec/ui/web-preview.png`

This update replaces the narrower reading that Phase 5A is only an album browser. Gallery is the photo-first home, the album browser, and the detail viewer.

## 1. Product Alignment

Gallery is the photo-first experience. The first screen shows photographs, not statistics, navigation chrome, or album administration.

Three surfaces:

| Surface | What the member sees | Scope |
| --- | --- | --- |
| Home Timeline | The family’s photographs, grouped by month | Every media item in at least one album the member can view |
| Album Browse | Album list, then one album’s grid | One authorized album |
| Detail Viewer | A large preview and a short metadata panel | One placement in the album or timeline context that opened it |

`project-spec/PROJECT.md` asks for a private family album on Android and Web. `project-spec/ROADMAP.md` Phase 5 names the Web shell, timeline, and photo viewer. `docs/progress/PHASE-05-ROADMAP.md` keeps sharing, video, and AI out of this phase. Phase 5A draws the three gallery surfaces and uses only the approved read APIs plus one missing home-timeline read, described below and not implemented here.

The reference images also show search, memories, map, favorites, place labels, heart counts, video duration, and storage statistics. Those are not Phase 5A behavior. The layout may reserve their positions. It does not invent their data.

## 2. UI Reference Analysis

`project-spec/UI_REFERENCE.md` is the written visual spec. The two PNG files are the confirmed screens.

App navigation is a fixed bottom bar:

1. 照片
2. 相册
3. 回忆
4. 我的

照片 is the home timeline. 相册 is album browse. 回忆 and 我的 stay present and inactive for this phase.

Web layout is three columns:

- Left: family title and primary navigation. 照片 and 相册 are active destinations. 回忆, 地图, 收藏, 家庭成员, and 管理后台 stay visible only as disabled or omitted entries until their phases.
- Center: the photograph. Search, memories, and album shortcuts sit above the month grid and must not push the first photo row off the first screen.
- Right: auxiliary only. It is not a dashboard. Storage totals, “美好数据”, and featured counts are not available from the gallery APIs, so Phase 5A leaves that column empty or repeats a few recent timeline thumbnails. It does not show invented numbers.

Visual language from `UI_REFERENCE.md`: warm white background, dark gray text, quiet secondary text, green as the accent, large radii, light borders, almost no shadow. Photographs are the primary object. Cards, icons, and captions stay smaller than the image they describe.

Responsive rules in the same file: desktop keeps three columns, a tablet may collapse the left rail and drop the right rail, and mobile Web follows the App structure.

## 3. Home Timeline

The home timeline is the default 照片 destination on App and Web.

Content, from top to bottom, matching the references without copying deferred data:

- Family title and member presence. Avatars render only when a later profile API exists. Phase 5A may show the family name alone.
- Month heading, taken from `timelineKey`, newest month first.
- A responsive thumbnail grid under that heading.
- A green upload control in the App reference. It may open the existing Phase 3 upload flow. It does not create an `album_media` row. Placement is Phase 5B.

Month grouping happens on the client after pages arrive. A page can cross a month boundary. The client starts a new month heading when `timelineKey` enters a new calendar month and does not request one HTTP call per month.

Lazy loading asks for the next cursor when the member nears the end of the loaded grid. The home does not use offset pages.

The same media item placed in two visible albums appears once. The server chooses one viewable album context for the later detail link and does not list the hidden albums.

Empty and not-ready states stay quiet. A cell with no READY thumbnail shows a warm placeholder, not an error code or a processing state.

These reference details are not part of the home timeline yet: 往年今日, search, place names, heart badges, video duration, and album photo counts.

## 4. Album Browse

相册 opens the album list from `GET /api/v1/albums`.

Each album card shows the album name and visibility only as text the API already returns. The reference’s cover image and “3,428 张” count are not in that response. Phase 5A does not add them. A card has no cover image until a later review. It does not compute a count by reading every media page.

Choosing an album opens the album detail grid from `GET /api/v1/albums/:albumId/media`. The grid uses the same thumbnail cell as the home timeline. Order is `timelineKey` descending, then `mediaId` descending. Hidden albums are absent from the list. A direct album URL the member cannot view shows the same not-found state as a missing album.

## 5. Detail Viewer

The viewer opens from a home cell or an album cell. It shows:

- The preview image from derived `preview` bytes.
- Dimensions, orientation, capture time, and camera make/model when the detail payload includes them.
- Previous and next within the loaded list, then the next cursor page at the edge.

The viewer does not show the original by default. There is no original URL, path, filename, or download on this surface.

GPS is not shown by default. The reference’s place labels and map pins are deferred. Phase 5A does not read `gps_latitude` or `gps_longitude`, and it does not geocode a thumbnail caption.

If the preview is not READY, the viewer keeps the thumbnail or the placeholder. It does not fall back to the original file.

## 6. Component Mapping

| Reference element | Phase 5A component | Notes |
| --- | --- | --- |
| App bottom bar and Web left rail | Navigation | 照片 and 相册 navigate. Other items do not load a feature. |
| Album shortcut and “我的相册” | Album card | Name only. No cover and no count. |
| Month title over the photo block | Timeline section | Grouped from `timelineKey`. |
| Photo masonry / grid | Media grid | Thumbnail bytes only. |
| Green plus | Upload entry | Existing upload flow. No album placement. |
| Opened photograph | Viewer | Preview bytes plus the detail fields. |
| 往年今日 card | Not in 5A | Memories are deferred. |
| Search field | Not in 5A | Shown in the reference, not wired. |
| Right-rail stats | Not in 5A | No statistic API. |

## 7. API Mapping

| UI action | API |
| --- | --- |
| Album list | `GET /api/v1/albums` |
| Album grid | `GET /api/v1/albums/:albumId/media` |
| Detail metadata | `GET /api/v1/albums/:albumId/media/:mediaId` |
| Grid image | `GET /api/v1/media/:mediaId/derived/thumbnail` |
| Viewer image | `GET /api/v1/media/:mediaId/derived/preview` |

Home Timeline does not have an API. Calling the album media route once per album would duplicate photographs, issue one request per album, and would not be a single cursor. Phase 5A needs a later timeline read, conceptually:

`GET /api/v1/families/:familyId/timeline`

It would return the same item shape as album media browse, plus the one viewable `albumId` required to open detail. Authorization stays the union of albums the member can view, through `album_media`, deduped by media id, ordered by `timeline_key DESC, media_id DESC`, with the same cursor. This document does not define that route’s SQL and does not add it.

No new timeline column is required. `timeline_key` and `timeline_basis` already exist. Whether that query needs a new index waits for its own query review. This UI design does not approve an index.

## 8. Performance

Album and, later, home lists use cursor pagination. The client keeps the pages it has loaded and appends the next page. It does not request offset windows.

The grid requests thumbnail bytes only for cells near the viewport. It does not prefetch every preview.

The viewer requests preview bytes for the opened item. It may prefetch the next preview after the current one is visible. It does not download the original.

A failed derived read stays a placeholder. The client does not retry in a tight loop and does not substitute another kind.

## 9. Security

- ACL first. The server decides album visibility. The client does not hide a card and call that authorization.
- Derived only. Grid and viewer images come from thumbnail and preview.
- No original exposure. The UI never receives or displays an original path, storage key, or filename.
- Detail from an album uses the album-scoped detail route. A home cell uses the album id returned with that timeline item, once that API exists.
- GPS stays off the gallery surfaces.
- Family role does not bypass a `CUSTOM` album.

## 10. Deferred

- memories, including 往年今日
- search
- map and place labels
- favorites and heart counts
- AI and face recognition
- video badges and playback
- album cover and media count
- album placement after upload
- sharing
- right-rail storage and summary statistics

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

P1: the confirmed home screen is a family timeline. The implemented gallery APIs are album-scoped. A UI that fans out those album calls is not the home timeline.

P2: the reference shows place labels, counts, covers, favorites, and video marks. Copying those pixels would expose GPS or invent fields the API does not return.

P3: navigation items for memories, map, favorites, and admin are visual only until their phases.

```text
UI_ALIGNMENT_PASS: YES
READY_FOR_UI_IMPLEMENTATION: NO
```

Album browse and the detail viewer can be drawn from the current APIs. The home timeline cannot, until the timeline read is reviewed. UI implementation waits for that review.
