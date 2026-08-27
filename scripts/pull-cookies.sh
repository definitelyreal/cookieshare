#!/bin/bash
# Pull session data (cookies + localStorage + captured auth headers) from
# Google Secret Manager.
#
# Usage: pull-cookies.sh <domain> --project <gcp-project-id> [flag]
#   --cookies-only     Output just the cookies array
#   --auth-only        Output just the captured Authorization headers map
#   --token [<host>]   Output just the raw Authorization header value
#                      (picks the domain's host if --token has no argument)
#   --slack [<team>]   Output "<xoxc-token>\t<xoxd-cookie>" for a Slack workspace
#                      (the pair slackdump/slack-api clients need; team defaults
#                      to the first captured workspace)
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
SLACK_MODE=false
SLACK_TEAM=""

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
    --slack)
      SLACK_MODE=true
      shift
      if [[ $# -gt 0 && "$1" != -* && "$1" != *.* ]]; then
        SLACK_TEAM="$1"
        shift
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
elif [[ "$SLACK_MODE" == true ]]; then
  # xoxc token: extracted by the extension from localConfig_v2 into a compact
  # synthetic localStorage key (the raw config is far over the size cap).
  TOK=$(echo "$DATA" | jq -r --arg t "$SLACK_TEAM" '
    ((.localStorage // {}) | to_entries
      | map(select(.value.__cookieshare_slack_tokens__))
      | .[0].value.__cookieshare_slack_tokens__ // empty) as $raw
    | if $raw == null or $raw == "" then empty
      else ($raw | fromjson) as $m
        | if $t == "" then ($m | to_entries | .[0].value) else ($m[$t] // empty) end
      end')
  CK=$(echo "$DATA" | jq -r '(.cookies // []) | map(select(.name == "d")) | .[0].value // empty')
  if [[ -z "$CK" ]]; then
    echo "Error: no 'd' cookie in secret '$SECRET_ID' — is the Slack session synced?" >&2
    exit 1
  fi
  if [[ -z "$TOK" ]]; then
    echo "Error: no xoxc token captured for '$SECRET_ID'." >&2
    echo "The extension only captures it while a Slack tab is OPEN in Chrome (and needs" >&2
    echo "extension >= 1.3.0, which extracts it from localConfig_v2). Open Slack in Chrome," >&2
    echo "let a sync run, then retry. Available teams:" >&2
    echo "$DATA" | jq -r '((.localStorage // {}) | to_entries | map(select(.value.__cookieshare_slack_tokens__)) | .[0].value.__cookieshare_slack_tokens__ // "{}") | fromjson | keys[]' >&2
    exit 1
  fi
  printf '%s\t%s\n' "$TOK" "$CK"
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
