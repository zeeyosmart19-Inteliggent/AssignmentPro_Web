#!/bin/bash
cd "$(dirname "$0")"
if command -v node >/dev/null 2>&1; then node server.mjs
elif command -v python3 >/dev/null 2>&1; then
  echo "Node.js was not found, so AssignmentPro will start in SINGLE-DEVICE mode (data is not shared between devices)."
  echo "For the shared server, install Node 20+ from https://nodejs.org and run this again."
  python3 serve.py
else echo "Please install Node.js 20+ from https://nodejs.org and run this again."; read -p "Press Enter to close"; fi
