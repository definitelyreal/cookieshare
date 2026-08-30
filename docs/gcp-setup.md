# GCP Setup Guide

Complete walkthrough for setting up cookieshare with Google Cloud Platform. Takes about 10 minutes.

---

## Prerequisites

- A Google account
- A GCP project (free tier works — Secret Manager gives you 6 active secret versions free)
- Chrome or a Chromium-based browser

If you don't have a GCP project yet, create one at [console.cloud.google.com](https://console.cloud.google.com).

---

## Step 1: Enable the Secret Manager API

1. Go to [Secret Manager API](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com) in your GCP Console
2. Select your project from the dropdown at the top
3. Click **Enable**

> **Or from the command line:**
> ```bash
> gcloud services enable secretmanager.googleapis.com --project=YOUR_PROJECT_ID
> ```

---

## Step 2: Load the Chrome Extension

We need to load the extension first to get its Extension ID, which we'll need for the OAuth setup.

First, generate the private files. `extension/manifest.json` is **not** in the repo — it's built
from `extension/manifest.template.json` plus your `config.local.json`, and it's gitignored:

```bash
cp config.local.json.example config.local.json   # skip if you already have one
./setup.sh
```

Leave `oauth_client_id` as the placeholder for now; you'll fill it in at Step 4.

> If you skip this, Chrome rejects the folder with **"Manifest file is missing or unreadable —
> Could not load manifest."** That means `extension/manifest.json` hasn't been generated yet, not
> that anything is broken. Run `./setup.sh` and load it again.

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo
5. Note the **Extension ID** shown on the card — you'll need this in the next step

> To keep that Extension ID stable across reloads and folder moves, put a base64 public key in
> `extension_key` in `config.local.json` and re-run `./setup.sh`. Otherwise Chrome derives the ID
> from the folder path, and moving the repo changes it — which breaks the redirect URI you're
> about to register.

> The Extension ID is a 32-character string like `abcdefghijklmnopqrstuvwxyz012345`. It's displayed under the extension name on the card.

---

## Step 3: Create an OAuth 2.0 Client ID

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) in your GCP Console
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. If prompted, configure the **OAuth consent screen** first:
   - Choose **External** (unless you have a Workspace org)
   - Fill in the app name (e.g., "cookieshare") and your email
   - Skip scopes — we'll handle this in the manifest
   - Add yourself as a test user
   - Save and go back to creating credentials
4. For Application type, select **Web application**
5. Name it something like "cookieshare extension"
6. Under **Authorized redirect URIs**, click **+ ADD URI** and enter:

   ```
   https://YOUR_EXTENSION_ID.chromiumapp.org/
   ```

   Replace `YOUR_EXTENSION_ID` with the ID from Step 2.

7. Click **Create**
8. Copy the **Client ID** (it looks like `123456789-abcdef.apps.googleusercontent.com`)

---

## Step 4: Configure the Extension

Edit `config.local.json`, not `extension/manifest.json` — the manifest is regenerated from the
template every time you run `./setup.sh`, so hand edits to it are overwritten.

1. Open `config.local.json` in your text editor
2. Set `oauth_client_id` to the Client ID you just copied, and `gcp_project_id` to your project:

   ```json
   {
     "oauth_client_id": "123456789-abcdef.apps.googleusercontent.com",
     "gcp_project_id": "my-gcp-project",
     "extension_key": ""
   }
   ```

3. Run `./setup.sh` again to write the Client ID into `extension/manifest.json` and your project ID
   into `extension/local-config.json`
4. Go back to `chrome://extensions/` and click the **reload** button (circular arrow) on the cookieshare card

---

## Step 5: Set Your GCP Project ID

If you set `gcp_project_id` in `config.local.json` and ran `./setup.sh`, this is already done —
the extension reads it from the generated `extension/local-config.json`. To override it per
browser profile, or if you skipped it:

1. Right-click the cookieshare extension icon → **Options** (or click "Manage Sites" in the popup)
2. Scroll to **Settings**
3. Enter your GCP Project ID
4. Click **Save Settings**

> **Where to find your Project ID:** It's in the GCP Console URL (`console.cloud.google.com/home/dashboard?project=YOUR_PROJECT_ID`) or on the project dashboard page.

---

## Step 6: Grant IAM Permissions

The Google account you'll sign in with (in Chrome) needs permission to create and write secrets.

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:YOUR_EMAIL@gmail.com" \
  --role="roles/secretmanager.admin"
```

> **For production use**, scope this down:
> ```bash
> gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
>   --member="user:YOUR_EMAIL@gmail.com" \
>   --role="roles/secretmanager.secretVersionAdder"
> ```

---

## Step 7: First Sync

1. Navigate to a website you want to sync (make sure you're logged in)
2. Click the cookieshare extension icon
3. Click **Sync This Site**
4. Chrome will ask you to approve host permissions — click **Allow**
5. A Google sign-in popup will appear (first time only) — sign in with the account that has IAM access
6. The popup should now show sync status: cookie count, storage keys, and last sync time

---

## Step 8: Verify It Worked

From your terminal:

```bash
# Make sure you're authenticated with gcloud
gcloud auth login

# Pull the cookies you just synced
./scripts/pull-cookies.sh example.com --project YOUR_PROJECT_ID
```

You should see JSON output with your cookies and localStorage data.

---

## Troubleshooting

### "GCP Project ID not configured"

Open the extension Options page and set your project ID. See [Step 5](#step-5-set-your-gcp-project-id).

### "Failed to create secret: 403"

Your Google account doesn't have Secret Manager permissions. See [Step 6](#step-6-grant-iam-permissions).

### OAuth popup doesn't appear

- Make sure `oauth_client_id` in `config.local.json` matches what you created in GCP, and that you
  re-ran `./setup.sh` afterward (that's what writes it into `extension/manifest.json`)
- Make sure the redirect URI in GCP includes your exact Extension ID
- Reload the extension after re-running `./setup.sh`

### "Manifest file is missing or unreadable" / "Could not load manifest"

`extension/manifest.json` hasn't been generated. It's gitignored and built by `./setup.sh` from
`extension/manifest.template.json` plus `config.local.json`, so it's absent after a fresh clone, a
`git clean -x`, or if the file was deleted. Run `./setup.sh` from the repo root and load the
`extension/` folder again.

### "Payload too large" error

Some sites store massive amounts of data in localStorage. cookieshare compresses with gzip and
automatically trims large values, but if it's still over 64KB, you'll see this error. The cookies
themselves are almost always small enough — the issue is usually localStorage blobs.

### Extension ID changed after reload

If you remove and re-add the extension, the ID may change. Update the redirect URI in GCP Console
to match the new ID.

---

## Setting Up Consumer Access (for scripts on other machines)

If your automation scripts run on a different machine (e.g., a server), that machine needs read
access to the secrets:

### Option A: User credentials

```bash
# On the remote machine
gcloud auth login
./scripts/pull-cookies.sh example.com --project YOUR_PROJECT_ID
```

### Option B: Service account (recommended for servers)

```bash
# Create a service account
gcloud iam service-accounts create cookieshare-reader \
  --display-name="cookieshare reader"

# Grant it secret read access
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:cookieshare-reader@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

# Create and download a key
gcloud iam service-accounts keys create key.json \
  --iam-account=cookieshare-reader@YOUR_PROJECT_ID.iam.gserviceaccount.com

# On the remote machine, authenticate with the key
gcloud auth activate-service-account --key-file=key.json
```
