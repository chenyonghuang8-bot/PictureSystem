# Phase 5 Web UI Polish Step 2 — Photo Grid + Viewer

## Scope

This step polishes the existing gallery photo grid and viewer without changing
the timeline API, media contracts, backend routes, permissions, schema, or
migrations.

## UI changes

- Photo cells keep their existing thumbnail-only source and preserve known
  aspect ratios.
- Masonry spacing, hover/focus scale, lazy loading, and a short image loading
  transition improve the photo-first grid at desktop, tablet, and mobile
  breakpoints.
- The viewer now presents the preview in a dark, centered stage with a bounded
  contain layout, loading indicator, thumbnail fallback, and an explicit close
  button that also responds to Escape.
- Viewer metadata remains limited to fields already returned by the API. GPS,
  original paths, and original media are not exposed.
- Preview failures remain user-friendly: a thumbnail is used as a fallback and
  missing media shows a neutral message.

## Tests

- Viewer dialog and preview-only path rendering.
- Preview loading and thumbnail fallback states.
- Responsive masonry hooks, lazy loading, and preserved ratio markup.

## API / data impact

- No API changes.
- No schema changes.
- No migration changes.
- No fake data added.

## Deferred

Full browser visual regression and real HTTPS cookie validation remain outside
this UI-only polish step.
