#!/usr/bin/env bash
# ============================================================
# tail-debugger.sh — Stream Twilio debugger logs
# ============================================================
# Usage: ./tail-debugger.sh -p <profile>
# ============================================================
set -euo pipefail

PROFILE=""
STREAMING=true

usage() {
  echo "Usage: $0 -p <profile> [--snapshot]"
  echo ""
  echo "  -p         Twilio CLI profile (required)"
  echo "  --snapshot One-time dump instead of continuous streaming"
  exit 1
}

for arg in "$@"; do
  if [[ "$arg" == "--snapshot" ]]; then
    STREAMING=false
  fi
done

while getopts "p:h" opt; do
  case $opt in
    p) PROFILE="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [[ -z "$PROFILE" ]]; then
  echo "❌ ERROR: -p <profile> is required"
  usage
fi

if [[ "$STREAMING" == true ]]; then
  echo "📡 Streaming debugger logs for profile: $PROFILE"
  echo "   Press Ctrl+C to stop"
  echo "---"
  twilio debugger:logs:list -p "$PROFILE" --streaming
else
  echo "📋 Debugger log snapshot for profile: $PROFILE"
  echo "---"
  twilio debugger:logs:list -p "$PROFILE" -o json
fi
