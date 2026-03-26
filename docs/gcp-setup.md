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

![Enable Secret Manager API](images/01-enable-secret-manager.png)

> **Tip:** You can also do this from the command line:
> ```bash
> gcloud services enable secretmanager.googleapis.com --project=YOUR_PROJECT_ID
> ```

---

## Step 2: Load the Chrome Extension

We need to load the extension first to get its Extension ID, which we'll need for the OAuth setup.

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo

![Load unpacked extension](images/02-load-extension.png)

5. Note the **Extension ID** shown on the card — you'll need this in the next step

![Extension ID](images/03-extension-id.png)

> The Extension ID looks like: `abcdefghijklmnopqrstuvwxyz012345`

---

## Step 3: Create an OAuth 2.0 Client ID

1. Go to [APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials) in your GCP Console
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**

![Create credentials](images/04-create-credentials.png)

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

![OAuth redirect URI](images/05-oauth-redirect-uri.png)

7. Click **Create**
8. Copy the **Client ID** (it looks like `123456789-abcdef.apps.googleusercontent.com`)

![Copy client ID](images/06-copy-client-id.png)

---

## Step 4: Configure the Extension

1. Open `extension/manifest.json` in your text editor
2. Replace `YOUR_CLIENT_ID_HERE.apps.googleusercontent.com` with the Client ID you just copied:

   ```json
   "oauth2": {
     "client_id": "123456789-abcdef.apps.googleusercontent.com",
     "scopes": [
       "https://www.googleapis.com/auth/cloud-platform"
     ]
   }
   ```

3. Go back to `chrome://extensions/` and click the **reload** button on the cookieshare card

![Reload extension](images/07-reload-extension.png)

---

## Step 5: Set Your GCP Project ID

1. Right-click the cookieshare extension icon → **Options** (or click "Manage Sites" in the popup)
2. Scroll to **Settings**
3. Enter your GCP Project ID
4. Click **Save Settings**

![Set project ID](images/08-set-project-id.png)

> **Where to find your Project ID:** It's in the GCP Console URL (`console.cloud.google.com/home/dashboard?project=YOUR_PROJECT_ID`) or on the project dashboard page.

---

## Step 6: Grant IAM Permissions

The Google account you'll sign in with (in Chrome) needs permission to create and write secrets.

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="user:YOUR_EMAIL@gmail.com" \
  --role="roles/secretmanager.admin"
```

![IAM permissions](images/09-iam-permissions.png)

> **For production use**, scope this down:
> ```bash
> # Create a custom role with just what's needed
> gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
>   --member="user:YOUR_EMAIL@gmail.com" \
>   --role="roles/secretmanager.secretVersionAdder"
> ```

---

## Step 7: First Sync

1. Navigate to a website you want to sync (make sure you're logged in)
2. Click the cookieshare extension icon
3. Click **Sync This Site**

![Sync this site](images/10-sync-this-site.png)

4. Chrome will ask you to approve host permissions — click **Allow**
5. A Google sign-in popup will appear (first time only) — sign in with the account that has IAM access

![Google sign-in](images/11-google-signin.png)

6. The popup should now show sync status: cookie count, storage keys, and last sync time

![Sync success](images/12-sync-success.png)

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

- Make sure the Client ID in `manifest.json` matches what you created in GCP
- Make sure the redirect URI in GCP includes your exact Extension ID
- Reload the extension after changing `manifest.json`

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

---

## Taking Screenshots for This Guide

> **For contributors:** If you're updating this guide, take screenshots at 2x resolution
> (Retina) and save as PNG. Use the browser at a standard width (~1200px). Crop to show just
> the relevant UI, not the full browser window. Save to `docs/images/`.

Screenshots needed:
1. `01-enable-secret-manager.png` — Secret Manager API page with Enable button
2. `02-load-extension.png` — chrome://extensions with Load unpacked button
3. `03-extension-id.png` — Extension card showing the ID
4. `04-create-credentials.png` — Credentials page with Create button
5. `05-oauth-redirect-uri.png` — OAuth form with redirect URI filled in
6. `06-copy-client-id.png` — Dialog showing the new Client ID
7. `07-reload-extension.png` — Extension card with reload button
8. `08-set-project-id.png` — Options page Settings section
9. `09-iam-permissions.png` — Terminal showing gcloud IAM command
10. `10-sync-this-site.png` — Extension popup with Sync This Site button
11. `11-google-signin.png` — Google OAuth consent screen
12. `12-sync-success.png` — Extension popup showing successful sync
