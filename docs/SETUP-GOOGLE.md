# Set up Google access

You need one Google Cloud project with an OAuth client. It is free and takes about five minutes. You do this once per machine (the OAuth client lives in a file; the token refreshes itself).

## 1. Create or choose a project

Open the [Google Cloud Console](https://console.cloud.google.com/projectcreate) and create a project (any name, for example `dsh-google`). Or pick a project you already own.

## 2. Enable the four APIs

Open each link and press **Enable**:

- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- [Google Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
- [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
- [Google Slides API](https://console.cloud.google.com/apis/library/slides.googleapis.com)

If you skip one, that tool family fails with `accessNotConfigured`.

## 3. Configure the consent screen

Open **APIs & Services → [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent)**:

1. User type: **External** → *Create*.
2. App name: anything recognizable, e.g. `DSH Google Workspace`.
3. User support email and developer contact email: your own address.
4. Save. On the next page, add **your own Google address** under **Test users**.

You stay in *Testing* mode at this point, which works but expires refresh tokens after 7 days. See [Keep the token alive](#keep-the-token-alive).

## 4. Create the OAuth client

**APIs & Services → [Credentials](https://console.cloud.google.com/apis/credentials)** → **Create credentials → OAuth client ID**:

- Application type: **Desktop app**
- Name: anything, e.g. `DSH Desktop`

Press **Create**, then **Download JSON**. The file is named `client_secret_*.apps.googleusercontent.com.json`.

## 5. Save the client where DSH can read it

```bash
mkdir -p ~/.dsh/google-workspace
mv ~/Downloads/client_secret_*.apps.googleusercontent.com.json ~/.dsh/google-workspace/client_secret.json
```

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\google-workspace"
Move-Item "$env:USERPROFILE\Downloads\client_secret_*.json" "$env:USERPROFILE\.dsh\google-workspace\client_secret.json"
```

Alternatively, skip the file entirely: call `google_auth` with `client_json` set to the file's contents.

## 6. Authorize

Ask your DSH agent to connect Google, or call the tool yourself:

```
google_auth
```

DSH opens a consent page. You will see **"Google hasn't verified this app"** because the app belongs to you and is unverified — press **Advanced → Continue (unsafe)**, then allow the four permissions.

The tool reports the signed-in address. `google_whoami` confirms it later.

## Keep the token alive

In *Testing* mode Google expires refresh tokens 7 days after issue, so you re-authorize weekly. To stop that, move the app to production:

1. Fill **Branding**: app name, support email, and a homepage plus privacy policy URL on a domain you control.
2. **Audience → Publish app**.

Google requires those two URLs to sit on a domain verified in [Search Console](https://search.google.com/search-console) for *your* account, which is why this step costs a few minutes the first time. Once published, the token no longer expires and the unverified-app warning stays.

If publishing is not worth it, keep Testing mode: re-running `google_auth` takes seconds.

## Re-authorizing or revoking

| Goal | Action |
|---|---|
| Sign in again (new account, expired token) | `google_auth` |
| Revoke this machine's access | [myaccount.google.com/permissions](https://myaccount.google.com/permissions) → remove the app |
| Forget everything locally | delete `~/.dsh/google-workspace/` |

## Where files go

| File | Purpose |
|---|---|
| `~/.dsh/google-workspace/client_secret.json` | Your OAuth client (per machine) |
| `~/.dsh/google-workspace/token.json` | Refresh token, written `600` after consent |

Set `GWS_STATE_DIR` to move both elsewhere, for example when running DSH as a different user.

## Scopes requested

```
drive, documents, spreadsheets, presentations
```

`drive` is full read/write because the plugin can edit, move, share and trash files you already own. There is no narrower scope that still allows editing your existing documents.
