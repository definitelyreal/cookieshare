#!/bin/bash
# Pull session data (cookies + localStorage) from Google Secret Manager
# Usage: pull-cookies.sh <domain> --project <gcp-project-id> [--cookies-only]
#
# Handles both compressed (gzip) and uncompressed payloads.
#
# Examples:
#   pull-cookies.sh superhuman.com --project my-gcp-project
#   pull-cookies.sh superhuman.com --project my-gcp-project --cookies-only
#   pull-cookies.sh superhuman.com --project my-gcp-project | jq '.cookies'

set -euo pipefail

DOMAIN=""
PROJECT=""
COOKIES_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="${2:?--project requires a value}"
      shift 2
      ;;
    --cookies-only)
      COOKIES_ONLY=true
      shift
      ;;
    -*)
      echo "Unknown flag: $1" >&2
      exit 1
      ;;
    *)
      DOMAIN="$1"
      shift
      ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: pull-cookies.sh <domain> --project <gcp-project-id> [--cookies-only]" >&2
  exit 1
fi

if [[ -z "$PROJECT" ]]; then
  # Fall back to env var
  PROJECT="${COOKIESHARE_GCP_PROJECT:-}"
  if [[ -z "$PROJECT" ]]; then
    echo "Error: --project flag or COOKIESHARE_GCP_PROJECT env var is required" >&2
    exit 1
  fi
fi

SECRET_ID="cookie-share-${DOMAIN//./-}"

# Pull latest version from Secret Manager
RAW=$(gcloud secrets versions access latest \
  --secret="$SECRET_ID" \
  --project="$PROJECT" \
  2>/dev/null) || {
  echo "Error: Could not access secret '$SECRET_ID' in project '$PROJECT'" >&2
  echo "Make sure the secret exists and you have access." >&2
  exit 1
}

# Check if compressed — wrapper has { "compressed": "gzip", "data": "..." }
if echo "$RAW" | jq -e '.compressed == "gzip"' >/dev/null 2>&1; then
  DATA=$(echo "$RAW" | jq -r '.data' | base64 -d | gunzip)
else
  DATA="$RAW"
fi

# Output
if [[ "$COOKIES_ONLY" == true ]]; then
  echo "$DATA" | jq '.cookies'
else
  echo "$DATA"
fi
