#!/usr/bin/env python3
"""
Flow Production Tracking video uploader.

Reads a folder of video exports, matches each one to a Sequence via its
file key, creates Versions, uploads the media, and drops everything into
today's review playlist.

Filename convention:

    BRAND_CAMPAIGN_TITLE_STAGE_vNNN.mov

Parsed from the RIGHT, so the number of middle segments doesn't matter:

    last segment          -> version number
    second-to-last        -> stage (must be in KNOWN_STAGES)
    everything before     -> the file key

    BRIO_Tarzann_Q20BWG_Short3_FineCutColor_v001.mov
    key   = BRIO_TARZANN_Q20BWG_SHORT3
    stage = FineCutColor
    ver   = 001

Usage:
    python3 upload_videos.py /path/to/folder          # dry run, changes nothing
    python3 upload_videos.py /path/to/folder --go     # actually do it
"""

import argparse
import collections
import datetime
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import shotgun_api3

from config import SERVER_PATH, SCRIPT_NAME, SCRIPT_KEY, PROJECT_ID


# ---------------------------------------------------------------------------
# Settings you may want to change
# ---------------------------------------------------------------------------

# Stage names the tool knows. A stage in this list is written into the
# Version name with the spelling given here, whatever case was typed.
#
# STRICT_STAGES decides what happens to anything else:
#   True  - reject the file, so a typo is caught before upload
#   False - accept it as typed and flag it as unfamiliar
# The stage is always the segment before the version either way, so
# parsing works regardless; this only controls how fussy the tool is.
STRICT_STAGES = False

KNOWN_STAGES = [
    "Cut",
    "RoughCut",
    "RoughCutColor",
    "FineCut",
    "FineCutColor",
    "ColorCut",
    "FinalCut",
    "Final",
    "Publish",
]

# Video extensions to pick up.
VIDEO_EXTS = [".mov", ".mp4", ".m4v"]

# Still extensions. PSD is deliberately absent - ShotGrid can't make a
# usable review thumbnail from one, so flatten to JPG or TIFF first.
STILL_EXTS = [".jpg", ".jpeg", ".png", ".tif", ".tiff"]

# Stage names for stills. Same rules as KNOWN_STAGES above.
STILL_STAGES = [
    "Select",
    "Selects",
    "Proof",
    "Retouch",
    "Retouched",
    "Final",
]

# Status applied to every new Version. "rev" is Pending Review.
NEW_VERSION_STATUS = "rev"

# Name of the daily review playlist, as a date format string.
# %Y=year %m=month %d=day  ->  20260915_Review
PLAYLIST_NAME_FORMAT = "%Y%m%d_Review"

# A file key must have at least this many segments, so a malformed name
# can never collapse to something dangerously broad like just "BRIO".
MIN_KEY_SEGMENTS = 2

# The first segment of a filename is the brand (BRIO, LAGO...). Set this
# True and the key ignores it, so BRIO_LAFC_Foo and LAGO_LAFC_Foo both
# key to LAFC_FOO. Set it False to keep the brand as part of the key.
DROP_BRAND_FROM_KEY = True

# ProRes masters get an H.264 proxy made before upload. Set to False to
# always upload the original file.
MAKE_PROXY_FOR_PRORES = True
PROXY_CRF = "18"          # lower = better quality, bigger file

# Custom entity types behind the Sequence link fields.
ACTIVATION_ENTITY = "CustomEntity01"   # sg_activations  (single)
PRODUCT_ENTITY = "CustomEntity02"      # sg_product      (multi)
DELIVERABLE_ENTITY = "CustomEntity03"  # sg_deliverable  (multi)

PREFS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          ".uploader_prefs.json")


# ---------------------------------------------------------------------------
# Filename parsing
# ---------------------------------------------------------------------------

class ParseError(Exception):
    pass


