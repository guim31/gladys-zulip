// -----------------------------------------------------------------------------
// Integration configuration (the `config_schema` of the manifest), normalized
// so the rest of the code never deals with `undefined`, stray spaces or a
// half-typed address.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest (test/manifest.test.js).
export const DEFAULT_CONFIG = {
  server_url: '',
  bot_email: '',
  api_key: '',
  allowed_users: '',
  channels: '',
  command_prefix: '!',
  language: 'fr',
};

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// An e-mail address, as Zulip shows it (the real one, or user12@zulip.example.org
// when the organization hides addresses).
const EMAIL = /^[^\s@,;]+@[^\s@,;]+$/;
// A user id, as in the profile card of the person.
const USER_ID = /^[1-9][0-9]{0,9}$/;

/** Splits a list typed in a text field: commas, semicolons, spaces or new lines. */
export function parseList(value) {
  const items = trimmed(value)
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return [...new Set(items)];
}

/**
 * A person as typed in the allowed list or in a scene: "alice@example.org",
 * "@alice@example.org" or a user id ("12"). Lower case; null when neither.
 */
export function parsePerson(value) {
  const text = trimmed(value).replace(/^@/, '').toLowerCase();
  return EMAIL.test(text) || USER_ID.test(text) ? text : null;
}

/**
 * A channel name as typed: "garage", "#garage", "#**garage**" (Markdown of a
 * channel link). Channel names may hold spaces: the list of channels is split
 * on commas, semicolons and new lines only.
 */
export function parseChannelName(value) {
  const text = trimmed(value)
    .replace(/^#\*\*(.+)\*\*$/, '$1')
    .replace(/^#/, '')
    .trim();
  return text === '' || text.length > 60 ? null : text;
}

export function parseChannelList(value) {
  const names = trimmed(value)
    .split(/[,;\n]+/)
    .map(parseChannelName)
    .filter(Boolean);
  // Zulip compares channel names without case.
  const unique = new Map(names.map((name) => [name.toLowerCase(), name]));
  return [...unique.values()];
}

/**
 * The server address as a URL, or null when it is empty or not understood.
 * A bare host name gets https://. A sub-path (https://example.org/chat) is kept.
 * @param {string} value
 * @returns {URL|null}
 */
export function parseServer(value) {
  const text = trimmed(value).replace(/\/+$/, '');
  if (text === '') {
    return null;
  }
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.search = '';
    url.hash = '';
    // Pasted from the browser: keep the server, not the page.
    url.pathname = url.pathname
      .replace(/\/(?:api|json)\/.*$/, '')
      .replace(/\/#.*$/, '')
      .replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} [raw] config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const config = raw ?? {};
  const prefix = trimmed(config.command_prefix);
  const people = parseList(config.allowed_users).map(parsePerson).filter(Boolean);
  return {
    server_url: trimmed(config.server_url),
    bot_email: trimmed(config.bot_email).toLowerCase(),
    api_key: trimmed(config.api_key),
    allowed_users: [...new Set(people)],
    channels: parseChannelList(config.channels),
    // One to three characters, no space: "!" by default ("/" opens the slash commands of Zulip).
    command_prefix: prefix === '' || prefix.length > 3 ? DEFAULT_CONFIG.command_prefix : prefix,
    language: LANGUAGES.includes(config.language) ? config.language : DEFAULT_CONFIG.language,
  };
}
