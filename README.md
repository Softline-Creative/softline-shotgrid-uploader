# ShotGrid Uploader

Uploads video and stills to Flow Production Tracking. Drag exports in,
the tool matches each to a Sequence, creates Versions, uploads the media
and adds everything to a daily review playlist.

macOS, Python 3, PySide6. There is also a browser version in `web/`
that deploys to Netlify - see [Web version](#web-version-netlify).

See `CLAUDE.md` for the design decisions and the reasoning behind them.

## Setup

    python3 -m venv venv
    source venv/bin/activate
    pip install -r requirements.txt

Then create `config.py`:

    cp config.example.py config.py

Fill in the site URL, script name and key from ShotGrid (avatar menu →
Admin → Scripts). Check it works and find your project id:

    python3 test_connection.py

Put that id into `config.py` as `PROJECT_ID`.

## Running

    python3 flow_uploader.py

Or `chmod +x launch.command` once, then double-click **launch** in
Finder. Errors go to `uploader-error.log` beside the app, since the
launcher's terminal window closes on exit.

## Filenames

    [BRAND_] [CAMPAIGN_] TITLE _ [Square_] STAGE _ vNNN     video
    [BRAND_] [CAMPAIGN_] TITLE _ [Square_] STAGE _ N_N_N    stills

Read right to left, so the title can be any number of segments.
Underscores only — spaces are rejected.

    BRIO_UFC331_PremiumIceGiveaway_FinalCut_v4.mov
    PremiumIceGiveaway_FinalCut_v4.mov          same thing
    PremiumIceGiveaway_Square_FinalCut_v4.mov   its own Sequence
    EventPhotography_Final_2_9_1.jpg            one of a set of stills
    2_9_1.jpg                                   folder name is the title

Brand and campaign are optional. Version padding is normalised, so `v4`,
`V04` and `v004` are the same. Stage is taken from its position, and an
unfamiliar word is accepted and flagged rather than rejected.

Video: `.mov .mp4 .m4v` — Stills: `.jpg .jpeg .png .tif .tiff`
(PSD is rejected; ShotGrid can't thumbnail it.)

## Using it

1. Drag files in, click **Next**
2. **Where does this belong?** — Activation and/or Product per video
3. **Sequences found** — confirm or change the destination for each
4. **Create new Sequences** — name anything new, pick its Deliverable
5. Back on the main window, click **Upload**

Nothing is written to ShotGrid until step 5.

## Settings

Near the top of `upload_videos.py`:

| Setting | Does |
|---|---|
| `KNOWN_STAGES`, `STILL_STAGES` | Stages given canonical spelling |
| `STRICT_STAGES` | `True` rejects an unknown stage instead of flagging it |
| `FORMATS` | Aspect-ratio markers, currently Square only |
| `BRANDS` | Prefixes recognised and stripped |
| `NONE_NAMES` | Names meaning "not applicable" |
| `PLAYLIST_NAME_FORMAT` | Daily playlist name, `%Y%m%d_Review` |
| `MAKE_PROXY_FOR_PRORES` | Encode an H.264 proxy before upload |
| `CAMPAIGN_MISMATCH` | Penalty when a Sequence names another campaign |

`ACTIVATION_ENTITY`, `PRODUCT_ENTITY` and `DELIVERABLE_ENTITY` are the
custom entity types and are site-specific.

## Command line

`upload_videos.py` also runs standalone, with stricter filename rules and
no Sequence creation:

    python3 upload_videos.py /path/to/folder        # dry run
    python3 upload_videos.py /path/to/folder --go

## Web version (Netlify)

`web/` is the same tool in a browser: drag files in, choose Activation
and Product, confirm the matched Sequence, upload. Artists sign in with
their own ShotGrid login, so uploads are credited to them and there is
no shared script key.

This first version does **not create Sequences**. A video with no
Sequence yet is skipped; create it in ShotGrid, click Refresh, and match
it again. ProRes is uploaded as-is (ShotGrid transcodes it); no proxy
is made.

### Deploying

1. In Netlify: **Add new site → Import an existing project**, pick this
   repository. `netlify.toml` already sets the base directory (`web`),
   build command and functions, so leave those fields as they are.
2. Under **Site configuration → Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `SHOTGRID_SITE` | e.g. `https://yourstudio.shotgrid.autodesk.com` |
   | `SHOTGRID_PROJECT_ID` | the id `test_connection.py` prints |
   | `SESSION_SECRET` | a long random string - `openssl rand -base64 48` |

3. Deploy, open the site, sign in.

### Before relying on it

Two things can only be confirmed against the real ShotGrid site:

- **Sign-in.** It uses ShotGrid's username/password login. If the site
  signs people in through Autodesk Identity / SSO only, that login is
  refused and a different sign-in approach is needed.
- **Direct upload.** Files go from the browser straight to ShotGrid's
  storage, never through Netlify (whose functions cap requests at 6 MB).
  If that storage refuses uploads from the Netlify address, uploads
  fail with "couldn't reach ShotGrid's storage". Files over 500 MB go up
  in parts, which also needs the storage to expose each part's `ETag`.

Test both with one small and one large (>500 MB) file first.

### Developing

    cd web
    npm install
    npm run dev:mock     # app + functions against a fake ShotGrid
    npm test             # includes parity checks against upload_videos.py

`dev:mock` needs no ShotGrid site: sign in as `artist` / `artist`.
`src/lib/naming.ts` is a port of the parsing and matching in
`upload_videos.py`; after changing either, regenerate the parity
fixtures with `python3 web/scripts/gen_fixtures.py` and run `npm test`.
