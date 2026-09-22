#!/usr/bin/env python3
"""Generate test/fixtures.json from upload_videos.py itself.

The web app's src/lib/naming.ts is a port of upload_videos.py, and
test/parity.test.ts checks the port against this file. Re-run after
changing either side:

    python3 web/scripts/gen_fixtures.py

upload_videos.py imports shotgun_api3 and config at the top; neither is
needed for the pure functions, so both are stubbed.
"""

import difflib
import json
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, ROOT)
sys.modules.setdefault("shotgun_api3", types.ModuleType("shotgun_api3"))
config = types.ModuleType("config")
config.SERVER_PATH = config.SCRIPT_NAME = config.SCRIPT_KEY = ""
config.PROJECT_ID = 0
sys.modules["config"] = config

import upload_videos as uv  # noqa: E402

FILENAMES = [
    "BRIO_UFC331_PremiumIceGiveaway_FinalCut_v4.mov",
    "PremiumIceGiveaway_FinalCut_v4.mov",
    "PremiumIceGiveaway_Square_FinalCut_v4.mov",
    "PremiumIceGiveaway_FinalCut_sq_V04.mp4",
    "LAGO_RAF13_PressConference_RoughCutColor_v0012.m4v",
    "brio_Tarzann_ChewableEveryday_finecutcolor_v001.mov",
    "Premium Ice Giveaway FinalCut v4.mov",
    "Premium_Ice Giveaway_v4.mov",
    "Title_Weirdstage_v2.mov",
    "Title_12_v2.mov",
    "Title_FinalCut_final.mov",
    "FinalCut_v3.mov",
    "BRIO_FinalCut_v3.mov",
    "Square_FinalCut_v3.mov",
    "A_B_C_1x1_Cut_v10.mov",
    "EventPhotography_Final_2_9_1.jpg",
    "BRIO_RAF12_EventPhotography_Selects_1_2_3.TIFF",
    "2_9_1.jpg",
    "Headshots_4_5_6.png",
    "Headshots_Square_4_5_6.png",
    "Event_Final_2_x_1.jpg",
    "1_2.jpg",
    "ThisHasNoUnderscores.mov",
    "UFC331_PremiumIceGiveaway_Final_v1.mov",
    "UFC_331_PremiumIceGiveaway_Final_v1.mov",
]

CAMPAIGNS = ["", "UFC331", "UFC 331", "RAF12"]

SEQUENCES = [
    {"id": 1, "code": "Premium Ice Giveaway - UFC 331",
     "sg_activations": {"type": "CustomEntity01", "id": 10, "name": "UFC 331"},
     "sg_product": [], "sg_deliverable": []},
    {"id": 2, "code": "Premium Ice Giveaway End Cards - UFC 331",
     "sg_activations": {"type": "CustomEntity01", "id": 10, "name": "UFC 331"},
     "sg_product": [], "sg_deliverable": []},
    {"id": 3, "code": "Press Conference - RAF 12",
     "sg_activations": {"type": "CustomEntity01", "id": 12, "name": "RAF 12"},
     "sg_product": [], "sg_deliverable": []},
    {"id": 4, "code": "Press Conference - RAF 13",
     "sg_activations": {"type": "CustomEntity01", "id": 13, "name": "RAF 13"},
     "sg_product": [], "sg_deliverable": []},
    {"id": 5, "code": "Chewable Everyday Launch",
     "sg_activations": None,
     "sg_product": [{"type": "CustomEntity02", "id": 20, "name": "Chewable"}],
     "sg_deliverable": []},
    {"id": 6, "code": "Premium Ice Giveaway Square - UFC 331",
     "sg_activations": {"type": "CustomEntity01", "id": 10, "name": "UFC 331"},
     "sg_product": [{"type": "CustomEntity02", "id": 21, "name": "Ice"}],
     "sg_deliverable": []},
    {"id": 7, "code": "Event Photography - RAF 12",
     "sg_activations": {"type": "CustomEntity01", "id": 12, "name": "RAF 12"},
     "sg_product": [], "sg_deliverable": []},
    {"id": 8, "code": None, "sg_activations": None,
     "sg_product": None, "sg_deliverable": None},
    {"id": 9, "code": "Premium Everday Partner",
     "sg_activations": None,
     "sg_product": [{"type": "CustomEntity02", "id": 21, "name": "Ice"}],
     "sg_deliverable": []},
]