def parse_filename(filename):
    """Turn a filename into (key, stage, version_number).

    Raises ParseError with a human-readable reason if it doesn't fit
    the convention.
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    parts = stem.split("_")

    if len(parts) < MIN_KEY_SEGMENTS + 2:
        raise ParseError(
            "not enough segments - expected BRAND_CAMPAIGN_TITLE_STAGE_vNNN"
        )

    version_part = parts[-1]
    stage_part = parts[-2]
    key_parts = parts[:-2]

    # Version must be v + digits.
    if not version_part.lower().startswith("v"):
        raise ParseError('last segment "%s" is not a version like v001'
                         % version_part)
    digits = version_part[1:]
    if not digits.isdigit():
        raise ParseError('last segment "%s" is not a version like v001'
                         % version_part)
    version_number = int(digits)

    # Stage must be one we recognise.
    lookup = {s.lower(): s for s in KNOWN_STAGES}
    if stage_part.lower() not in lookup:
        raise ParseError(
            'unknown stage "%s" - expected one of: %s'
            % (stage_part, ", ".join(KNOWN_STAGES))
        )
    stage = lookup[stage_part.lower()]

    if DROP_BRAND_FROM_KEY:
        if len(key_parts) < MIN_KEY_SEGMENTS + 1:
            raise ParseError(
                "not enough segments after the brand - expected "
                "BRAND_CAMPAIGN_TITLE_STAGE_vNNN"
            )
        key_parts = key_parts[1:]

    if len(key_parts) < MIN_KEY_SEGMENTS:
        raise ParseError(
            "file key would be too short (%s) - needs at least %d segments"
            % ("_".join(key_parts), MIN_KEY_SEGMENTS)
        )

    key = "_".join(key_parts).upper()
    return key, stage, version_number


NONE_NAMES = {
    "activation": {"noactivation", "nonactivation", "none", "na", "n/a"},
    "product": {"noproduct", "nonproduct", "none", "na", "n/a"},
    "deliverable": {"nodeliverable", "nondeliverable", "none", "na", "n/a"},
}


def is_none_option(option, kind):
    """True when an entity is your site's 'not applicable' placeholder."""
    if not option:
        return True
    slug = re.sub(r"[^a-z0-9]", "", (option.get("name") or "").lower())
    return slug in NONE_NAMES.get(kind, set())


def find_none_option(options, kind):
    """The entity your site uses to mean 'not applicable', if it exists.

    Matched on the name ignoring case, spaces and punctuation, so
    'Non-Product', 'No Product' and 'NONPRODUCT' all count.
    """
    for opt in options or []:
        if is_none_option(opt, kind):
            return opt
    return None


def spaced_words(text):
    """'BrioBro_Partner' -> 'Brio Bro Partner'. Dashes are dropped."""
    text = (text or "").replace("-", " ").replace("_", " ")
    text = re.sub(
        r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])",
        " ", text)
    return " ".join(text.split())


def compose_sequence_name(title, deliverables=(), activation=None,
                          products=()):
    """Build a Sequence name from the filename title and its links.

        title        BrioBro_Partner   -> Brio Bro Partner
        deliverable  End Cards         -> appended straight after
        activation   UFC 331           -> after the dash

    When the Activation is the 'none' placeholder, the Product takes its
    place after the dash instead. When both are placeholders there is no
    dash at all.

        Brio Bro Partner End Cards - UFC 331
    """
    parts = [spaced_words(title)]
    for deliverable in deliverables or []:
        if not is_none_option(deliverable, "deliverable"):
            parts.append((deliverable.get("name") or "").strip())

    suffix = ""
    if activation and not is_none_option(activation, "activation"):
        suffix = (activation.get("name") or "").strip()
    else:
        for product in products or []:
            if not is_none_option(product, "product"):
                suffix = (product.get("name") or "").strip()
                break

    name = " ".join(p for p in parts if p)
    return "%s - %s" % (name, suffix) if suffix else name


