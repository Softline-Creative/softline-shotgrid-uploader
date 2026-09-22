# ShotGrid Uploader — working notes

Context for anyone (human or agent) picking this up. The decisions below
were argued through with the user; most of them look arbitrary until you
know why, so read this before changing behaviour.

## What it is

A desktop app that uploads video and stills to Flow Production Tracking
(formerly ShotGrid). An artist drags exports in, the tool works out which
Sequence each belongs to, creates Versions, uploads the media, and adds
everything to a daily review playlist.

Built for the Video Studio at Softline Solutions. The user is the Video
Production Lead; his artists and designers are the intended users, and
most of them have never opened a terminal. That constraint drove almost
every UI decision here.

## Layout

    upload_videos.py   parsing, matching, naming, ShotGrid calls
    flow_uploader.py   PySide6 interface only
    config.py          credentials and project id (NOT in this bundle)
    launch.command     double-clickable launcher

    web/               browser version for Netlify - see "Web version" below

The split is deliberate. `flow_uploader.py` imports everything from
`upload_videos.py` and contains no domain logic. `upload_videos.py` also
works standalone as a CLI (`python3 upload_videos.py <folder> --go`).

**The two files are a matched pair.** Replacing one without the other is
the single most common failure; there's an explicit ImportError guard at
the top of `flow_uploader.py` that turns the resulting traceback into a
readable dialog. Keep it.

## The site's schema

Discovered by reading the live schema; don't assume these names.

    Sequence.sg_activations    single entity   -> CustomEntity01
    Sequence.sg_product        multi entity    -> CustomEntity02
    Sequence.sg_deliverable    multi entity    -> CustomEntity03
    Version.sg_uploaded_movie  url             media goes here (stills too)
    Version.sg_path_to_movie   text            original path recorded here
    Version.sg_version_number  calculated      read-only, do not write

Activation is single, Product and Deliverable are multi. Writing a single
dict to a multi field fails.

The site also has "none" placeholder entities — `Non-Activation`,
`No Product` and similar. `find_none_option()` matches them by name
ignoring case, spaces and punctuation.

## Filename convention

    [BRAND_] [CAMPAIGN_] TITLE _ [SQUARE_] STAGE _ vNNN      video
    [BRAND_] [CAMPAIGN_] TITLE _ [SQUARE_] STAGE _ N_N_N     stills

Parsed **right to left**, so the number of title segments is free.

- Underscores only. Spaces are rejected with a message that hands back
  the corrected name.
- Version: `v` + digits, any padding. Normalised to `vNNN`.
- Stage: second from the right. `STRICT_STAGES = False`, so an unknown
  word is accepted as typed and flagged amber rather than rejected. Words
  in `KNOWN_STAGES` get their canonical spelling.
- Square: `Square`/`sq`/`1x1`, found **by name anywhere** between title
  and version, not by position. Only Square — the user explicitly does
  not want other ratios.
- Brand (`BRIO`/`LAGO`) and campaign prefixes are optional and stripped.
- Stills end in exactly three numbers. A stills file may be **only**
  numbers (`2_9_1.jpg`), in which case the containing folder name
  becomes the title.

## Decisions that will look wrong without the reasoning

**There is no key field on Sequence.** An earlier version stored a
`sg_file_key` on each Sequence. The user found it confusing and deleted
the field. Matching is now purely name-based, and the internal `key` in
the code is an in-memory grouping id that never reaches ShotGrid. Don't
reintroduce it without asking.

**Square is a separate Sequence, not a sibling Version.** This was
reversed partway through. `search_title()` folds the format into the
title, so `X` and `X_Square` are different videos with different
Sequences. The Version name therefore does *not* repeat the format.

**Matching strips what the tool itself added.** Sequence names are
generated as `<title> <deliverable> - <activation|product>`. The matcher
removes the suffix after the dash and any trailing known Deliverable
before comparing, so a filename carrying only the title still scores
100%. See `match_score()`.

**Campaign mismatch is penalised, not ignored.** Comparing only the part
before the dash made `Press Conference - RAF 12` a 100% match for a RAF 13
file. `CAMPAIGN_MISMATCH` discounts a Sequence whose suffix names a
different campaign.

**Scoping is mandatory and takes the union.** Every video needs an
Activation or a Product before matching runs; that's what makes loose
filenames workable. Naming both *widens* the pool, because some Sequences
hang off a Product (launches, featurettes) with no Activation at all.

**Nothing is auto-accepted.** The user asked for propose-and-confirm. The
matches screen fills in the best candidate but the user approves before
anything is written. Rows where the top two candidates are within 3% are
marked `!` as ambiguous.

**Guessing uses a majority, not unanimity.** Requiring every sibling
Sequence to agree meant it never fired on real data. It now takes the
most common value and reports the support ("copied from 3 of 4").

