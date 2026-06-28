# GCP Secret Manager for Raycast

Manage [Google Cloud Secret Manager](https://cloud.google.com/secret-manager) secrets directly from [Raycast](https://raycast.com). Create, read, update, delete, and share secrets without leaving your keyboard.

## Features

### List & Search Secrets
Browse all secrets in your GCP project with instant search.

### Copy / Reveal Values
- **Copy Value** — copies the latest version to your clipboard
- **Reveal Value** — shows the value in a detail view (masked by default, toggle to reveal)

### Create & Edit
- **Add Secret** — create a new secret with an optional share-on-create
- **Edit Value** — add a new version to an existing secret

### Share & Manage Access
- **Share Secret** — grant `secretAccessor` IAM access to any Google account
- **View Access** — see who has access, revoke with one action

### Delete
Permanently delete a secret (with confirmation).

## Prerequisites

- [Raycast](https://raycast.com) installed
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install) (`gcloud`) installed and authenticated
- A GCP project with the [Secret Manager API enabled](https://console.cloud.google.com/apis/library/secretmanager.googleapis.com)

## Setup

1. Clone this repo and install dependencies:
   ```bash
   git clone https://github.com/definitelyreal/raycast-gcp-secrets.git
   cd raycast-gcp-secrets
   npm install
   ```

2. Start the dev server:
   ```bash
   npm run dev
   ```

3. On first launch, Raycast will prompt you for:
   - **GCP Project ID** (required) — the project containing your secrets
   - **gcloud Binary Path** (optional) — defaults to `gcloud` on your PATH

## Commands

| Command | Description |
|---------|-------------|
| **Secrets** | List, search, copy, reveal, edit, share, and delete secrets |
| **Add Secret** | Create a new secret with an optional share recipient |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Copy secret value to clipboard |
| `Cmd + Enter` | Reveal secret value |
| `Cmd + E` | Edit (add new version) |
| `Cmd + S` | Share with a Google account |
| `Cmd + I` | View IAM access list |
| `Cmd + Opt + Delete` | Delete secret |

## How It Works

The extension shells out to the `gcloud` CLI under the hood. Secret values are passed via temp files (never as shell arguments) to avoid escaping issues and prevent values from appearing in process listings.

## License

MIT
