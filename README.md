# DSH Google Workspace

Google Drive, Docs, Sheets and Slides tools for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

Your agent can search your Drive, read and write Google Docs, fill Sheets, build Slides decks, upload and download files — as native DSH tools named `google_*`.

You bring your own Google Cloud OAuth client, so your data never passes through anyone else's server. The plugin runs inside DSH; there is no sidecar, no Docker, and nothing to keep running.

## Install

The plugin is a DSH bundle. Install it by spec, either from the **Plugins** page in DSH or by asking your DSH agent:

```
github:smartwhatt/dsh-google-workspace
```

The bundle activates immediately and its 20 `google_*` tools appear in the session. If they do not, restart DSH (a replaced package always needs a fresh process).

<details>
<summary>From a local checkout (development)</summary>

```bash
git clone https://github.com/smartwhatt/dsh-google-workspace.git
cd dsh-google-workspace && npm install
```

Add the directory with **Plugins → Add plugin**, or ask your agent to install the bundle from that absolute path.
</details>

## Set up Google (about 5 minutes, once)

Full walkthrough with every click: [docs/SETUP-GOOGLE.md](docs/SETUP-GOOGLE.md). The short version:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create or pick a project.
2. Enable the Drive, Docs, Sheets and Slides APIs.
3. Configure the OAuth consent screen (External, add yourself as a test user).
4. Create an **OAuth client ID** of type **Desktop app** and download the JSON.
5. Save that JSON as:
   - macOS/Linux: `~/.dsh/google-workspace/client_secret.json`
   - Windows: `%USERPROFILE%\.dsh\google-workspace\client_secret.json`

Then ask the agent to connect:

> connect google

It calls `google_auth`, opens the consent page in your browser, and waits for approval. You can also paste the client JSON directly into that tool.

## Tools

| Tool | What it does |
|---|---|
| `google_auth` | Connect (or re-connect) your Google account |
| `google_whoami` | Linked account and Drive storage usage |
| `google_drive_search` | Full-text or Drive-query search, newest first |
| `google_drive_get` | Metadata and sharing for one file |
| `google_drive_read` | Docs → markdown, Sheets → CSV, Slides → outline, text files → raw |
| `google_drive_download` | Export to docx/xlsx/pptx/pdf/csv/md, or download any file |
| `google_drive_upload` | Upload a local file, optionally converting it to a Google format |
| `google_drive_mkdir`, `google_drive_move`, `google_drive_trash`, `google_drive_share` | Organize and share |
| `google_docs_create`, `google_docs_append`, `google_docs_replace` | Write Google Docs from markdown |
| `google_sheets_read`, `google_sheets_write`, `google_sheets_append`, `google_sheets_create` | Read and write cell values |
| `google_slides_create`, `google_slides_read` | Build decks from titles and bullets |

Example prompts that work:

- "Find the Q3 budget sheet and summarise the variance column."
- "Turn these meeting notes into a Google Doc in my Projects folder."
- "Make a 3-slide deck from this outline, title slide included."
- "Append today's numbers to the metrics sheet."

## Security and privacy

- **Permissions:** the plugin requests full Drive plus Docs, Sheets and Slides scopes, because editing any file you can see requires it. A token with those scopes can also trash or share files — the agent is told to confirm destructive actions, but treat this as a real capability, not a sandbox.
- **Where credentials live:** an OAuth client file and a refresh token in `~/.dsh/google-workspace/`, mode `600`. Nothing is sent anywhere except Google's APIs.
- **Revoke:** remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) or call `google_auth` again to re-consent. Delete the folder to forget this machine entirely.
- Override the location with `GWS_STATE_DIR=/some/path` if you keep credentials elsewhere.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No Google OAuth client saved yet` | Complete step 5 above, then call `google_auth`. |
| `Google Workspace is not authorized yet` | Call `google_auth`. |
| `invalid_grant` | Token revoked or expired — call `google_auth` again. |
| Consent page warns "Google hasn't verified this app" | Expected for a personal app: *Advanced → Continue*. Publish the consent screen to stop weekly re-consent (see [SETUP-GOOGLE.md](docs/SETUP-GOOGLE.md#keep-the-token-alive)). |
| `accessNotConfigured` | The matching API is not enabled for your Cloud project. |
| Tools missing after install | Restart DSH; a newly installed plugin module needs a fresh process. |
| `EADDRINUSE` during auth | Port 8765 is busy: set `GWS_AUTH_PORT=8766` and restart DSH. |

## Development

```bash
npm install
npm test          # registers the tools on a fake ctx, then exercises the real API
```

`npm test` needs an authorized account and creates then trashes its own Drive files.

Layout: `index.js` (registration), `src/tools.js` (tool definitions and handlers), `src/markdown.js` (markdown → Docs requests), `src/core.js` (OAuth, token store, Drive helpers).

## License

MIT — see [LICENSE](LICENSE).