**Deliverable is required when creating a Sequence.** Activation and
Product are not.

## Flow

    drag files
      -> Next            AssignDialog: Activation/Product per video
      -> Find Sequences  MatchesDialog: destination per video
      -> Next/Done       CreateSequencesDialog, only if new ones are needed
      -> back to main window
      -> Upload

Nothing is written to ShotGrid until Upload. Uploaded files are marked
and excluded from later runs — an earlier bug let them be re-uploaded,
which then tripped the tool's own duplicate-version check.

## Qt gotchas already paid for

- The app stylesheet pads `QLineEdit`. A combo's editable field *is* one,
  so it got padded twice and the typed text rendered outside the visible
  area. `_LINE_RESET` and the `QComboBox QLineEdit` rule fix it; any new
  inline stylesheet on a combo's line edit must include the reset.
- A word-wrapped `QLabel` doesn't request extra height unless
  height-for-width is enabled. `no_enter_default()` sets it on every
  wrapped label; it also disables auto-default buttons so Return doesn't
  skip a screen.
- While a combo popup is open, keys go to the **list**, not the field.
  `_TypeToFilter` closes the popup on the first printable character and
  restarts it as a filtered search.
- Never touch a widget from a background thread. The error handler hops
  to the main thread via `QTimer.singleShot` for exactly this reason —
  the first version segfaulted.
- Errors are written to `uploader-error.log` beside the app, including
  faulthandler output, because the launcher's terminal window closes.

## Testing

No test suite. Everything was verified headlessly:

    QT_QPA_PLATFORM=offscreen python3 -c "..."

Construct dialogs directly with fake sequence/entity dicts and inspect
widget state. `QMessageBox.exec` and the dialogs need stubbing to avoid
blocking. This works well and is worth keeping up — a proper pytest suite
around `upload_videos.py` would be a sensible first contribution, since
the parsing and matching functions are pure.

## Known gaps / possible next steps

- Not packaged. Distribution is still "copy two files". PyInstaller into
  a `.app` is the agreed next step; ffmpeg is not bundled.
- The script key is shared, so every user acts as `media_uploader`. The
  artist is set explicitly from a stored login. ShotGrid Toolkit would
  fix this properly but was judged too costly for a team this size.
- Spaces are rejected for video but still parse for stills.
- No retry on a failed upload; the file simply stays unmarked.
- `suggest_sequence_name()` is largely superseded by
  `compose_sequence_name()` and could go.
- Deliverable is not on the assignment screen. Adding it would give
  another scope filter and would break ties between Sequences that differ
  only by Deliverable.

## Web version

`web/` is a browser port for Netlify: Vite + React front end, Netlify
Functions (TypeScript) as the only server. Decided with the user:

- **Artists sign in with their own ShotGrid login** (REST password
  grant). Tokens live in an AES-GCM encrypted httpOnly cookie
  (`netlify/lib/session.ts`); the browser never sees one. There is no
  script key on the web side. Uploads are credited to whoever signed in.
- **ProRes is uploaded as-is.** No ffmpeg on Netlify.
- **Upload-only first version.** No Sequence creation; unmatched videos
  are skipped with "create it in ShotGrid, then Refresh". Adding the
  CreateSequencesDialog equivalent is the planned second pass.

Layout:

    web/src/lib/naming.ts      port of upload_videos.py's pure functions
    web/src/lib/difflib.ts     port of difflib.SequenceMatcher.ratio
    web/src/queue.ts           MainWindow's grouping/matching, UI-free
    web/src/upload.ts          browser -> ShotGrid storage upload
    web/netlify/functions/     one file per /api/* endpoint
    web/dev/mock-shotgrid.ts   fake ShotGrid for `npm run dev:mock`

**naming.ts must match upload_videos.py exactly** - both apps write to
the same site. `test/parity.test.ts` checks it against
`test/fixtures.json`, which `web/scripts/gen_fixtures.py` produces by
calling the Python directly. Change one side, regenerate, run the tests.

**Media never passes through Netlify.** Functions cap requests at 6 MB.
`upload/start` creates the Version and returns ShotGrid's upload URL;
the browser PUTs the file there (multipart over 500 MB, same threshold
and 20 MB parts as shotgun_api3), then `upload/complete` finalises it.
Proxying through functions isn't a viable fallback: S3's 5 MB minimum
part size doesn't fit under Netlify's limit once base64-encoded.

Unverified against the real site (only the mock): entity names in REST
paths (`/entity/Version/...`), the `_search` call shape, and the
multipart `get_next_part`/`etags` handshake. If something fails on first
deploy, look there first. The mock implements what the code assumes, so
it proves the app is internally consistent, not that ShotGrid agrees.
