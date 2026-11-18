/**
 * End-to-end test of the plugin as DSH loads it: a fake ctx registers the same
 * definitions, then real Google calls run through them.
 *
 * Requires an authorized account (state/token.json or GWS_STATE_DIR).
 * Creates and trashes its own test files.
 */
import { apply, toJsonSchema } from '../index.js';
import { TOOLS } from '../src/tools.js';

const registered = new Map();
const ctx = {
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`);
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
  },
};

const dispose = apply(ctx);

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✘'} ${label}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
const call = async (name, args = {}) => {
  const tool = registered.get(`google_${name}`);
  if (!tool) throw new Error(`no tool google_${name}`);
  const value = await tool.execute(args, {});
  return JSON.parse(JSON.stringify(value));
};

/* ------------------------------------------------------------ structure -- */

check('registers every tool', registered.size === TOOLS.length, `${registered.size} tools`);
check('names are namespaced', [...registered.keys()].every((key) => key.startsWith('google_')));

let schemaProblems = 0;
for (const [toolName, definition] of registered) {
  const parameters = definition.parameters;
  if (parameters.type !== 'object' || parameters.additionalProperties !== false) schemaProblems += 1;
  if (!Array.isArray(Object.keys(parameters.properties ?? []).length ? [] : [])) schemaProblems += 1;
  if (typeof definition.description !== 'string' || definition.description.length < 10) schemaProblems += 1;
  if (typeof definition.output?.render !== 'function') schemaProblems += 1;
  if (typeof definition.execute !== 'function') schemaProblems += 1;
  if (parameters.required && parameters.required.some((key) => !(key in (parameters.properties ?? {})))) {
    console.log('  required/property mismatch in', toolName);
    schemaProblems += 1;
  }
}
check('schemas and definitions are well formed', schemaProblems === 0, `${schemaProblems} problem(s)`);

const nested = toJsonSchema({
  rows: { type: 'array', required: true, items: { type: 'array', items: { type: 'json' } } },
  deck: {
    type: 'object',
    properties: { title: { type: 'string', required: true }, bullets: { type: 'array', items: { type: 'string' } } },
  },
});
check(
  'nested schema conversion',
  nested.required?.[0] === 'rows' &&
    nested.properties.rows.items.items.type === undefined &&
    nested.properties.deck.required?.[0] === 'title' &&
    nested.properties.deck.additionalProperties === false,
  JSON.stringify(nested).slice(0, 120),
);

/* ----------------------------------------------------------- live calls -- */

const created = [];
try {
  const me = await call('whoami');
  check('whoami', /@/.test(me.email ?? ''), me.email);

  const found = await call('drive_search', { query: 'test', limit: 3 });
  check('drive_search', Array.isArray(found.files), `${found.count} results`);

  const doc = await call('docs_create', {
    title: `DSH plugin test ${new Date().toISOString()}`,
    markdown: '# Heading\n\nSome **bold** text.\n\n- one\n- two\n',
  });
  created.push(doc.id);
  check('docs_create', !!doc.id, doc.url);

  const read = await call('drive_read', { file_id: doc.id });
  check('drive_read', /# Heading/.test(read.content ?? ''), 'markdown export');

  await call('docs_append', { file_id: doc.id, markdown: '\n## Added\n\n- three\n' });
  const appended = await call('drive_read', { file_id: doc.id });
  check('docs_append', /Added/.test(appended.content ?? ''));

  const sheet = await call('sheets_create', { title: `DSH plugin sheet ${Date.now()}`, values: [['a', 'b'], [1, 2]] });
  created.push(sheet.id);
  const sheetRead = await call('sheets_read', { spreadsheet_id: sheet.id });
  check('sheets_read', sheetRead.rows === 2, `${sheetRead.rows} rows`);

  const deck = await call('slides_create', {
    title: `DSH plugin deck ${Date.now()}`,
    slides: [
      { title: 'Title slide', bullets: ['subtitle line'] },
      { title: 'Second', bullets: ['alpha', 'beta'] },
    ],
  });
  created.push(deck.id);
  const outline = await call('slides_read', { presentation_id: deck.id });
  check('slides_read', outline.slides?.length === 2, JSON.stringify(outline.slides?.map((slide) => slide.title)));

  const folder = await call('drive_mkdir', { name: `DSH plugin folder ${Date.now()}` });
  created.push(folder.id);
  check('drive_mkdir', !!folder.id, folder.name);

  const error = await registered.get('google_drive_get').execute({ file_id: 'definitely-not-a-file-id' }, {}).then(
    () => null,
    (failure) => failure,
  );
  check('errors are readable', error instanceof Error && /(HTTP|not found|File not found)/i.test(error.message), error?.message);
} catch (failure) {
  failures += 1;
  console.error('✘ EXCEPTION', failure.message);
} finally {
  if (created.length > 0) {
    try {
      const trashed = await call('drive_trash', { file_ids: created });
      console.log(`↩ trashed ${trashed.updated} test items`);
    } catch (failure) {
      console.log('could not trash test items:', failure.message);
    }
  }
  dispose();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
