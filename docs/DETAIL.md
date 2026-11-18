# Google Workspace

Adds Google Drive, Docs, Sheets and Slides to DeepSeek Harness as `google_*` tools: search and read your files, write documents from markdown, fill and append spreadsheets, build slide decks, upload and download.

## Requirements

- A Google Cloud OAuth **Desktop app** client, saved at `~/.dsh/google-workspace/client_secret.json`. Steps: [docs/SETUP-GOOGLE.md](SETUP-GOOGLE.md).
- Then call `google_auth` once to consent in your browser.

## What it requests

Full Drive access plus Docs, Sheets and Slides, because editing existing documents is not possible with a narrower scope. Credentials stay on your machine in `~/.dsh/google-workspace/`.

## Limits

- Google-native files only for rich editing; Office files are read and written as whole files.
- Markdown support covers headings, lists, bold, italic, code and links. Tables and images are not translated.
- Slides are built from titles and bullet points; themes and layouts beyond title and title-and-body are not applied.
