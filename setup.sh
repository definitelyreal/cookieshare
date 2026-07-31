#!/bin/bash
# Setup: generate the private, gitignored files from config.local.json:
#   - extension/manifest.json    (template + OAuth client id)
#   - extension/local-config.json ({ "gcpProjectId": ... } read at runtime)
# Run after cloning, or whenever config.local.json changes.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$DIR/config.local.json"
TEMPLATE="$DIR/extension/manifest.template.json"
MANIFEST="$DIR/extension/manifest.json"
LOCAL_CFG="$DIR/extension/local-config.json"

if [ ! -f "$CONFIG" ]; then
  echo "No config.local.json found. Copying from example..."
  cp "$DIR/config.local.json.example" "$CONFIG"
  echo "Edit $CONFIG with your OAuth client ID and GCP project ID, then run this again."
  exit 1
fi

CLIENT_ID=$(python3 -c "import json;print(json.load(open('$CONFIG'))['oauth_client_id'])")
PROJECT_ID=$(python3 -c "import json;print(json.load(open('$CONFIG'))['gcp_project_id'])")

python3 - "$TEMPLATE" "$MANIFEST" "$CLIENT_ID" <<'PY'
import json, sys
template, out, client_id = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(template))
m['oauth2']['client_id'] = client_id
json.dump(m, open(out, 'w'), indent=2); open(out, 'a').write('\n')
PY

python3 - "$LOCAL_CFG" "$PROJECT_ID" <<'PY'
import json, sys
out, project = sys.argv[1], sys.argv[2]
json.dump({"gcpProjectId": project}, open(out, 'w'), indent=2); open(out, 'a').write('\n')
PY

echo "Generated:"
echo "  extension/manifest.json     (client id ${CLIENT_ID:0:18}...)"
echo "  extension/local-config.json (project $PROJECT_ID)"
echo "Reload the extension in chrome://extensions to apply."
