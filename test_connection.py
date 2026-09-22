#!/usr/bin/env python3
"""Print every project on the site. Run this first to check config.py."""

import shotgun_api3

from config import SERVER_PATH, SCRIPT_NAME, SCRIPT_KEY

sg = shotgun_api3.Shotgun(SERVER_PATH, SCRIPT_NAME, SCRIPT_KEY)

for project in sg.find("Project", [], ["name"]):
    print(project["id"], project["name"])
