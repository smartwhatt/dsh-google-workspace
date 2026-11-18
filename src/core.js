import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

/** `<DSH_HOME>/google-workspace`, unless a checkout already holds credentials. */
export function resolveStateDir() {
  if (process.env.GWS_STATE_DIR) return path.resolve(process.env.GWS_STATE_DIR);
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const shared = path.join(dshHome, 'google-workspace');
  const local = path.join(packageRoot, 'state');
  // A checkout that already authorized keeps its token instead of being reset.
  if (fs.existsSync(path.join(shared, 'token.json')) || !fs.existsSync(path.join(local, 'token.json'))) {
    return shared;
  }
  return local;
}

export const STATE_DIR = resolveStateDir();
export const CLIENT_PATH = path.join(STATE_DIR, 'client_secret.json');
export const TOKEN_PATH = path.join(STATE_DIR, 'token.json');

export const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
];

export function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

/** Accepts a full installed-app client file, or a bare {client_id, client_secret}. */
export function parseClientSecret(raw) {
  let json = raw;
  for (let depth = 0; depth < 2 && typeof json === 'string'; depth += 1) {
    try {
      json = JSON.parse(json);
    } catch {
      throw new Error('the OAuth client file is not valid JSON');
    }
  }
  const conf = json.installed ?? json.web ?? json;
  const clientId = conf.client_id ?? conf.clientId;
  const clientSecret = conf.client_secret ?? conf.clientSecret;
  if (!clientId || !clientSecret) throw new Error('the OAuth client file has no client_id/client_secret');
  return { clientId, clientSecret, projectId: conf.project_id ?? conf.projectId ?? null };
}

export function loadClientSecret() {
  if (process.env.GWS_CLIENT_SECRET_JSON) return parseClientSecret(process.env.GWS_CLIENT_SECRET_JSON);
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(
      `No Google OAuth client saved yet. Put your Desktop OAuth client JSON at ${CLIENT_PATH}, then run the google_auth tool.`,
    );
  }
  return parseClientSecret(fs.readFileSync(CLIENT_PATH, 'utf8'));
}

export function saveClientSecret(raw) {
  ensureStateDir();
  const parsed = parseClientSecret(raw);
  const normalised = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const content = typeof normalised === 'string' ? normalised : JSON.stringify(normalised, null, 2);
  fs.writeFileSync(CLIENT_PATH, content, { mode: 0o600 });
  return parsed;
}

export function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function saveToken(tokens) {
  ensureStateDir();
  const merged = { ...(loadToken() ?? {}), ...tokens };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return merged;
}

export function clearToken() {
  if (fs.existsSync(TOKEN_PATH)) fs.rmSync(TOKEN_PATH);
}

export const REDIRECT_PORT = Number(process.env.GWS_AUTH_PORT ?? 8765);
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;

export function createOAuthClient(redirectUri = REDIRECT_URI) {
  const { clientId, clientSecret } = loadClientSecret();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

let cachedAuth = null;
let cachedKey = '';

export function getAuth() {
  const token = loadToken();
  if (!token) throw new Error('Google Workspace is not authorized yet. Call the google_auth tool to sign in.');
  const key = token.refresh_token ?? token.access_token ?? '';
  if (cachedAuth && cachedKey === key) return cachedAuth;
  const client = createOAuthClient();
  client.setCredentials(token);
  client.on('tokens', (tokens) => saveToken(tokens));
  cachedAuth = client;
  cachedKey = key;
  return client;
}

export function services() {
  const auth = getAuth();
  return {
    auth,
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
    slides: google.slides({ version: 'v1', auth }),
  };
}

export async function accountInfo() {
  const { drive } = services();
  const { data } = await drive.about.get({
    fields: 'user(emailAddress,displayName),storageQuota(limit,usage)',
  });
  return {
    email: data.user?.emailAddress,
    name: data.user?.displayName,
    storage: {
      limit_bytes: data.storageQuota?.limit ?? null,
      usage_bytes: data.storageQuota?.usage ?? null,
    },
  };
}

export const GOOGLE_DOC = 'application/vnd.google-apps.document';
export const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
export const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';
export const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

export const EXPORT_MAP = {
  [GOOGLE_DOC]: {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    html: 'text/html',
  },
  [GOOGLE_SHEET]: {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    pdf: 'application/pdf',
  },
  [GOOGLE_SLIDES]: {
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pdf: 'application/pdf',
    txt: 'text/plain',
  },
};

export function defaultExportKind(mimeType) {
  if (mimeType === GOOGLE_DOC) return 'docx';
  if (mimeType === GOOGLE_SHEET) return 'xlsx';
  if (mimeType === GOOGLE_SLIDES) return 'pptx';
  return null;
}

export function driveId(input) {
  if (!input) throw new Error('A file id or Google URL is required');
  const value = String(input).trim();
  const patterns = [
    /\/document\/d\/([a-zA-Z0-9_-]{10,})/,
    /\/spreadsheets\/d\/([a-zA-Z0-9_-]{10,})/,
    /\/presentation\/d\/([a-zA-Z0-9_-]{10,})/,
    /\/file\/d\/([a-zA-Z0-9_-]{10,})/,
    /\/folders\/([a-zA-Z0-9_-]{10,})/,
    /[?&]id=([a-zA-Z0-9_-]{10,})/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return value;
}

export function escapeDriveQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function mapFile(file) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    modifiedTime: file.modifiedTime,
    size: file.size,
    owners: file.owners?.map((owner) => owner.emailAddress).filter(Boolean),
    parents: file.parents,
    webViewLink: file.webViewLink,
    trashed: file.trashed ?? undefined,
  };
}

