# Harness-only photo fixtures

These three owner-supplied files are imported only by
`photoCompressionHarness.tsx` for NOTE-PHOTO-COMPRESS-001 parameter review.
The normal Vite production entry does not reference or bundle them.

- `label.jpeg`: rating-label readability acceptance case (EXIF orientation 8).
- `rotated-kitchen.jpeg`: orientation acceptance case (EXIF orientation 6).
- `burnt-24mp.jpeg`: diagnostic-detail acceptance case (EXIF orientation 1).