DELIVERABLES = ["End Cards", "Social Cutdowns", "Square"]

TITLES = [
    "PremiumIceGiveaway", "PremiumIceGiveaway_Square",
    "PremiumIceGiveawayEndCards", "PressConference", "ChewableEveryday",
    "EventPhotography", "PremiumEverydayPartner", "premium_ice",
    "Totally_Unrelated", "", "UFC331",
]

SCOPES = [
    (None, None), (10, None), (12, None), (None, [20]), (None, [21]),
    (10, [20]), (99, None),
]

RATIO_PAIRS = [
    ("everday", "everyday"), ("abc", "abc"), ("", ""), ("a", ""),
    ("PREMIUMICEGIVEAWAY", "PREMIUMICEGIVEAWAYENDCARDS"),
    ("pressconference", "pressconferance"), ("tarzann", "therealtarzann"),
    ("abcd", "bcda"), ("aaaaabbbb", "ababababa"),
    ("x" * 150 + "y" * 60, "y" * 70 + "x" * 140),
    ("the quick brown fox " * 12, "a quick brown dog jumps " * 11),
]


def parse(name, campaign, folder):
    try:
        path = os.path.join("/exports", folder, name) if folder \
            else os.path.join("/", name)
        kind, title, stage, fmt, label = uv.parse_loose(path, campaign)
        return {"ok": [kind, title, stage, fmt, label]}
    except uv.ParseError as err:
        return {"error": str(err)}


def main():
    out = {"sequences": SEQUENCES, "deliverables": DELIVERABLES}

    out["ratio"] = [[a, b, difflib.SequenceMatcher(None, a, b).ratio()]
                    for a, b in RATIO_PAIRS]
    out["tokenize"] = [[t, uv.tokenize(t)] for t in
                       TITLES + [s["code"] or "" for s in SEQUENCES]]

    out["parse"] = []
    for name in FILENAMES:
        for campaign in CAMPAIGNS:
            for folder in ["", "Night 2 - Red Carpet!"]:
                out["parse"].append([name, campaign, folder,
                                     parse(name, campaign, folder)])

    out["match"] = []
    for title in TITLES:
        for seq in SEQUENCES:
            for campaign in ["", "UFC 331", "RAF 13"]:
                out["match"].append([title, seq["id"], campaign,
                                     uv.match_score(title, seq, DELIVERABLES,
                                                    campaign)])

    out["rank"] = []
    for title in TITLES:
        for act, prods in SCOPES:
            for campaign in ["", "UFC 331"]:
                ranked = uv.rank_by_title(SEQUENCES, title, act, prods,
                                          DELIVERABLES, campaign)
                out["rank"].append([title, act, prods, campaign,
                                    [[s, q["id"]] for s, q in ranked],
                                    uv.is_ambiguous(ranked)])

    out["canonical"] = []
    for brand in ["BRIO", ""]:
        for code in ["Premium Ice Giveaway - UFC 331", "Plain Title", "",
                     "A - B - C"]:
            for stage, fmt, label in [("FinalCut", "", "v004"),
                                      ("Final", "Square", "2.9.1"),
                                      ("", "", "1.2.3")]:
                out["canonical"].append(
                    [brand, code, stage, fmt, label,
                     uv.canonical_name(brand, code, stage, fmt, label)])

    out["key"] = [[c, t, uv.build_key(c, t)] for c in CAMPAIGNS
                  for t in TITLES]

    path = os.path.join(HERE, "..", "test", "fixtures.json")
    with open(path, "w") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print("wrote %s" % os.path.normpath(path))


if __name__ == "__main__":
    main()