def suggest_sequence_name(filename):
    """Propose a Sequence name from a filename.

    BRIO_Tarzann_ChewableEveryday_FineCutColor_v001.mov
        -> "Chewable Everyday - Tarzann"

    Only a suggestion - the user can edit it.
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    parts = stem.split("_")[:-2]          # drop stage and version
    if DROP_BRAND_FROM_KEY and len(parts) > 1:
        parts = parts[1:]                 # drop the brand
    if len(parts) < 2:
        return ""

    campaign, title = parts[0], " ".join(parts[1:])

    def spaced(text):
        # Break camelCase and letter-digit runs into words.
        return re.sub(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)",
                      " ", text).strip()

    return "%s - %s" % (spaced(title), spaced(campaign))


# Aspect-ratio variants. The key on the left is what ends up in the
# Version name; everything on the right is accepted in a filename, in
# any position between the title and the version number. Add aliases
# freely - they cost nothing and save arguments.
FORMATS = {
    "Square": ["square", "sq", "1x1", "1by1"],
}

_FORMAT_LOOKUP = {alias: name
                  for name, aliases in FORMATS.items()
                  for alias in aliases}


# Brands that may appear as the first segment of a filename. Anything
# listed here is stripped before matching, since brand is chosen in the
# dialog rather than read from the name.
BRANDS = ["BRIO", "LAGO"]


def tokenize(text):
    """Break a name into comparable words.

    'PremiumIcePartner' -> ['premium', 'ice', 'partner']
    'Premium Ice Partner - UFC 331' -> ['premium','ice','partner','ufc','331']
    """
    if not text:
        return []
    spaced = re.sub(
        r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])",
        " ", text)
    return [p.lower() for p in re.split(r"[^A-Za-z0-9]+", spaced) if p]


def token_score(query, candidate):
    """How well two token lists overlap, 0 to 1.

    Rewards shared words regardless of order, and tolerates near misses
    ('everday' / 'everyday') so a typo doesn't sink an otherwise obvious
    match.
    """
    if not query or not candidate:
        return 0.0

    remaining = list(candidate)
    matched = 0.0
    for word in query:
        if word in remaining:
            remaining.remove(word)
            matched += 1.0
            continue
        best, best_score = None, 0.0
        for other in remaining:
            ratio = difflib.SequenceMatcher(None, word, other).ratio()
            if ratio > best_score:
                best, best_score = other, ratio
        if best and best_score >= 0.8:
            remaining.remove(best)
            matched += best_score

    precision = matched / len(query)
    recall = matched / len(candidate)
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


def strip_trailing_phrase(tokens, phrases):
    """Drop a known phrase from the end of a token list.

    Sequence names built by this tool read '<title> <deliverable>', so
    the deliverable can be removed before comparing against a filename
    that never carried it. Longest phrase wins, and a name that is
    nothing but the phrase is left alone.
    """
    best = tokens
    for phrase in phrases or []:
        words = tokenize(phrase)
        if not words or len(tokens) <= len(words):
            continue
        if tokens[-len(words):] == words:
            candidate = tokens[:-len(words)]
            if len(candidate) < len(best):
                best = candidate
    return best


CAMPAIGN_MISMATCH = 0.45     # multiplier when the campaigns disagree


def match_score(title, sequence, deliverable_names=(), campaign=""):
    """Score a filename's title against a Sequence, 0 to 1.

    When the campaign is known, a Sequence naming a different one after
    the dash is heavily discounted. Without that, 'Press Conference'
    scores the same against RAF 12 and RAF 13, because only the part
    before the dash was ever compared.
    """
    code = sequence.get("code") or ""
    if " - " in code:
        name_part, suffix = code.split(" - ", 1)
    else:
        name_part, suffix = code, ""

    query = tokenize(title)
    if not query:
        return 0.0

    full_tokens = tokenize(name_part)
    core_tokens = strip_trailing_phrase(full_tokens, deliverable_names)

    # Compare against the name as written, against the name with its
    # deliverable removed, and against the whole label - whichever fits
    # best. That lets Sequence names stay descriptive for people while
    # still matching filenames that carry only the title.
    # A filename that carries the deliverable should beat one that only
    # matches after it has been stripped, so the slight discount keeps
    # the more specific match on top.
    tokens = max(token_score(query, full_tokens),
                 token_score(query, core_tokens) * 0.98,
                 token_score(query, tokenize(code)))

    core_text = " ".join(core_tokens)
    chars = max(
        difflib.SequenceMatcher(
            None, _normalise(title), _normalise(name_part)).ratio(),
        difflib.SequenceMatcher(
            None, _normalise(title), _normalise(core_text)).ratio())

    score = 0.65 * tokens + 0.35 * chars
    if _normalise(title) == _normalise(name_part):
        score = 1.0
    elif _normalise(title) == _normalise(core_text):
        score = 0.98

    if campaign and suffix and _normalise(campaign) != _normalise(suffix):
        score *= CAMPAIGN_MISMATCH
    return score


def scope_sequences(sequences, activation_id=None, product_ids=None):
    """Narrow the pool to one campaign and/or one product.

    Sequences hang off different things - some off an Activation, some
    off a Product for launches and featurettes - so this takes the union
    rather than the intersection. Naming both widens the net instead of
    narrowing it to nothing.
    """
    wanted = set(product_ids or [])
    if not activation_id and not wanted:
        return sequences

    pool = []
    for seq in sequences:
        if activation_id and (seq.get("sg_activations")
                              or {}).get("id") == activation_id:
            pool.append(seq)
            continue
        if wanted and any(p.get("id") in wanted
                          for p in (seq.get("sg_product") or [])):
            pool.append(seq)
    return pool


def is_ambiguous(ranked, margin=0.03):
    """True when the top two candidates are too close to call apart."""
    return len(ranked) >= 2 and (ranked[0][0] - ranked[1][0]) < margin


def rank_by_title(sequences, title, activation_id=None, product_ids=None,
                  deliverable_names=(), campaign="", limit=8,
                  threshold=0.45):
    """Rank Sequences against a filename title, best first.

    Scoping to a campaign or product is what makes loose filenames
    workable: the pool shrinks from the whole project to a handful.
    """
    # No silent widening: if nothing exists under the chosen Activation
    # or Product, the honest answer is "nothing matches", not a list of
    # Sequences from elsewhere in the project.
    pool = scope_sequences(sequences, activation_id, product_ids)

    scored = [(match_score(title, s, deliverable_names, campaign), s)
              for s in pool]
    scored = [(score, s) for score, s in scored if score >= threshold]
    scored.sort(key=lambda pair: (-pair[0], (pair[1].get("code") or "")))
    return scored[:limit]


def is_known_stage(stage, kind="video"):
    """True when a stage is one the tool recognises."""
    stages = STILL_STAGES if kind == "still" else KNOWN_STAGES
    return (stage or "").lower() in {s.lower() for s in stages}


def parse_loose(filename, campaign=""):
    """Parse a filename that may or may not carry brand and campaign.

    Required, from the right:  TITLE _ STAGE _ vNNN
    Optional, on the left:     BRAND _ CAMPAIGN _

    An aspect-ratio marker (Square, Vertical, Story, Wide) may appear
    anywhere between the title and the version. It is pulled out and
    returned separately, so every format of a video shares one key and
    lands on one Sequence.

    Returns (kind, title, stage, format, label). Title is raw, with its
    original capitalisation, because that is what matching reads.
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    ext = os.path.splitext(filename)[1].lower()
    parts = stem.split("_")

    # Spaces are the usual reason a name won't parse, and the generic
    # "expected TITLE_STAGE_vNNN" doesn't point at it.
    if len(parts) < 3 and " " in stem:
        raise ParseError(
            "use underscores, not spaces - this should be %s"
            % stem.replace(" ", "_")
        )

    if ext in STILL_EXTS:
        if len(parts) < 3:
            raise ParseError("expected at least N_N_N")
        triplet = parts[-3:]
        if not all(p.isdigit() for p in triplet):
            raise ParseError('last three segments should be numbers, got "%s"'
                             % "_".join(triplet))
        rest = parts[:-3]
        stages, kind, label = STILL_STAGES, "still", ".".join(triplet)
    else:
        if len(parts) < 3:
            raise ParseError("expected TITLE_STAGE_vNNN")
        version_part, rest = parts[-1], parts[:-1]
        if not version_part.lower().startswith("v") \
                or not version_part[1:].isdigit():
            raise ParseError('last segment "%s" is not a version like v001'
                             % version_part)
        stages, kind = KNOWN_STAGES, "video"
        label = "v%03d" % int(version_part[1:])

    # An aspect-ratio marker may sit on either side of the stage, so look
    # for it by name rather than by position. It never reaches the key,
    # which is what keeps every format on one Sequence.
    fmt = ""
    for i in range(len(rest) - 1, -1, -1):
        found = _FORMAT_LOOKUP.get(rest[i].lower())
        if found:
            fmt = found
            rest = rest[:i] + rest[i + 1:]
            break

    if kind == "still":
        # Stills may be named with nothing but the numbers. The folder
        # they came from stands in as the title, and the artist picks
        # the destination in the tool.
        if not rest:
            folder = os.path.basename(
                os.path.dirname(os.path.abspath(filename)))
            folder = re.sub(r"[^A-Za-z0-9]", "", folder)
            return kind, folder or "Stills", "", "", label
        if len(rest) == 1:
            return kind, rest[0], "", "", label
    elif not rest:
        raise ParseError("nothing left but a stage - expected a title too")

    stage_part, title_parts = rest[-1], rest[:-1]

    lookup = {s.lower(): s for s in stages}
    if stage_part.lower() in lookup:
        stage = lookup[stage_part.lower()]           # normalise the spelling
    elif STRICT_STAGES:
        raise ParseError('unknown stage "%s" - expected one of: %s'
                         % (stage_part, ", ".join(stages)))
    elif not stage_part or stage_part.isdigit():
        raise ParseError('"%s" is not a usable stage' % stage_part)
    else:
        stage = stage_part                            # take it as typed

    # Shed an optional leading brand, then an optional leading campaign.
    if title_parts and title_parts[0].upper() in [b.upper() for b in BRANDS]:
        title_parts = title_parts[1:]
    if (len(title_parts) > 1 and campaign
            and _normalise(title_parts[0]) == _normalise(campaign)):
        title_parts = title_parts[1:]

    if not title_parts:
        raise ParseError("no title left after the brand and campaign")

    return kind, "_".join(title_parts), stage, fmt, label


