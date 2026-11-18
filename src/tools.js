/**
 * Google Drive / Docs / Sheets / Slides operations, shaped as DSH tool
 * definitions. Handlers are plain async functions so tests can call them.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  EXPORT_MAP,
  GOOGLE_DOC,
  GOOGLE_FOLDER,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  STATE_DIR,
  accountInfo,
  authFlowState,
  defaultExportKind,
  driveId,
  escapeDriveQuery,
  getFileMeta,
  loadToken,
  mapFile,
  parseClientSecret,
  saveClientSecret,
  services,
  startAuthFlow,
  waitForAuth,
} from './core.js';
import { markdownToDocRequests, shiftRequests } from './markdown.js';

const MIME_ALIASES = {
  doc: GOOGLE_DOC,
  document: GOOGLE_DOC,
  gdoc: GOOGLE_DOC,
  sheet: GOOGLE_SHEET,
  spreadsheet: GOOGLE_SHEET,
  gsheet: GOOGLE_SHEET,
  slides: GOOGLE_SLIDES,
  presentation: GOOGLE_SLIDES,
  deck: GOOGLE_SLIDES,
  folder: GOOGLE_FOLDER,
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const UPLOAD_MIME = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const CONVERT_TO = {
  doc: GOOGLE_DOC,
  document: GOOGLE_DOC,
  sheet: GOOGLE_SHEET,
  spreadsheet: GOOGLE_SHEET,
  slides: GOOGLE_SLIDES,
  presentation: GOOGLE_SLIDES,
};

const FILE_FIELDS =
  'id,name,mimeType,modifiedTime,size,owners(emailAddress),parents,webViewLink,trashed';

function mimeFor(value) {
  if (!value) return undefined;
  return MIME_ALIASES[value.toLowerCase()] ?? value;
}

function buildQuery({ query, folder_id, mime_type, include_trashed }) {
  const parts = [];
  const raw = String(query ?? '').trim();
  if (raw) {
    const looksLikeDriveQuery = /[=()]| contains | in parents/.test(raw);
    if (looksLikeDriveQuery) parts.push(raw.startsWith('(') ? raw : `(${raw})`);
    else {
      const escaped = escapeDriveQuery(raw);
      parts.push(`(name contains '${escaped}' or fullText contains '${escaped}')`);
    }
  }
  if (folder_id) parts.push(`'${escapeDriveQuery(driveId(folder_id))}' in parents`);
  if (mime_type) parts.push(`mimeType = '${mimeFor(mime_type)}'`);
  if (!include_trashed) parts.push('trashed = false');
  return parts.length ? parts.join(' and ') : 'trashed = false';
}

function toCsv(values) {
  if (!Array.isArray(values) || values.length === 0) return '';
  return values
    .map((row) =>
      (row ?? [])
        .map((cell) => {
          const text = cell === null || cell === undefined ? '' : String(cell);
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(','),
    )
    .join('\n');
}

function slidesOutline(presentation) {
  const slides = (presentation.slides ?? []).map((slide) => {
    const texts = [];
    for (const element of slide.pageElements ?? []) {
      const runs = element.shape?.text?.textElements ?? [];
      const content = runs.map((run) => run.textRun?.content ?? '').join('').replace(/\n$/, '');
      if (content.trim()) texts.push({ placeholder: element.shape?.placeholder?.type ?? null, text: content });
    }
    const title = texts.find((item) => item.placeholder === 'TITLE' || item.placeholder === 'CENTERED_TITLE');
    return {
      slide_id: slide.objectId,
      title: title?.text ?? null,
      body: texts.filter((item) => item !== title).map((item) => item.text),
    };
  });
  return { presentation_id: presentation.presentationId, title: presentation.title, slides };
}

async function insertMarkdown(docs, fileId, markdown, { append }) {
  const { text, requests } = markdownToDocRequests(markdown);
  if (!text) return { inserted_chars: 0 };

  const { data } = await docs.documents.get({ documentId: fileId });
  const content = data.body?.content ?? [];
  const last = content[content.length - 1];
  const endIndex = (last?.endIndex ?? 2) - 1;

  const batch = [];
  if (append) batch.push({ insertText: { location: { index: endIndex }, text: '\n' } });
  batch.push(...shiftRequests(requests, endIndex + (append ? 1 : 0)));
  await docs.documents.batchUpdate({ documentId: fileId, requestBody: { requests: batch } });
  return { inserted_chars: text.length };
}

const VALUES_2D = {
  type: 'array',
  description: 'Rows of cell values.',
  items: { type: 'array', items: { type: 'json' } },
};

/* ---------------------------------------------------------------- tools -- */