export async function getFileMeta(drive, fileId) {
  const { data } = await drive.files.get({
    fileId,
    fields: 'id,name,mimeType,modifiedTime,size,owners(emailAddress),parents,webViewLink,trashed',
    supportsAllDrives: true,
  });
  return data;
}

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? `open '${url}'`
      : process.platform === 'win32' ? `start "" "${url}"`
        : `xdg-open '${url}'`;
  exec(command, () => {});
}

/** One live authorization flow, shared by the tool and the CLI. */
let flow = null;

export function authFlowState() {
  if (!flow) return { running: false };
  return { running: true, url: flow.url, startedAt: flow.startedAt, settled: flow.settled };
}

/**
 * Start the loopback consent flow. Reuses a running flow so a repeated call
 * returns the same URL instead of binding the port twice.
 */
export function startAuthFlow({ open = true } = {}) {
  if (flow && !flow.settled) return flow.promise;
  const oauth2 = createOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: SCOPES,
  });

  let resolveFlow;
  let rejectFlow;
  const promise = new Promise((resolve, reject) => {
    resolveFlow = resolve;
    rejectFlow = reject;
  });
  // A rejected flow is reported through the tool result; avoid an unhandled rejection.
  promise.catch(() => {});

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, REDIRECT_URI);
    if (parsed.pathname !== '/oauth2callback') {
      res.writeHead(404).end('Not found');
      return;
    }
    const error = parsed.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Authorization failed: ${error}. You can close this tab.`);
      stopServer();
      rejectFlow(new Error(`Google authorization failed: ${error}`));
      return;
    }
    const code = parsed.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Missing authorization code.');
      return;
    }
    try {
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.refresh_token) {
        const previous = loadToken();
        if (previous?.refresh_token) tokens.refresh_token = previous.refresh_token;
      }
      saveToken(tokens);
      cachedAuth = null;
      cachedKey = '';
      oauth2.setCredentials(tokens);
      const drive = google.drive({ version: 'v3', auth: oauth2 });
      const { data } = await drive.about.get({ fields: 'user(emailAddress,displayName)' });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body style="font-family:-apple-system,system-ui,sans-serif;padding:3rem;max-width:40rem">
         <h2>DeepSeek Harness is connected</h2>
         <p>Signed in as <b>${data.user?.displayName ?? ''}</b> &lt;${data.user?.emailAddress ?? ''}&gt;.</p>
         <p>You can close this tab and return to DeepSeek Harness.</p></body></html>`,
      );
      stopServer();
      resolveFlow({ email: data.user?.emailAddress, name: data.user?.displayName });
    } catch (exchangeError) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Token exchange failed: ${exchangeError.message}`);
      stopServer();
      rejectFlow(new Error(`Token exchange failed: ${exchangeError.message}`));
    }
  });

  function stopServer() {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    if (flow) flow.settled = true;
  }

  const startedAt = Date.now();
  flow = { url, startedAt, settled: false, promise };

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      flow = null;
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`Port ${REDIRECT_PORT} is busy. Set GWS_AUTH_PORT to another port and restart DeepSeek Harness.`)
          : error,
      );
    });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      if (open) openBrowser(url);
      // The flow stays alive across calls until it settles or the process exits.
      promise.then(resolve, reject);
    });
  });
}

/** Wait for the currently running flow, or report the URL so the human can finish. */
export async function waitForAuth(seconds) {
  if (!flow) return { status: 'idle' };
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), seconds * 1000));
  const settled = flow.promise.then((value) => ({ status: 'authorized', ...value })).catch((error) => ({
    status: 'failed',
    error: error.message,
  }));
  return Promise.race([settled, timeout]);
}