def version_label(stage, fmt, label):
    """The Version's name in ShotGrid, e.g. 'FineCutColor Square v002'."""
    return " ".join(p for p in (stage, fmt, label) if p)


def _camel(text):
    """'Premium Ice Giveaway' -> 'PremiumIceGiveaway'."""
    return re.sub(r"[^A-Za-z0-9]", "", text or "")


def canonical_name(brand, sequence_code, stage, fmt, label):
    """The Version name, rebuilt to the full convention.

    Whatever anyone typed, the Version ends up named the same way -
    brand and campaign come from the chosen scope and the Sequence it
    matched, not from the filename.

        BRIO_UFC331_PremiumIceGiveaway_Square_FinalCut_v004
    """
    code = sequence_code or ""
    if " - " in code:
        title, campaign = code.split(" - ", 1)
    else:
        title, campaign = code, ""

    parts = [p for p in (brand, _camel(campaign), _camel(title)) if p]
    if fmt:
        parts.append(fmt)
    if stage:
        parts.append(stage)
    parts.append((label or "").replace(".", "_"))
    return "_".join(p for p in parts if p)


def build_key(campaign, title):
    """An internal grouping id - never written to ShotGrid.

    Files that resolve to the same CAMPAIGN_TITLE are handled as one
    group, so you answer any question about a video once rather than
    once per file.
    """
    campaign = _normalise(campaign)
    title = _normalise(title)
    return "%s_%s" % (campaign, title) if campaign else title