export const TOOLS = [
  {
    name: 'auth',
    description:
      'Connect this plugin to Google. With no client saved it reports where to put the OAuth client JSON. Once a client is saved it returns a Google consent URL and opens the browser; pass wait_seconds to hold the call until the human finishes.',
    parameters: {
      client_json: {
        type: 'string',
        description: 'Contents of the Desktop OAuth client JSON. Omit once the client is saved on disk.',
      },
      wait_seconds: {
        type: 'integer',
        description: 'Seconds to wait for the consent redirect before returning the URL. Default 0.',
      },
    },
    async handler(args) {
      if (args.client_json) {
        const parsed = saveClientSecret(args.client_json);
        return { stored: true, project: parsed.projectId };
      }

      if (loadToken()) {
        try {
          const account = await accountInfo();
          return { authorized: true, email: account.email, name: account.name, state_dir: STATE_DIR };
        } catch (error) {
          if (!/not authorized/i.test(error.message)) throw error;
        }
      }

      const flow = authFlowState();
      if (!flow.running) {
        const started = await startAuthFlow().catch((error) => {
          // Missing client file is a setup error, not a failure to report as opaque.
          return { error: error.message };
        });
        if (started?.error) return { authorized: false, error: started.error };
      }

      const wait = Number(args.wait_seconds ?? 0);
      if (wait > 0) {
        const result = await waitForAuth(wait);
        if (result.status === 'authorized') {
          const account = await accountInfo();
          return { authorized: true, email: account.email, name: account.name };
        }
        if (result.status === 'failed') return { authorized: false, error: result.error };
      }

      const state = authFlowState();
      return {
        authorized: false,
        url: state.url,
        message: 'Open the URL, approve access, then call google_auth again (or any Google tool) to continue.',
      };
    },
  },
  {
    name: 'whoami',
    description: 'Show the linked Google account and Drive storage usage. Use it to confirm the connection works.',
    parameters: {},
    async handler() {
      return accountInfo();
    },
  },
  {
    name: 'drive_search',
    description:
      "Search Drive by full text or name. Returns id, name, type, owner and modified time. Pass a raw Drive query (e.g. \"mimeType = 'application/pdf' and name contains 'report'\") to filter precisely.",
    parameters: {
      query: { type: 'string', required: true, description: 'Words to search for, or a raw Drive query string.' },
      folder_id: { type: 'string', description: 'Only search inside this folder id.' },
      mime_type: { type: 'string', description: 'Filter: doc, sheet, slides, folder, pdf, or a full MIME type.' },
      limit: { type: 'integer', description: 'Max results, 1-100. Default 25.' },
      include_trashed: { type: 'boolean', description: 'Include trashed files. Default false.' },
    },
    async handler(args) {
      const { drive } = services();
      const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 100);
      const { data } = await drive.files.list({
        q: buildQuery(args),
        pageSize: limit,
        fields: `files(${FILE_FIELDS})`,
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return { count: data.files?.length ?? 0, files: (data.files ?? []).map(mapFile) };
    },
  },
  {
    name: 'drive_get',
    description: 'Get metadata and permissions for one file by id or Google URL.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'File id or any Google Docs/Drive URL.' },
    },
    async handler(args) {
      const { drive } = services();
      const file = await getFileMeta(drive, driveId(args.file_id));
      const permissions = await drive.permissions
        .list({ fileId: file.id, fields: 'permissions(type,role,emailAddress,domain)' })
        .catch(() => ({ data: { permissions: [] } }));
      return { ...mapFile(file), permissions: permissions.data.permissions ?? [] };
    },
  },
  {
    name: 'drive_read',
    description:
      'Read a file as text. Google Docs become markdown, Sheets become CSV, Slides become an outline, text/CSV/JSON files are returned raw.',
    parameters: {
      file_id: { type: 'string', required: true, description: 'File id or Google URL.' },
      max_chars: { type: 'integer', description: 'Truncate output. Default 100000.' },
    },
    async handler(args) {
      const { drive } = services();
      const id = driveId(args.file_id);
      const meta = await getFileMeta(drive, id);
      const maxChars = Number(args.max_chars ?? 100_000);
      const clip = (value) => {
        const text = String(value ?? '');
        return text.length > maxChars
          ? { truncated: true, content: `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]` }
          : { truncated: false, content: text };
      };

      if (meta.mimeType === GOOGLE_DOC) {
        const { data } = await drive.files.export({ fileId: id, mimeType: 'text/markdown' }, { responseType: 'text' });
        return { file: mapFile(meta), format: 'markdown', ...clip(data) };
      }

      if (meta.mimeType === GOOGLE_SHEET) {
        const { sheets } = services();
        const book = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets(properties(title))' });
        const names = (book.data.sheets ?? []).map((sheet) => sheet.properties?.title).filter(Boolean);
        const sheetName = names[0] ?? 'Sheet1';
        const range = `'${sheetName.replace(/'/g, "''")}'!A1:ZZ2000`;
        const { data } = await sheets.spreadsheets.values.get({ spreadsheetId: id, range });
        const values = data.values ?? [];
        return {
          file: mapFile(meta),
          format: 'csv',
          sheets: names,
          sheet_read: sheetName,
          rows: values.length,
          ...clip(toCsv(values)),
        };
      }

      if (meta.mimeType === GOOGLE_SLIDES) {
        const { slides } = services();
        const { data } = await slides.presentations.get({ presentationId: id });
        return { file: mapFile(meta), format: 'outline', content: slidesOutline(data) };
      }

      const textual =
        meta.mimeType?.startsWith('text/') ||
        ['application/json', 'application/xml', 'application/javascript'].includes(meta.mimeType);
      if (textual) {
        const { data } = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'text' });
        return { file: mapFile(meta), format: 'text', ...clip(data) };
      }

      return {
        file: mapFile(meta),
        error: `Unsupported preview type ${meta.mimeType}. Use google_drive_download to fetch it locally.`,
      };
    },
  },
  {
    name: 'drive_download',
    description:
      'Download a file to the local filesystem. Google formats are exported: doc→docx (or md/txt/pdf), sheet→xlsx (or csv/pdf), slides→pptx (or pdf/txt).',
    parameters: {
      file_id: { type: 'string', required: true, description: 'File id or Google URL.' },
      path: { type: 'string', description: 'Local destination path. Defaults to ./<name>.<ext>.' },
      format: { type: 'string', description: 'Export format for Google files: docx, xlsx, pptx, pdf, csv, md.' },
    },
    async handler(args) {
      const { drive } = services();
      const id = driveId(args.file_id);
      const meta = await getFileMeta(drive, id);
      let destination = args.path ? path.resolve(args.path) : null;

      const exportKinds = EXPORT_MAP[meta.mimeType];
      if (exportKinds) {
        const kind = (args.format ?? defaultExportKind(meta.mimeType)).toLowerCase();
        const target = exportKinds[kind];
        if (!target) {
          throw new Error(`Cannot export ${meta.mimeType} as "${kind}". Available: ${Object.keys(exportKinds).join(', ')}`);
        }
        destination ??= path.resolve(`${meta.name ?? id}.${kind}`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const { data } = await drive.files.export({ fileId: id, mimeType: target }, { responseType: 'arraybuffer' });
        fs.writeFileSync(destination, Buffer.from(data));
        return { saved_to: destination, bytes: fs.statSync(destination).size, exported_as: kind };
      }

      destination ??= path.resolve(meta.name ?? id);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const { data } = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'arraybuffer' });
      fs.writeFileSync(destination, Buffer.from(data));
      return { saved_to: destination, bytes: fs.statSync(destination).size };
    },
  },
  {
    name: 'drive_upload',
    description: 'Upload a local file to Drive. Set convert_to to turn it into a Google doc, sheet or slides deck.',
    parameters: {
      path: { type: 'string', required: true, description: 'Local file path.' },
      name: { type: 'string', description: 'Name in Drive. Defaults to the file name.' },
      parent_id: { type: 'string', description: 'Folder id to upload into.' },
      convert_to: { type: 'string', description: 'doc | sheet | slides — convert on upload.' },
      mime_type: { type: 'string', description: 'Override the detected MIME type.' },
    },
    async handler(args) {
      const { drive } = services();
      const local = path.resolve(args.path);
      if (!fs.existsSync(local)) throw new Error(`Local file not found: ${local}`);
      const detected = args.mime_type ?? UPLOAD_MIME[path.extname(local).toLowerCase()] ?? 'application/octet-stream';
      const converted = args.convert_to ? CONVERT_TO[args.convert_to.toLowerCase()] : undefined;
      if (args.convert_to && !converted) throw new Error(`Unknown convert_to "${args.convert_to}". Use doc, sheet or slides.`);
      const { data } = await drive.files.create({
        requestBody: {
          name: args.name ?? path.basename(local),
          mimeType: converted ?? detected,
          parents: args.parent_id ? [driveId(args.parent_id)] : undefined,
        },
        media: { mimeType: detected, body: fs.createReadStream(local) },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return mapFile(data);
    },
  },
  {
    name: 'drive_mkdir',
    description: 'Create a Drive folder.',
    parameters: {
      name: { type: 'string', required: true },
      parent_id: { type: 'string', description: 'Parent folder id; defaults to My Drive root.' },
    },
    async handler(args) {
      const { drive } = services();
      const { data } = await drive.files.create({
        requestBody: {
          name: args.name,
          mimeType: GOOGLE_FOLDER,
          parents: args.parent_id ? [driveId(args.parent_id)] : undefined,
        },
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return mapFile(data);
    },
  },
  {
    name: 'drive_move',
    description: 'Move a file or folder into another folder.',
    parameters: {
      file_id: { type: 'string', required: true },
      parent_id: { type: 'string', required: true, description: 'Destination folder id.' },
    },
    async handler(args) {
      const { drive } = services();
      const fileId = driveId(args.file_id);
      const meta = await getFileMeta(drive, fileId);
      const { data } = await drive.files.update({
        fileId,
        addParents: driveId(args.parent_id),
        removeParents: (meta.parents ?? []).join(',') || undefined,
        fields: FILE_FIELDS,
        supportsAllDrives: true,
      });
      return mapFile(data);
    },
  },
  {
    name: 'drive_trash',
    description: 'Move files to the trash, or restore them with restore=true.',
    parameters: {
      file_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'One or more file ids.' },
      restore: { type: 'boolean', description: 'Default false (trash); true restores.' },
    },
    async handler(args) {
      const { drive } = services();
      const results = [];
      for (const fileId of (args.file_ids ?? []).map(driveId)) {
        const { data } = await drive.files.update({
          fileId,
          requestBody: { trashed: !args.restore },
          fields: 'id,name,trashed',
        });
        results.push({ id: data.id, name: data.name, trashed: data.trashed });
      }
      return { updated: results.length, files: results };
    },
  },
  {
    name: 'drive_share',
    description: 'Share a file with an email address, or turn on link sharing.',
    parameters: {
      file_id: { type: 'string', required: true },
      email: { type: 'string', description: 'Person to share with. Omit for link sharing.' },
      role: { type: 'string', description: 'reader | commenter | writer. Default reader.' },
      anyone: { type: 'boolean', description: 'Link sharing for anyone with the link.' },
      notify: { type: 'boolean', description: 'Send a notification email. Default false.' },
    },
    async handler(args) {
      const { drive } = services();
      const fileId = driveId(args.file_id);
      const role = args.role ?? 'reader';
      const requestBody = args.email
        ? { type: 'user', role, emailAddress: args.email }
        : { type: 'anyone', role: args.anyone === false ? role : 'reader', allowFileDiscovery: false };
      const { data } = await drive.permissions.create({
        fileId,
        requestBody,
        sendNotificationEmail: Boolean(args.notify),
        fields: 'id',
      });
      const meta = await getFileMeta(drive, fileId);
      return { permission_id: data.id, role, link: meta.webViewLink };
    },
  },
  {
    name: 'docs_create',
    description: 'Create a Google Doc from markdown. Supports headings, lists, bold/italic, code and links.',
    parameters: {
      title: { type: 'string', required: true },
      markdown: { type: 'string', description: 'Document body as markdown.' },
      folder_id: { type: 'string', description: 'Folder to create it in.' },
    },
    async handler(args) {
      const { drive, docs } = services();
      const { data } = await docs.documents.create({ requestBody: { title: args.title } });
      const documentId = data.documentId;
      let inserted = 0;
      if (args.markdown && args.markdown.trim()) {
        inserted = (await insertMarkdown(docs, documentId, args.markdown, { append: false })).inserted_chars;
      }
      if (args.folder_id) {
        const meta = await getFileMeta(drive, documentId);
        await drive.files.update({
          fileId: documentId,
          addParents: driveId(args.folder_id),
          removeParents: (meta.parents ?? []).join(',') || undefined,
          fields: 'id',
        });
      }
      return {
        id: documentId,
        name: args.title,
        url: `https://docs.google.com/document/d/${documentId}/edit`,
        inserted_chars: inserted,
      };
    },
  },
  {
    name: 'docs_append',
    description: 'Append markdown to the end of an existing Google Doc.',
    parameters: {
      file_id: { type: 'string', required: true },
      markdown: { type: 'string', required: true },
    },
    async handler(args) {
      const { docs } = services();
      const documentId = driveId(args.file_id);
      const result = await insertMarkdown(docs, documentId, args.markdown, { append: true });
      return { id: documentId, appended_chars: result.inserted_chars };
    },
  },
  {
    name: 'docs_replace',
    description: 'Find and replace text inside a Google Doc.',
    parameters: {
      file_id: { type: 'string', required: true },
      find: { type: 'string', required: true },
      replace: { type: 'string', required: true },
      match_case: { type: 'boolean', description: 'Default false.' },
    },
    async handler(args) {
      const { docs } = services();
      const documentId = driveId(args.file_id);
      const { data } = await docs.documents.batchUpdate({
        documentId,
        requestBody: {
          requests: [
            {
              replaceAllText: {
                containsText: { text: args.find, matchCase: Boolean(args.match_case) },
                replaceText: args.replace,
              },
            },
          ],
        },
      });
      return {
        id: documentId,
        occurrences_changed: data.replies?.[0]?.replaceAllText?.occurrencesChanged ?? 0,
      };
    },
  },
  {
    name: 'sheets_read',
    description: 'Read a range of a Google Sheet as values plus CSV. Defaults to the first sheet.',
    parameters: {
      spreadsheet_id: { type: 'string', required: true, description: 'Spreadsheet id or URL.' },
      range: { type: 'string', description: "A1 notation, e.g. 'Sheet1!A1:D20'. Defaults to the first sheet." },
    },
    async handler(args) {
      const { sheets } = services();
      const spreadsheetId = driveId(args.spreadsheet_id);
      let range = args.range;
      if (!range) {
        const book = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' });
        const name = book.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
        range = `'${String(name).replace(/'/g, "''")}'!A1:ZZ2000`;
      }
      const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
      const values = data.values ?? [];
      return {
        spreadsheet_id: spreadsheetId,
        range: data.range ?? range,
        rows: values.length,
        values,
        csv: toCsv(values),
      };
    },
  },
  {
    name: 'sheets_write',
    description: 'Write values into a range, replacing what is there. values is a 2-D array of rows.',
    parameters: {
      spreadsheet_id: { type: 'string', required: true },
      range: { type: 'string', required: true, description: "A1 notation, e.g. 'Sheet1!A1'." },
      values: { ...VALUES_2D, required: true },
      raw: { type: 'boolean', description: 'True stores text literally; false (default) parses numbers/formulas.' },
    },
    async handler(args) {
      const { sheets } = services();
      const spreadsheetId = driveId(args.spreadsheet_id);
      const { data } = await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: args.range,
        valueInputOption: args.raw ? 'RAW' : 'USER_ENTERED',
        requestBody: { values: args.values },
      });
      return { updated_cells: data.updatedCells ?? 0, updated_range: data.updatedRange };
    },
  },
  {
    name: 'sheets_append',
    description: 'Append rows after the last row of a sheet.',
    parameters: {
      spreadsheet_id: { type: 'string', required: true },
      range: { type: 'string', description: "Sheet to append to, e.g. 'Sheet1'. Defaults to the first sheet." },
      values: { ...VALUES_2D, required: true },
      raw: { type: 'boolean', description: 'Store values literally instead of parsing them.' },
    },
    async handler(args) {
      const { sheets } = services();
      const spreadsheetId = driveId(args.spreadsheet_id);
      let range = args.range;
      if (!range) {
        const book = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(title))' });
        range = book.data.sheets?.[0]?.properties?.title ?? 'Sheet1';
      }
      const { data } = await sheets.spreadsheets.values.append({
        spreadsheetId,
        range,
        valueInputOption: args.raw ? 'RAW' : 'USER_ENTERED',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: args.values },
      });
      return { updated_rows: data.updates?.updatedRows ?? 0, updated_range: data.updates?.updatedRange };
    },
  },
  {
    name: 'sheets_create',
    description: 'Create a Google Sheet, optionally filled with a 2-D array of values.',
    parameters: {
      title: { type: 'string', required: true },
      values: VALUES_2D,
      folder_id: { type: 'string' },
    },
    async handler(args) {
      const { drive, sheets } = services();
      const { data } = await sheets.spreadsheets.create({
        requestBody: { properties: { title: args.title } },
        fields: 'spreadsheetId,spreadsheetUrl',
      });
      const spreadsheetId = data.spreadsheetId;
      let written = 0;
      if (Array.isArray(args.values) && args.values.length > 0) {
        const result = await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: 'A1',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: args.values },
        });
        written = result.data.updatedCells ?? 0;
      }
      if (args.folder_id) {
        const meta = await getFileMeta(drive, spreadsheetId);
        await drive.files.update({
          fileId: spreadsheetId,
          addParents: driveId(args.folder_id),
          removeParents: (meta.parents ?? []).join(',') || undefined,
          fields: 'id',
        });
      }
      return { id: spreadsheetId, url: data.spreadsheetUrl, cells_written: written };
    },
  },
  {
    name: 'slides_create',
    description: 'Create a Google Slides deck. Each slide takes a title and bullet points.',
    parameters: {
      title: { type: 'string', required: true, description: 'Deck title.' },
      slides: {
        type: 'array',
        required: true,
        description: 'Slides in order. The first becomes the title slide.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points for the body.' },
          },
        },
      },
      folder_id: { type: 'string' },
    },
    async handler(args) {
      const { drive, slides } = services();
      const created = await slides.presentations.create({ requestBody: { title: args.title } });
      const presentationId = created.data.presentationId;
      const leftover = (created.data.slides ?? []).map((slide) => slide.objectId).filter(Boolean);
      const specs = Array.isArray(args.slides) ? args.slides : [];

      const createRequests = specs.map((spec, index) => ({
        createSlide: {
          objectId: `dsh_slide_${index}`,
          slideLayoutReference: { predefinedLayout: index === 0 ? 'TITLE' : 'TITLE_AND_BODY' },
        },
      }));

      if (createRequests.length > 0) {
        await slides.presentations.batchUpdate({ presentationId, requestBody: { requests: createRequests } });

        const current = await slides.presentations.get({ presentationId });
        const textRequests = leftover.map((objectId) => ({ deleteObject: { objectId } }));

        specs.forEach((spec, index) => {
          const slide = (current.data.slides ?? []).find((candidate) => candidate.objectId === `dsh_slide_${index}`);
          if (!slide) return;
          const shapes = (slide.pageElements ?? []).filter((element) => element.shape?.placeholder?.type);
          const titleShape = shapes.find((element) => /TITLE/.test(element.shape.placeholder.type));
          const bodyShape = shapes.find((element) => /(BODY|SUBTITLE)/.test(element.shape.placeholder.type));

          if (spec.title && titleShape) {
            textRequests.push({
              insertText: { objectId: titleShape.objectId, insertionIndex: 0, text: String(spec.title) },
            });
          }

          const bullets = (spec.bullets ?? []).map((bullet) => String(bullet)).filter(Boolean);
          const target = bodyShape ?? titleShape;
          if (bullets.length > 0 && target) {
            const bodyText = bullets.join('\n');
            const insertionIndex = target === titleShape && spec.title ? String(spec.title).length + 1 : 0;
            textRequests.push({ insertText: { objectId: target.objectId, insertionIndex, text: bodyText } });
            textRequests.push({
              createParagraphBullets: {
                objectId: target.objectId,
                textRange: { type: 'FIXED_RANGE', startIndex: insertionIndex, endIndex: insertionIndex + bodyText.length },
                bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
              },
            });
          }
        });

        try {
          await slides.presentations.batchUpdate({ presentationId, requestBody: { requests: textRequests } });
        } catch (error) {
          const fallback = textRequests.filter((request) => !request.createParagraphBullets);
          if (fallback.length === textRequests.length) throw error;
          await slides.presentations.batchUpdate({ presentationId, requestBody: { requests: fallback } });
        }
      }

      if (args.folder_id) {
        const meta = await getFileMeta(drive, presentationId);
        await drive.files.update({
          fileId: presentationId,
          addParents: driveId(args.folder_id),
          removeParents: (meta.parents ?? []).join(',') || undefined,
          fields: 'id',
        });
      }

      return {
        id: presentationId,
        url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
        slides_created: specs.length,
      };
    },
  },
  {
    name: 'slides_read',
    description: 'Read a Google Slides deck as a title/body outline.',
    parameters: {
      presentation_id: { type: 'string', required: true, description: 'Presentation id or URL.' },
    },
    async handler(args) {
      const { slides } = services();
      const { data } = await slides.presentations.get({ presentationId: driveId(args.presentation_id) });
      return slidesOutline(data);
    },
  },
];

export { parseClientSecret };
