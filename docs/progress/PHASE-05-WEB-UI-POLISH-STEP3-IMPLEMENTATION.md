# Phase 5 Web UI Polish Step 3 — Album Card + Sidebar

## Scope

This step refines the existing album cards, navigation hierarchy, right-side
visual structure, and responsive layout. It uses only data already returned by
the gallery APIs.

## UI changes

- Album cards now give the album name and existing visibility state a clearer
  hierarchy, with comfortable spacing, a restrained hover/focus treatment, and
  no invented cover or count.
- The left navigation now separates available browsing links from disabled
  future destinations while retaining a clear active state.
- The right sidebar has a consistent card stack and a neutral future-content
  placeholder. It does not claim storage, activity, or member statistics.
- Desktop retains the three-column layout; mobile retains the bottom navigation
  and hides unavailable destinations.

## API / data impact

- No API changes.
- No fake data added; only existing album name and visibility are displayed.
- No schema changes.
- No migration changes.

## Tests

- Navigation active and disabled states.
- Album card name and permission state rendering.
- Sidebar placeholder structure and responsive navigation hooks.

## Deferred

Album covers, counts, activity, storage usage, and other sidebar data remain
deferred until their backend contracts exist.