def _normalise(text):
    """Strip everything but letters and digits, uppercase."""
    return re.sub(r"[^A-Za-z0-9]", "", text or "").upper()


def split_sequence_name(name):
    """'Chewable Everyday - Tarzann' -> ('TARZANN', 'CHEWABLEEVERYDAY')."""
    if " - " in name:
        before, after = name.split(" - ", 1)
        return _normalise(after), _normalise(before)
    return "", _normalise(name)


def split_key(key):
    """'TARZANN_CHEWABLEEVERYDAY' -> ('TARZANN', 'CHEWABLEEVERYDAY')."""
    parts = [p for p in (key or "").upper().split("_") if p]
    if len(parts) < 2:
        return "", "".join(parts)
    return parts[0], "".join(parts[1:])


def rank_sequences(sequences, key, limit=8, threshold=0.55):
    """Score every Sequence against a file key, best first.

    Works on Sequences that have no file key yet, by reading their name
    instead - which is the whole point, since those are exactly the ones
    that need linking.

    Title similarity carries most of the weight: campaign naming drifts
    ('Tarzann' vs 'The Real Tarzann') far more than titles do.

    Returns [(score, sequence), ...] for anything above threshold.
    """
    our_campaign, our_title = split_key(key)
    if not our_title:
        return []

    scored = []
    for seq in sequences:
        existing = (seq.get("sg_file_key") or "").strip()
        if existing:
            campaign, title = split_key(existing)
        else:
            campaign, title = split_sequence_name(seq.get("code") or "")
        if not title:
            continue

        title_score = difflib.SequenceMatcher(None, our_title, title).ratio()
        if our_campaign and campaign:
            camp_score = difflib.SequenceMatcher(
                None, our_campaign, campaign).ratio()
        else:
            camp_score = 0.0

        score = 0.75 * title_score + 0.25 * camp_score

        # An exact title match is a strong signal whatever the campaign.
        if our_title == title:
            score = max(score, 0.95)

        if score >= threshold:
            scored.append((score, seq))

    scored.sort(key=lambda pair: (-pair[0], (pair[1].get("code") or "")))
    return scored[:limit]


def campaign_defaults(sequences, activation_id=None, product_ids=None):
    """Guess Activation / Product / Deliverable from sibling Sequences.

    Looks at the other Sequences in the same campaign or product and
    returns whatever they most commonly use, so a new Sequence starts
    pre-filled instead of blank.
    """
    siblings = scope_sequences(sequences, activation_id, product_ids)
    if not siblings or siblings is sequences:
        return {}

    out = {"support": {}}

    # Go with whatever the siblings most often use, and record how many
    # of them back it. Demanding unanimity meant one odd Sequence in a
    # campaign stopped the guess entirely, which is most campaigns.
    activations = collections.Counter(
        s["sg_activations"]["id"] for s in siblings if s.get("sg_activations"))
    if activations:
        value, count = activations.most_common(1)[0]
        out["activation_id"] = value
        out["support"]["activation_id"] = (count, sum(activations.values()))

    for field, out_key in [("sg_product", "product_ids"),
                           ("sg_deliverable", "deliverable_ids")]:
        combos = collections.Counter(
            tuple(sorted(e["id"] for e in s[field]))
            for s in siblings if s.get(field))
        if combos:
            value, count = combos.most_common(1)[0]
            out[out_key] = list(value)
            out["support"][out_key] = (count, sum(combos.values()))
        else:
            out.setdefault("missing", []).append(out_key)

    out["based_on"] = len(siblings)
    out["guessed"] = [k for k in ("activation_id", "product_ids",
                                  "deliverable_ids") if k in out]
    return out


