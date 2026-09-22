#!/bin/bash
# Double-click to open the uploader.
cd "$(dirname "$0")"
source venv/bin/activate
python3 flow_uploader.py
