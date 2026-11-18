/**
 * DSH Host plugin entry: registers the Google Workspace tools on ctx.tools.
 *
 * Tool definitions are plain objects because the registry consumes the
 * enforced JSON Schema subset directly; spelling the schemas out here keeps
 * this package free of runtime dependencies on Harness internals.
 */
import { TOOLS } from './src/tools.js';

export const name = 'google-workspace';
export const inject = ['tools'];

/** Longest rendered result; larger payloads are cut with a visible marker. */
const MAX_TEXT = 24_000;

/**
 * Convert an authored parameter map into the enforced JSON Schema subset.
 * A property carries `required: true`; nested objects list their own required names.
 * @param parameters - authored property map.
 * @returns an object-rooted JSON Schema with no undeclared keys.
 */
export function toJsonSchema(parameters = {}) {
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...node } = spec;
    properties[key] = convertNode(node);
    if (isRequired) required.push(key);
  }
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function convertNode(node) {
  if (!node || node.type === 'json') return {};
  const out = {};
  if (node.type) out.type = node.type;
  if (node.description) out.description = node.description;
  if (node.enum) out.enum = [...node.enum];
  if (node.items) out.items = convertNode(node.items);
  if (node.properties) {
    const nested = toJsonSchema(node.properties);
    out.properties = nested.properties;
    if (nested.required) out.required = nested.required;
    out.additionalProperties = node.additionalProperties ?? false;
  }
  return out;
}

/** Keep every result a lossless JSON value. */
function asJsonValue(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

function renderText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n…[truncated ${text.length - MAX_TEXT} characters]`;
}

/** Give Google API failures a readable message instead of a bare status. */
function describeError(error) {
  const apiMessage = error?.response?.data?.error?.message ?? error?.errors?.[0]?.message;
  const status = error?.response?.status ?? error?.code;
  let message = apiMessage ?? error?.message ?? String(error);
  if (status) message = `${message} (HTTP ${status})`;
  if (/invalid_grant|invalid authentication credentials/i.test(message)) {
    message += '\nThe Google token was revoked or expired. Call google_auth to sign in again.';
  } else if (/not authorized yet/i.test(message)) {
    message += '\nCall google_auth to sign in.';
  } else if (/accessNotConfigured|has not been used in project|is disabled/i.test(message)) {
    message += '\nEnable that Google API for your Cloud project, then try again.';
  }
  return message;
}

/**
 * Register every Google tool and return the disposer that unregisters them.
 * @param ctx - plugin context carrying the tool registry.
 * @returns cleanup for the registrations.
 */
export function apply(ctx) {
  const disposers = TOOLS.map((tool) =>
    ctx.tools.register({
      name: `google_${tool.name}`,
      description: tool.description,
      parameters: toJsonSchema(tool.parameters),
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      async execute(args) {
        try {
          return asJsonValue(await tool.handler(args ?? {}));
        } catch (error) {
          throw new Error(describeError(error));
        }
      },
    }),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