def parse_still_filename(filename):
    """Turn a still filename into (key, stage, version_label).

    BRAND_CAMPAIGN_GROUP_STAGE_A_B_C.jpg

    The last three segments are the version triplet, which identifies one
    image within the group. Everything before the stage is the file key,
    shared by every still in the group, so they all land on one Sequence.

        BRIO_RAF12_EventPhotography_Final_2_9_1.jpg
            key     RAF12_EVENTPHOTOGRAPHY
            stage   Final
            label   2.9.1
    """
    stem = os.path.splitext(os.path.basename(filename))[0]
    parts = stem.split("_")

    if len(parts) < MIN_KEY_SEGMENTS + 4:
        raise ParseError(
            "not enough segments - expected "
            "BRAND_CAMPAIGN_GROUP_STAGE_N_N_N"
        )

    triplet = parts[-3:]
    if not all(p.isdigit() for p in triplet):
        raise ParseError(
            'last three segments should be numbers, got "%s"'
            % "_".join(triplet)
        )

    stage_part = parts[-4]
    lookup = {s.lower(): s for s in STILL_STAGES}
    if stage_part.lower() not in lookup:
        raise ParseError(
            'unknown stage "%s" - expected one of: %s'
            % (stage_part, ", ".join(STILL_STAGES))
        )
    stage = lookup[stage_part.lower()]

    key_parts = parts[:-4]
    if DROP_BRAND_FROM_KEY:
        if len(key_parts) < MIN_KEY_SEGMENTS + 1:
            raise ParseError(
                "not enough segments after the brand - expected "
                "BRAND_CAMPAIGN_GROUP_STAGE_N_N_N"
            )
        key_parts = key_parts[1:]

    if len(key_parts) < MIN_KEY_SEGMENTS:
        raise ParseError(
            "file key would be too short (%s) - needs at least %d segments"
            % ("_".join(key_parts), MIN_KEY_SEGMENTS)
        )

    return "_".join(key_parts).upper(), stage, ".".join(triplet)


