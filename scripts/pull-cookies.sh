#!/bin/bash
# Pull session data (cookies + localStorage + captured auth headers) from
# Google Secret Manager.
#
# Usage: pull-cookies.sh <domain> --project <gcp-project-id> [flag]
#   --cookies-only     Output just the cookies array
#   --auth-only        Output just the captured Authorization headers map
#   --token [<host>]   Output just the raw Authorization header value
#                      (picks the domain's host if --token has no argument)
#
# Handles both compressed (gzip) and uncompressed payloads.
#
# Examples:
#   pull-cookies.sh github.com --project my-gcp-project
#   pull-cookies.sh github.com --project my-gcp-project --cookies-only
#   pull-cookies.sh discord.com --project my-gcp-project --auth-only
#   pull-cookies.sh discord.com --project my-gcp-project --token

set -euo pipefail

DOMAIN=""
PROJECT=""
COOKIES_ONLY=false
AUTH_ONLY=false
TOKEN_MODE=false
TOKEN_HOST=""

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
    --auth-only)
      AUTH_ONLY=true
      shift
      ;;
    --token)
      TOKEN_MODE=true
      shift
      # Optional host argument
      if [[ $# -gt 0 && "$1" != -* ]]; then
        # If the next arg doesn't look like a domain (no dot) treat it as DOMAIN
        if [[ "$1" == *.* ]]; then
          TOKEN_HOST="$1"
          shift
        fi
      fi
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
elif [[ "$AUTH_ONLY" == true ]]; then
  echo "$DATA" | jq '.authHeaders // .bearerTokens // {}'
elif [[ "$TOKEN_MODE" == true ]]; then
  HOST="${TOKEN_HOST:-$DOMAIN}"
  # Prefer new authHeaders.raw; fall back to legacy bearerTokens.token
  TOKEN=$(echo "$DATA" | jq -r \
    --arg h "$HOST" \
    --arg d "$DOMAIN" \
    '(.authHeaders[$h].raw
      // .authHeaders[$d].raw
      // (.authHeaders // {} | to_entries | map(select(.key | endswith($d))) | .[0].value.raw)
      // .bearerTokens[$h].token
      // .bearerTokens[$d].token
      // (.bearerTokens // {} | to_entries | map(select(.key | endswith($d))) | .[0].value.token)
      // empty)')
  if [[ -z "$TOKEN" ]]; then
    echo "Error: No captured auth header found for host '$HOST' in secret '$SECRET_ID'" >&2
    echo "Available hosts:" >&2
    echo "$DATA" | jq -r '(.authHeaders // .bearerTokens // {}) | keys[]' >&2
    exit 1
  fi
  echo "$TOKEN"
else
  echo "$DATA"
fi
