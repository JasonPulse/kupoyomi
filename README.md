# Kupoyomi

Owns manga series identity and a source-independent chapter ledger. Suwayomi is
used as a stateless extension runtime, not as an application.

## Why

Suwayomi keys downloads by source, so moving a series to a new source orphans every
file it already had. Upstream closed that as not planned ([#1367]) and the rescan
request is still open ([#732]). Kupoyomi puts identity and the ledger somewhere that
a source change cannot touch.

[#1367]: https://github.com/Suwayomi/Suwayomi-Server/issues/1367
[#732]: https://github.com/Suwayomi/Suwayomi-Server/issues/732

## Design

- A series is an opaque id. Sources hang off it as bindings, one primary plus
  supplementals. Identity is confirmed once by a human and never re-derived.
- The chapter ledger is keyed on **chapter number alone**. Scanlator is metadata.
  Putting the group in the key would mean a source change matches nothing and
  re-downloads everything, which is the bug this exists to prevent.
- Chapters are fetched by priming `fetchChapterPages` and streaming Suwayomi's page
  proxy, so the extension's client, cookies and Cloudflare handling apply. Suwayomi
  needs no library entry and no downloads folder, which is what lets it run on
  `emptyDir` with nothing worth backing up.
- Group choice prefers whichever group owns the most chapters already held. If it is
  absent for a chapter, earliest upload wins. Availability beats consistency.
- Migration is never automatic. Candidates are shown with chapter count, gaps and
  recent upload dates, and a human picks.

## Commands

    kupoyomi report              what is on disk vs what the library tracks
    kupoyomi find [--only S]     exact-title search for series on dead sources
    kupoyomi compare <mangaId>   chapter count, gaps, recent uploads
    kupoyomi migrate             apply db/*.sql
    kupoyomi import [--limit N]  find homes and stage them for confirmation

`report`, `find` and `compare` are read-only.

## Configuration

| Variable | Default |
| --- | --- |
| `SUWAYOMI_URL` | `http://suwayomi-service/api/graphql` |
| `DATABASE_URL` | unset, required for `migrate` and `import` |
| `LEGACY_ROOT` | `/data/Manga` |
| `LIBRARY_ROOT` | `/data/Library` |

When `LEGACY_ROOT` is not a mounted directory, the tree is read over `kubectl exec`
instead. That is how this is verified from a workstation before it is deployed.

## Matching

Exact title only, never fuzzy. Suwayomi replaces filesystem-illegal characters with
`_`, so `Tsukimichi: Moonlit Fantasy` is stored as `Tsukimichi_ Moonlit Fantasy`.
Comparing folder names to source titles therefore happens in sanitized space, which
is still exact but does not have to guess which of `\ / : * ? " < > |` the
underscore replaced.