def parse_any(filename):
    """Parse a video or a still. Returns (kind, key, stage, label)."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in STILL_EXTS:
        key, stage, label = parse_still_filename(filename)
        return "still", key, stage, label
    key, stage, number = parse_filename(filename)
    return "video", key, stage, "v%03d" % number


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def load_prefs():
    try:
        with open(PREFS_FILE) as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_prefs(prefs):
    try:
        with open(PREFS_FILE, "w") as fh:
            json.dump(prefs, fh, indent=2)
    except Exception as err:
        print("  (couldn't save preferences: %s)" % err)


def ask(prompt):
    try:
        return input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        print("\nCancelled.")
        sys.exit(1)


def choose_one(label, options):
    """Pick exactly one entity from a list. Returns an entity dict."""
    print("\n  %s?" % label)
    for i, opt in enumerate(options, 1):
        print("    %d. %s" % (i, opt["name"]))
    while True:
        raw = ask("  > ")
        if raw.isdigit() and 1 <= int(raw) <= len(options):
            picked = options[int(raw) - 1]
            return {"type": picked["type"], "id": picked["id"]}
        print("  Enter a number from 1 to %d." % len(options))


def choose_many(label, options):
    """Pick one or more entities. Returns a list of entity dicts."""
    print("\n  %s?  (comma-separated for several, e.g. 1,3)" % label)
    for i, opt in enumerate(options, 1):
        print("    %d. %s" % (i, opt["name"]))
    while True:
        raw = ask("  > ")
        bits = [b.strip() for b in raw.split(",") if b.strip()]
        if bits and all(b.isdigit() and 1 <= int(b) <= len(options)
                        for b in bits):
            seen, picked = set(), []
            for b in bits:
                opt = options[int(b) - 1]
                if opt["id"] not in seen:
                    seen.add(opt["id"])
                    picked.append({"type": opt["type"], "id": opt["id"]})
            return picked
        print("  Enter one or more numbers from 1 to %d." % len(options))


def is_prores(path):
    """True if ffprobe reports a ProRes video stream."""
    if not shutil.which("ffprobe"):
        return False
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=codec_name", "-of",
             "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=60,
        )
        return "prores" in out.stdout.lower()
    except Exception:
        return False


def make_proxy(path, workdir):
    """Encode an H.264 review copy. Returns the new path, or None."""
    if not shutil.which("ffmpeg"):
        print("    ffmpeg not found - uploading the original instead")
        return None
    out_path = os.path.join(
        workdir, os.path.splitext(os.path.basename(path))[0] + "_proxy.mp4")
    print("    encoding H.264 proxy...")
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", path,
             "-c:v", "libx264", "-crf", PROXY_CRF, "-preset", "medium",
             "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k",
             out_path],
            capture_output=True, text=True,
        )
        if result.returncode != 0 or not os.path.exists(out_path):
            print("    proxy encode failed - uploading the original instead")
            return None
        return out_path
    except Exception as err:
        print("    proxy encode failed (%s) - uploading the original" % err)
        return None


# ---------------------------------------------------------------------------
# ShotGrid lookups
# ---------------------------------------------------------------------------

def get_project(sg):
    return {"type": "Project", "id": PROJECT_ID}


def load_sequences(sg, project):
    """Every Sequence in the project."""
    seqs = sg.find("Sequence",
                   [["project", "is", project]],
                   ["id", "code",
                    "sg_activations", "sg_product", "sg_deliverable"])
    return seqs


def load_entity_options(sg, entity_type, project):
    """Options for a custom entity, project-scoped if possible."""
    try:
        rows = sg.find(entity_type, [["project", "is", project]],
                       ["id", "code"])
    except Exception:
        rows = []
    if not rows:
        try:
            rows = sg.find(entity_type, [], ["id", "code"])
        except Exception:
            rows = []
    out = [{"type": entity_type, "id": r["id"],
            "name": r.get("code") or "(unnamed %d)" % r["id"]}
           for r in rows]
    out.sort(key=lambda r: r["name"].lower())
    return out


def resolve_artist(sg, prefs):
    """The HumanUser to credit on uploads, remembered between runs."""
    login = prefs.get("artist_login")
    if login:
        user = sg.find_one("HumanUser", [["login", "is", login]],
                           ["id", "name"])
        if user:
            return user
        print("Saved login '%s' no longer matches a user." % login)

    while True:
        login = ask("Your ShotGrid login (so uploads are credited to you): ")
        if not login:
            continue
        user = sg.find_one("HumanUser", [["login", "is", login]],
                           ["id", "name"])
        if user:
            prefs["artist_login"] = login
            save_prefs(prefs)
            print("Thanks - crediting uploads to %s\n" % user["name"])
            return user
        print("No user found with that login. Try again.")


def get_or_create_playlist(sg, project, execute):
    """Today's review playlist, created if it doesn't exist."""
    title = datetime.date.today().strftime(PLAYLIST_NAME_FORMAT)
    existing = sg.find_one("Playlist",
                           [["project", "is", project],
                            ["code", "is", title]],
                           ["id", "code"])
    if existing:
        return existing, False
    if not execute:
        return {"type": "Playlist", "id": None, "code": title}, True
    created = sg.create("Playlist", {
        "project": project,
        "code": title,
        "description": "Auto-created by upload_videos.py",
    })
    return created, True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(
        description="Upload video exports to Flow Production Tracking.")
    ap.add_argument("folder", help="Folder containing the exports")
    ap.add_argument("--go", action="store_true",
                    help="Actually make changes (default is a dry run)")
    args = ap.parse_args()

    execute = args.go
    folder = os.path.abspath(os.path.expanduser(args.folder))

    if not os.path.isdir(folder):
        print("Not a folder: %s" % folder)
        sys.exit(1)

    # --- gather files ------------------------------------------------------
    files = sorted(
        os.path.join(folder, f) for f in os.listdir(folder)
        if os.path.splitext(f)[1].lower() in VIDEO_EXTS
        and not f.startswith(".")
    )
    if not files:
        print("No video files found in %s" % folder)
        sys.exit(0)

    # --- parse -------------------------------------------------------------
    parsed, skipped = [], []
    for path in files:
        try:
            key, stage, ver = parse_filename(path)
            parsed.append({"path": path, "key": key,
                           "stage": stage, "version": ver})
        except ParseError as err:
            skipped.append((os.path.basename(path), str(err)))

    print("\nConnecting to Flow Production Tracking...")
    sg = shotgun_api3.Shotgun(SERVER_PATH, SCRIPT_NAME, SCRIPT_KEY)
    project = get_project(sg)
    all_seqs, seq_index = load_sequences(sg, project)
    print("Found %d Sequences in the project (%d with a file key).\n"
          % (len(all_seqs), len(seq_index)))

    # --- group by key ------------------------------------------------------
    groups = {}
    for item in parsed:
        groups.setdefault(item["key"], []).append(item)

    existing_keys = [k for k in groups if k in seq_index]
    new_keys = [k for k in groups if k not in seq_index]

    # --- show the plan -----------------------------------------------------
    print("=" * 64)
    print("DRY RUN - nothing will change" if not execute
          else "LIVE RUN - changes will be made")
    print("=" * 64)
    print("\n%d file(s) parsed, %d skipped\n" % (len(parsed), len(skipped)))

    if existing_keys:
        print("WOULD ADD VERSIONS TO EXISTING SEQUENCES (%d)"
              % len(existing_keys))
        for key in sorted(existing_keys):
            seq = seq_index[key]
            print("  %s" % seq["code"])
            for item in groups[key]:
                print("      <- %s v%03d   (%s)"
                      % (item["stage"], item["version"],
                         os.path.basename(item["path"])))
        print("")

    if new_keys:
        print("WOULD CREATE NEW SEQUENCES (%d)" % len(new_keys))
        known = list(seq_index.keys())
        for key in sorted(new_keys):
            print("  %s" % key)
            for item in groups[key]:
                print("      <- %s v%03d   (%s)"
                      % (item["stage"], item["version"],
                         os.path.basename(item["path"])))
            close = difflib.get_close_matches(key, known, n=3, cutoff=0.8)
            if close:
                print("      !! similar existing key(s): %s"
                      % ", ".join(close))
        print("")

    if skipped:
        print("SKIPPED (%d)" % len(skipped))
        for name, reason in skipped:
            print("  %s\n      %s" % (name, reason))
        print("")

    playlist, playlist_is_new = get_or_create_playlist(sg, project, execute)
    print("Playlist: %s%s\n"
          % (playlist["code"], "  (will be created)"
             if playlist_is_new and not execute else ""))

    if not parsed:
        print("Nothing to do.")
        sys.exit(0)

    if not execute:
        print("Re-run with --go to execute.")
        sys.exit(0)

    # --- confirm -----------------------------------------------------------
    if ask("Proceed? [y/N] ").lower() not in ("y", "yes"):
        print("Cancelled.")
        sys.exit(0)

    prefs = load_prefs()
    artist = resolve_artist(sg, prefs)

    # --- resolve new sequences --------------------------------------------
    activations = products = deliverables = None

    for key in sorted(new_keys):
        print("\n" + "-" * 64)
        print("NEW VIDEO: %s" % key)
        print("  from %s" % os.path.basename(groups[key][0]["path"]))

        close = difflib.get_close_matches(key, list(seq_index.keys()),
                                          n=3, cutoff=0.8)
        if close:
            print("\n  Similar keys already exist:")
            for i, c in enumerate(close, 1):
                print("    %d. %s  ->  %s" % (i, c, seq_index[c]["code"]))
            print("    n. No, this really is a new video")
            raw = ask("  Is this the same video? ")
            if raw.isdigit() and 1 <= int(raw) <= len(close):
                seq_index[key] = seq_index[close[int(raw) - 1]]
                print("  OK - treating as an update.")
                continue

        name = ""
        while not name:
            name = ask("\n  Sequence name (as it should read in ShotGrid): ")

        if activations is None:
            print("\n  Loading options...")
            activations = load_entity_options(sg, ACTIVATION_ENTITY, project)
            products = load_entity_options(sg, PRODUCT_ENTITY, project)
            deliverables = load_entity_options(sg, DELIVERABLE_ENTITY, project)

        data = {"project": project, "code": name, "sg_file_key": key}

        if activations:
            data["sg_activations"] = choose_one("Activation", activations)
        else:
            print("  (no Activations found - leaving blank)")

        if products:
            data["sg_product"] = choose_many("Product", products)
        else:
            print("  (no Products found - leaving blank)")

        if deliverables:
            data["sg_deliverable"] = choose_many("Deliverable", deliverables)
        else:
            print("  (no Deliverables found - leaving blank)")

        created = sg.create("Sequence", data)
        created["code"] = name
        seq_index[key] = created
        print("\n  Created Sequence: %s (id %d)" % (name, created["id"]))

    # --- playlist ----------------------------------------------------------
    if playlist.get("id") is None:
        playlist, _ = get_or_create_playlist(sg, project, True)

    # --- upload ------------------------------------------------------------
    print("\n" + "=" * 64)
    print("UPLOADING")
    print("=" * 64)

    workdir = tempfile.mkdtemp(prefix="sg_proxy_")
    done, failed = 0, []

    try:
        for item in parsed:
            seq = seq_index[item["key"]]
            label = "%s v%03d" % (item["stage"], item["version"])
            print("\n%s  ->  %s" % (os.path.basename(item["path"]),
                                    seq["code"]))

            try:
                version = sg.create("Version", {
                    "project": project,
                    "code": label,
                    "entity": {"type": "Sequence", "id": seq["id"]},
                    "description": "Uploaded from %s"
                                   % os.path.basename(item["path"]),
                    "sg_status_list": NEW_VERSION_STATUS,
                    "sg_path_to_movie": item["path"],
                    "user": {"type": "HumanUser", "id": artist["id"]},
                    "playlists": [{"type": "Playlist", "id": playlist["id"]}],
                })

                upload_path = item["path"]
                if MAKE_PROXY_FOR_PRORES and is_prores(item["path"]):
                    proxy = make_proxy(item["path"], workdir)
                    if proxy:
                        upload_path = proxy

                size_mb = os.path.getsize(upload_path) / (1024.0 * 1024.0)
                print("    uploading %.0f MB..." % size_mb)
                sg.upload("Version", version["id"], upload_path,
                          "sg_uploaded_movie")
                print("    done - Version id %d" % version["id"])
                done += 1

            except Exception as err:
                print("    FAILED: %s" % err)
                failed.append((os.path.basename(item["path"]), str(err)))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    # --- summary -----------------------------------------------------------
    print("\n" + "=" * 64)
    print("%d uploaded, %d failed" % (done, len(failed)))
    if failed:
        for name, err in failed:
            print("  %s\n      %s" % (name, err))
    print("Playlist: %s" % playlist["code"])
    print("Transcoding runs server-side; give it a minute before review.")


if __name__ == "__main__":
    main()
