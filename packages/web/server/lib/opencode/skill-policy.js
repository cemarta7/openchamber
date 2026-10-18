/**
 * Per-skill on/off through OpenCode's own policy config (#3075).
 *
 * A skill is switched off with one statement in an OpenCode config file:
 *
 *   { "action": "integration.use", "resource": "skill:<id>", "effect": "deny" }
 *
 * Once OpenCode reloads the config it refuses to load the skill (the model's
 * call, `session.skill`, prompt attachments); the model's list of available
 * skills is fixed per session at its first prompt, so open sessions keep
 * their old list. The
 * id is OpenCode's path-derived skill id (the folder of `SKILL.md`), never the
 * display name, and one id covers every source copy of a skill.
 *
 * Where the statement goes depends on the running OpenCode: 2.0.25 through
 * 2.0.28 read only `experimental.policies`, 2.0.29 and newer also read the
 * top-level `policies` (and mark the experimental key deprecated).
 *
 * Ownership: the statement a switch writes carries one more key,
 * `"openchamber": "skill-switch"`, and a switch only ever removes statements
 * with that key. OpenCode 2.0.25, 2.0.28, 2.0.29 and 2.0.30 accept the extra key without a
 * diagnostic, still enforce the statement, and leave the key out of
 * `GET /api/config` (verified for #3075 on isolated servers). The switch
 * writes in the one config file of the scope it edits (the user's global
 * `opencode.json[c]` or the project config OpenChamber writes for the
 * directory). Turning a skill off adds the marked deny unless a deny already
 * decides the skill in that file; turning it on removes the marked denies for
 * that id and nothing else. A user's own exact deny, wildcards, allows, other
 * actions, other files and Console policies are never written or removed, so
 * a restriction the switch did not create stays in force and is reported
 * through `decidedBy` instead of being overridden with an allow.
 *
 * This module is pure apart from the file system and the injected config and
 * OpenCode readers, so the web server and the VS Code extension host share one
 * implementation.
 */
import fs from 'fs';
import path from 'path';
import { applyEdits, createScanner, findNodeAtLocation, modify, parse as parseJsonc, parseTree, SyntaxKind } from 'jsonc-parser';
import { isBoolean, isPlainObject, isString } from '../shared/guards.js';
import { writeFileAtomic } from './atomic-write.js';

/** Scopes a switch can write. */
const SKILL_POLICY_SCOPES = Object.freeze(['global', 'project']);

const INTEGRATION_USE = 'integration.use';
const SKILL_RESOURCE_PREFIX = 'skill:';

/** The config key OpenCode reads policy statements from, by version. */
const SKILL_POLICY_LOCATION = Object.freeze({
  EXPERIMENTAL: 'experimental.policies',
  TOP_LEVEL: 'policies',
});

const EXPERIMENTAL_PATH = ['experimental', 'policies'];
const TOP_LEVEL_PATH = ['policies'];

const releaseParts = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(isString(version) ? version.trim() : '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
};

const isAtLeast = (parts, minimum) => {
  for (let index = 0; index < 3; index += 1) {
    if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
  }
  return true;
};

/**
 * Where a running OpenCode reads skill policies: `policies` from 2.0.29,
 * `experimental.policies` from 2.0.25, `null` for anything that does not
 * enforce them (older 2.x, another major, an unreadable version).
 */
export function skillPolicyLocation(version) {
  const parts = releaseParts(version);
  if (!parts || parts[0] !== 2) return null;
  if (isAtLeast(parts, [2, 0, 29])) return SKILL_POLICY_LOCATION.TOP_LEVEL;
  if (isAtLeast(parts, [2, 0, 25])) return SKILL_POLICY_LOCATION.EXPERIMENTAL;
  return null;
}

/** The arrays a version enforces, in the order OpenCode concatenates them. */
const enforcedPaths = (location) => (location === SKILL_POLICY_LOCATION.EXPERIMENTAL
  ? [EXPERIMENTAL_PATH]
  : [EXPERIMENTAL_PATH, TOP_LEVEL_PATH]);

const writePath = (location) => (location === SKILL_POLICY_LOCATION.EXPERIMENTAL ? EXPERIMENTAL_PATH : TOP_LEVEL_PATH);

/**
 * A skill id a switch may name: what OpenCode derives from a folder or file
 * name. Wildcard characters and separators are refused, so an owned statement
 * can only ever match the one id it was written for.
 */
const FORBIDDEN_ID_CHARACTERS = new Set(['*', '?', '/', '\\']);

export function isValidSkillPolicyId(id) {
  return isString(id)
    && id.length > 0
    && id.length <= 255
    && id === id.trim()
    && id !== '.'
    && id !== '..'
    && ![...id].some((character) => {
      const code = character.charCodeAt(0);
      return FORBIDDEN_ID_CHARACTERS.has(character) || code < 0x20 || code === 0x7f;
    });
}

/**
 * OpenCode's skill id for a skill file: the folder of a `SKILL.md`, or the
 * name of a loose `<id>.md` file. `null` for anything else.
 */
export function skillIdFromPath(skillPath) {
  if (!isString(skillPath) || !skillPath) return null;
  const parts = skillPath.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? '';
  const id = file === 'SKILL.md' ? parts.at(-2) : (file.endsWith('.md') ? file.slice(0, -3) : null);
  return isValidSkillPolicyId(id) ? id : null;
}

const isStatement = (value) => isPlainObject(value)
  && isString(value.action)
  && isString(value.resource)
  && (value.effect === 'allow' || value.effect === 'deny');

const ownedResource = (id) => `${SKILL_RESOURCE_PREFIX}${id}`;

// The provenance key on a statement a switch wrote. See the module comment.
const OWNER_KEY = 'openchamber';
const OWNER_VALUE = 'skill-switch';

const ownedStatement = (id) => ({ action: INTEGRATION_USE, resource: ownedResource(id), effect: 'deny', [OWNER_KEY]: OWNER_VALUE });

/** The statement a switch writes, and the only one it ever removes. */
const isOwnedStatement = (value, id) => isStatement(value)
  && value.action === INTEGRATION_USE
  && value.resource === ownedResource(id)
  && value.effect === 'deny'
  && value[OWNER_KEY] === OWNER_VALUE;

const readPath = (config, keyPath) => {
  let current = config;
  for (const key of keyPath) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
};

const readArray = (config, keyPath) => {
  const value = readPath(config, keyPath);
  return Array.isArray(value) ? value : [];
};

/**
 * OpenCode's `Wildcard.match`: `*` is any run, `?` one character, a trailing
 * ` *` also matches nothing. Same as the UI's `matchesWildcard` in
 * `lib/opencode/projection.ts`.
 */
function matchesWildcard(input, pattern) {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
}

const lastMatchIn = (statements, id) => {
  const resource = ownedResource(id);
  let match = null;
  for (const statement of statements) {
    if (isStatement(statement) && statement.action === INTEGRATION_USE && matchesWildcard(resource, statement.resource)) {
      match = statement;
    }
  }
  return match;
};

// The statements a version enforces, in order. An unknown `location` (OpenCode
// not reachable) counts both arrays.
const enforcedStatements = (config, location) => enforcedPaths(location ?? SKILL_POLICY_LOCATION.TOP_LEVEL)
  .flatMap((keyPath) => readArray(config, keyPath));

/** Every id a config file switches off with a switch's own marked deny. */
export function listOwnedSkillDenies(config, location = null) {
  const ids = new Set();
  for (const statement of enforcedStatements(config, location)) {
    if (!isStatement(statement) || !statement.resource.startsWith(SKILL_RESOURCE_PREFIX)) continue;
    const id = statement.resource.slice(SKILL_RESOURCE_PREFIX.length);
    if (isValidSkillPolicyId(id) && isOwnedStatement(statement, id)) ids.add(id);
  }
  return [...ids];
}

/** Whether `id`'s last matching statement in one config file is a switch's own deny. */
const isDecidedByOwnedDeny = (config, id, location) => isOwnedStatement(lastMatchIn(enforcedStatements(config, location), id), id);

// The enforced statements as OpenCode serves them back: its decoder drops the
// provenance key, so a served document is compared on these three fields.
const servedForm = (config, location) => enforcedStatements(config, location)
  .filter(isStatement)
  .map(({ action, resource, effect }) => [action, resource, effect]);

class SkillPolicyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SkillPolicyConfigError';
    this.code = 'SKILL_POLICY_CONFIG_SHAPE';
  }
}

/**
 * Turn `id` off (`disabled: true`) or back on in one config object, in place.
 * Returns whether the object changed.
 *
 * Off appends the switch's marked deny to the version's write array unless a
 * deny (the switch's own, the user's exact one, or a wildcard) already decides
 * `id` in this file. On removes the marked denies for `id` from the arrays the
 * version enforces. An array it empties stays, empty, and so does its
 * `experimental` object: the file cannot tell an array the switch added from
 * one the user wrote. A statement without the provenance key is never
 * removed, so a user's exact deny survives an off/on round trip. Nothing else
 * in the file moves.
 */
export function setSkillDisabled(config, id, disabled, location) {
  if (!isPlainObject(config)) throw new SkillPolicyConfigError('The config file is not an object');
  if (!isValidSkillPolicyId(id)) throw new SkillPolicyConfigError(`Invalid skill id "${id}"`);
  if (location !== SKILL_POLICY_LOCATION.TOP_LEVEL && location !== SKILL_POLICY_LOCATION.EXPERIMENTAL) {
    throw new SkillPolicyConfigError('Unknown policy location');
  }

  if (disabled) {
    if (lastMatchIn(enforcedStatements(config, location), id)?.effect === 'deny') return false;
    const [first, second] = writePath(location);
    let parent = config;
    if (second) {
      if (parent[first] === undefined) parent[first] = {};
      if (!isPlainObject(parent[first])) throw new SkillPolicyConfigError(`"${first}" in the config file is not an object`);
      parent = parent[first];
    }
    const key = second ?? first;
    if (parent[key] === undefined) parent[key] = [];
    if (!Array.isArray(parent[key])) throw new SkillPolicyConfigError(`"${writePath(location).join('.')}" in the config file is not a list`);
    parent[key].push(ownedStatement(id));
    return true;
  }

  let changed = false;
  for (const keyPath of enforcedPaths(location)) {
    const parent = keyPath.length === 2 ? readPath(config, [keyPath[0]]) : config;
    const key = keyPath.at(-1);
    if (!isPlainObject(parent) || !Array.isArray(parent[key])) continue;
    const kept = parent[key].filter((statement) => !isOwnedStatement(statement, id));
    if (kept.length === parent[key].length) continue;
    changed = true;
    parent[key] = kept;
  }
  return changed;
}

// Key order does not matter when a written file is compared with the config it should hold.
const canonicalJson = (value) => JSON.stringify(value, (_key, entry) => (isPlainObject(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
  : entry));

// The offset of the first comma token in [start, end), comments skipped; -1 when none.
const commaBetween = (text, start, end) => {
  const scanner = createScanner(text, false);
  scanner.setPosition(start);
  for (let token = scanner.scan(); token !== SyntaxKind.EOF && scanner.getTokenOffset() < end; token = scanner.scan()) {
    if (token === SyntaxKind.CommaToken) return scanner.getTokenOffset();
  }
  return -1;
};

const lineStartOf = (text, offset) => text.lastIndexOf('\n', offset - 1) + 1;

const isBlank = (value) => value.trim() === '';

// Appends `value` to the list node as one item. On a list whose `]` has its
// own line the item gets a line of its own, indented like the last item, so a
// comment after the last item stays on that item's line.
const appendItemEdits = (text, list, value, eol) => {
  const last = list.children.at(-1);
  const close = list.offset + list.length - 1;
  const lastEnd = last.offset + last.length;
  const trailingComma = commaBetween(text, lastEnd, close) !== -1;
  const edits = trailingComma ? [] : [{ offset: lastEnd, length: 0, content: ',' }];
  const closeLine = lineStartOf(text, close);
  if (!isBlank(text.slice(closeLine, close))) {
    edits.push({ offset: close, length: 0, content: `${trailingComma ? '' : ' '}${JSON.stringify(value)}` });
    return edits;
  }
  const lastLine = lineStartOf(text, last.offset);
  const indent = text.slice(lastLine, last.offset).match(/^[ \t]*/)[0];
  const item = JSON.stringify(value, null, 2).split('\n').join(`${eol}${indent}`);
  edits.push({ offset: closeLine, length: 0, content: `${indent}${item}${trailingComma ? ',' : ''}${eol}` });
  return edits;
};

// Removes one list item and one separator comma next to it; comments around
// it stay. The item's line goes too when nothing else is left on it.
const removeItemEdits = (text, list, index) => {
  const item = list.children[index];
  const end = item.offset + item.length;
  const next = list.children[index + 1];
  const after = commaBetween(text, end, next ? next.offset : list.offset + list.length - 1);
  let start = item.offset;
  let stop = after === -1 ? end : after + 1;
  const edits = [];
  if (after === -1 && index > 0) {
    const previous = list.children[index - 1];
    const before = commaBetween(text, previous.offset + previous.length, item.offset);
    if (before !== -1) edits.push({ offset: before, length: 1, content: '' });
  }
  const lineStart = lineStartOf(text, start);
  const lineEnd = text.indexOf('\n', stop);
  if (isBlank(text.slice(lineStart, start)) && lineEnd !== -1 && isBlank(text.slice(stop, lineEnd))) {
    start = lineStart;
    stop = lineEnd + 1;
  }
  edits.push({ offset: start, length: stop - start, content: '' });
  return edits;
};

/**
 * `setSkillDisabled` as edits to the file's own text, so the user's rules and
 * comments stay where they are, inside the policy list too: off appends the
 * marked deny to the version's list (creating the list when it is missing),
 * on removes each marked deny for `id` as one list item. `before` is the
 * file's config before the change and `desired` after it. Answers null when
 * the edits do not parse back to `desired`; the caller then writes nothing.
 */
export function editSkillSwitchText(fileText, before, desired, id, disabled, location) {
  // A byte order mark is set aside for the offsets and put back as it was.
  const bom = fileText.charCodeAt(0) === 0xfeff ? fileText[0] : '';
  const text = fileText.slice(bom.length);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const listAt = (source, keyPath) => {
    const node = findNodeAtLocation(parseTree(source, [], { allowTrailingComma: true }), keyPath);
    return node?.type === 'array' ? node : null;
  };
  let edited = text;
  if (disabled) {
    const keyPath = writePath(location);
    const list = listAt(edited, keyPath);
    if (list?.children?.length) {
      edited = applyEdits(edited, appendItemEdits(edited, list, ownedStatement(id), eol));
    } else if (list) {
      // An empty list: the item goes right after `[`, so a comment inside stays.
      edited = applyEdits(edited, [{ offset: list.offset + 1, length: 0, content: JSON.stringify(ownedStatement(id)) }]);
    } else {
      edited = applyEdits(edited, modify(edited, keyPath, [ownedStatement(id)], {
        formattingOptions: { tabSize: 2, insertSpaces: true, eol },
      }));
    }
  } else {
    for (const keyPath of enforcedPaths(location)) {
      const values = readPath(before, keyPath);
      if (!Array.isArray(values)) continue;
      // From the end, so the items still to remove keep their index.
      for (let index = values.length - 1; index >= 0; index -= 1) {
        if (!isOwnedStatement(values[index], id)) continue;
        const list = listAt(edited, keyPath);
        if (!list?.children?.[index]) return null;
        edited = applyEdits(edited, removeItemEdits(edited, list, index));
      }
    }
  }
  const errors = [];
  const parsed = parseJsonc(edited, errors, { allowTrailingComma: true });
  return errors.length === 0 && isPlainObject(parsed) && canonicalJson(parsed) === canonicalJson(desired) ? `${bom}${edited}` : null;
}

const isDocument = (entry) => isPlainObject(entry) && entry.type === 'document' && isPlainObject(entry.info);

/**
 * The statement that decides `id` across OpenCode's config documents, as
 * `GET /api/config` serves them (lowest priority first). OpenCode evaluates
 * the documents reversed and lets the last match win, so a global rule beats a
 * project one in either direction. Only the arrays the version enforces count:
 * 2.0.25 to 2.0.28 ignore top-level `policies`. `null` means no rule matches:
 * the skill is allowed. Console statements are not part of `/api/config`.
 */
export function findDecidingSkillStatement(entries, id, location = null) {
  let decided = null;
  for (const entry of [...entries].filter(isDocument).reverse()) {
    const match = lastMatchIn(enforcedStatements(entry.info, location), id);
    if (match) decided = { path: isString(entry.path) ? entry.path : null, resource: match.resource, effect: match.effect };
  }
  return decided;
}

const UNKNOWN = 'unknown';

/**
 * One skill's policy state for the UI.
 * - `disabledIn`: whether the switch's own rule is saved in each scope's file.
 *   A file that does not exist yet reads as `{}`, so it is `false`; `null`
 *   means the directory has no such scope, or its file could not be read.
 * - `effective`: what OpenCode applies (`unknown` when its config could not be
 *   read; never inferred from a missing skill). Also `unknown` while a scope's
 *   own file cannot be read (`scopes[scope].error`) and no deny decides the
 *   skill: OpenCode leaves an unparsable file out of `GET /api/config`, so a
 *   switch's deny in it is missing from what it serves, and the absence of a
 *   deny proves nothing. A deny that still decides it keeps it `disabled`.
 * - `decidedBy`: the statement that decides it and its file; `scope` says
 *   which switch owns that file (`other` for any file a switch never writes),
 *   `owned` whether it is a switch's own marked deny. OpenCode serves
 *   statements without the provenance key, so `owned` is read from the
 *   scope's file itself.
 *
 * `configs` holds each scope's parsed file, `null` when unavailable.
 */
function describeSkillPolicy(id, { entries, scopes, configs, location, samePath }) {
  const disabledIn = {};
  for (const scope of SKILL_POLICY_SCOPES) {
    disabledIn[scope] = configs[scope] ? listOwnedSkillDenies(configs[scope], location).includes(id) : null;
  }
  if (!entries) return { disabledIn, effective: UNKNOWN, decidedBy: null };

  const decided = findDecidingSkillStatement(entries, id, location);
  const scopeUnreadable = SKILL_POLICY_SCOPES.some((name) => scopes[name]?.error);
  if (scopeUnreadable && decided?.effect !== 'deny') return { disabledIn, effective: UNKNOWN, decidedBy: null };
  if (!decided) return { disabledIn, effective: 'enabled', decidedBy: null };
  const scope = SKILL_POLICY_SCOPES.find((name) => scopes[name] && decided.path && samePath(scopes[name].path, decided.path)) ?? 'other';
  return {
    disabledIn,
    effective: decided.effect === 'deny' ? 'disabled' : 'enabled',
    decidedBy: {
      ...decided,
      scope,
      owned: scope !== 'other' && configs[scope] !== null && isDecidedByOwnedDeny(configs[scope], id, location),
    },
  };
}

const realPathOrResolved = (filePath) => {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
};

// A config path OpenCode reports and the one OpenChamber computes can differ
// only by a link on the way (a linked `~/.config`, a linked project root).
const defaultSamePath = (left, right) => isString(left)
  && isString(right)
  && (path.resolve(left) === path.resolve(right) || realPathOrResolved(left) === realPathOrResolved(right));

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

const statusError = (status, code, message) => Object.assign(new Error(message), { status, code });

/**
 * @param {object} dependencies
 * @param {(directory: string | null) => { global: string, project: string | null }} dependencies.resolveTargets
 *   The config file each scope writes; project is `null` without a directory.
 * @param {(filePath: string) => object} dependencies.readConfigFile throws on invalid JSONC
 * @param {(left: string, right: string) => boolean} [dependencies.samePath]
 * @param {(ms: number) => Promise<void>} [dependencies.sleep]
 * @param {number} [dependencies.confirmAttempts] OpenCode reads after a write before reporting it unconfirmed
 * @param {number} [dependencies.confirmDelayMs]
 */
export function createSkillPolicyService({
  resolveTargets,
  readConfigFile,
  samePath = defaultSamePath,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  confirmAttempts = 8,
  confirmDelayMs = 250,
}) {
  // Writes run one at a time per process: read, change and write a file as
  // one step, so two switches flipped together cannot drop each other's rule.
  let writeQueue = Promise.resolve();
  const serialize = (task) => {
    const run = writeQueue.then(task, task);
    writeQueue = run.catch(() => {});
    return run;
  };

  const readScopes = (directory) => {
    const targets = resolveTargets(directory);
    const scopes = { global: { path: targets.global, error: null }, project: null };
    // A project directory whose config file is the global one (a project
    // opened at the OpenCode config directory) has no separate project scope.
    if (targets.project && !samePath(targets.project, targets.global)) {
      scopes.project = { path: targets.project, error: null };
    }
    return scopes;
  };

  const readText = (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null);

  // What a file's text holds as config: a missing, empty or comment-only file
  // holds none, as `readConfigFile` reads it.
  const configOfText = (text) => {
    if (text === null) return {};
    const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return parseJsonc(content, [], { allowTrailingComma: true }) ?? {};
  };

  const conflict = () => statusError(409, 'conflict', 'The config file changed while the switch was saved; nothing was written. Try again.');

  // Writes the switch into the text `text` was read as. Only the switch's own
  // list items change; a missing or empty file gets the config written whole.
  // Text the edit cannot carry, or a file that changed since `text` was read,
  // writes nothing: the file is never rewritten from an older read. The backup
  // matches the one the shared writer keeps.
  const writeSwitch = (filePath, text, before, config, id, disabled, location) => {
    const empty = text === null || text.trim() === '';
    const next = empty
      ? JSON.stringify(config, null, 2)
      : editSkillSwitchText(text, before, config, id, disabled, location);
    if (next === null) {
      throw statusError(409, 'invalid_config', 'The switch could not be written without rewriting the rest of the config file; nothing was written.');
    }
    if (readText(filePath) !== text) throw conflict();
    try {
      if (text !== null) fs.copyFileSync(filePath, `${filePath}.openchamber.backup`);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileAtomic(filePath, next);
    } catch (error) {
      console.error(`Failed to write config file: ${filePath}`, error);
      throw new Error('Failed to write OpenCode configuration');
    }
  };

  // Each scope's parsed file; an unreadable one is `null` with its error on the scope.
  const readConfigs = (scopes) => {
    const configs = { global: null, project: null };
    for (const scope of SKILL_POLICY_SCOPES) {
      const target = scopes[scope];
      if (!target) continue;
      try {
        configs[scope] = readConfigFile(target.path);
        target.error = null;
      } catch (error) {
        target.error = errorMessage(error);
      }
    }
    return configs;
  };

  const readOpenCode = async (openCode, directory) => {
    const [version, entries] = await Promise.all([
      openCode.readVersion().catch(() => null),
      openCode.readConfigEntries(directory).catch(() => null),
    ]);
    return { version, entries: Array.isArray(entries) ? entries : null };
  };

  const summarize = ({ version, location, entries, scopes }) => ({
    version,
    location,
    // `null`: OpenCode could not be read, or it enforces no skill policies.
    // Switches are read-only then; saved rules still show.
    writable: location !== null,
    effectiveAvailable: entries !== null,
    scopes,
  });

  /**
   * The policy state of `ids` in `directory`, plus every id a scope's file
   * switches off even when no skill with that id is installed any more, so it
   * can still be switched back on.
   */
  const readState = async ({ directory, ids, openCode }) => {
    const { version, entries } = await readOpenCode(openCode, directory);
    const location = skillPolicyLocation(version);
    const scopes = readScopes(directory);
    const configs = readConfigs(scopes);
    const allIds = new Set(ids.filter(isValidSkillPolicyId));
    for (const config of Object.values(configs)) for (const id of config ? listOwnedSkillDenies(config, location) : []) allIds.add(id);
    // A list with the id as a value: every valid id, `__proto__` included,
    // survives JSON and the UI's parser, which an object keyed by id does not.
    const skills = [...allIds].map((id) => ({ id, ...describeSkillPolicy(id, { entries, scopes, configs, location, samePath }) }));
    return { ...summarize({ version, location, entries, scopes }), skills };
  };

  // OpenCode has picked the file up when it serves the same enforced
  // statements the file holds (a missing document counts as none).
  const isConfirmed = (entries, targetPath, config, location) => {
    const document = entries.find((entry) => isDocument(entry) && isString(entry.path) && samePath(entry.path, targetPath));
    return JSON.stringify(servedForm(document?.info ?? {}, location)) === JSON.stringify(servedForm(config, location));
  };

  /**
   * Save `enabled` for `id` in one scope's file, then wait briefly for
   * OpenCode to pick it up. A failed write throws and changes nothing; a write
   * OpenCode has not confirmed yet resolves with `confirmed: false` and the
   * last state OpenCode reported (or `unknown`).
   */
  const setEnabled = async ({ directory, id, scope, enabled, openCode }) => {
    if (!isValidSkillPolicyId(id)) throw statusError(400, 'invalid_id', 'Invalid skill id');
    if (!SKILL_POLICY_SCOPES.includes(scope)) throw statusError(400, 'invalid_scope', 'Scope must be "global" or "project"');
    if (!isBoolean(enabled)) throw statusError(400, 'invalid_enabled', '"enabled" must be true or false');

    const version = await openCode.readVersion().catch(() => null);
    const location = skillPolicyLocation(version);
    if (!location) {
      throw version
        ? statusError(409, 'unsupported_version', `OpenCode ${version} does not enforce skill policies; 2.0.25 or newer does`)
        : statusError(503, 'opencode_unavailable', 'OpenCode is not reachable, so the skill switch cannot be saved');
    }

    const scopes = readScopes(directory);
    const target = scopes[scope];
    if (!target) throw statusError(409, 'scope_unavailable', 'This directory has no separate project config');

    const { config: written, changed } = await serialize(() => {
      // The text first: the change is made to what this text holds, and is
      // written only while the file still holds this text.
      let text;
      let config;
      try {
        text = readText(target.path);
        config = readConfigFile(target.path);
      } catch (error) {
        throw statusError(409, error?.code === 'INVALID_JSONC' ? 'invalid_config' : 'read_failed', errorMessage(error));
      }
      if (canonicalJson(configOfText(text)) !== canonicalJson(config)) throw conflict();
      const before = structuredClone(config);
      let didChange;
      try {
        didChange = setSkillDisabled(config, id, !enabled, location);
      } catch (error) {
        throw statusError(409, 'invalid_config', errorMessage(error));
      }
      if (didChange) writeSwitch(target.path, text, before, config, id, !enabled, location);
      return { config, changed: didChange };
    });

    // `disabled` is whether the scope's file now holds the switch's own deny:
    // off answers `false` when a deny the switch did not write already
    // decided the skill there, so nothing was added.
    const saved = { scope, path: target.path, disabled: listOwnedSkillDenies(written, location).includes(id), changed };
    let entries = null;
    let confirmed = false;
    for (let attempt = 0; attempt < confirmAttempts; attempt += 1) {
      if (attempt > 0) await sleep(confirmDelayMs);
      entries = await openCode.readConfigEntries(directory).then((value) => (Array.isArray(value) ? value : null), () => null);
      if (entries && isConfirmed(entries, target.path, written, location)) {
        confirmed = true;
        break;
      }
    }

    const configs = readConfigs(scopes);
    return {
      saved,
      confirmed,
      state: summarize({ version, location, entries, scopes }),
      policy: describeSkillPolicy(id, { entries, scopes, configs, location, samePath }),
    };
  };

  return { readState, setEnabled };
}

/** Records that skill id `id` is installed under display name `name`. */
export function addSkillIdName(ids, id, name) {
  if (!isValidSkillPolicyId(id)) return;
  if (!ids.has(id)) ids.set(id, new Set());
  ids.get(id).add(name);
}

/**
 * Every installed skill id with every display name it has: OpenCode's own
 * list, and every skill file the disk scan found (`discoverSkills(dir, { ids })`,
 * which records each file with `addSkillIdName`). The disk part does not depend
 * on OpenCode being warm, and nothing here is merged by display name, so an id
 * another skill's name hides is in it, and so is each name of an id whose
 * copies differ in name.
 */
export function collectSkillIds(openCodeSkills, diskIds) {
  const ids = new Map();
  for (const skill of openCodeSkills ?? []) addSkillIdName(ids, skill?.id, skill?.name);
  for (const [id, names] of diskIds) for (const name of names) addSkillIdName(ids, id, name);
  return ids;
}

/**
 * The id each listed skill's switch names (`switchId`): its own id when its
 * display name belongs to that one id and every name of that id belongs to it
 * alone. The list keeps one row per display name, and which copy a row shows
 * can change once OpenCode's own list arrives; with this rule no row's target
 * can change with it. Every other row gets `null`, and its id is never a row
 * switch anywhere, so it is switched on its own (`switchOnlyIds` in the UI).
 */
export function withSwitchIds(skills, ids) {
  const idsByName = new Map();
  for (const [id, names] of ids) {
    for (const name of names) {
      if (!idsByName.has(name)) idsByName.set(name, new Set());
      idsByName.get(name).add(id);
    }
  }
  const ownsItsNames = (id) => [...(ids.get(id) ?? [])].every((name) => idsByName.get(name)?.size === 1);
  return skills.map((skill) => {
    const named = idsByName.get(skill.name);
    const owned = named?.size === 1 && named.has(skill.id) && ownsItsNames(skill.id);
    return { ...skill, switchId: owned ? skill.id : null };
  });
}

/**
 * The write route both runtimes serve (`PUT /api/config/skill-policy`, body
 * `{ id, scope, enabled }`). `directory` is already validated by the runtime;
 * the project scope needs one. Only an installed id can be switched off;
 * switching on never adds a statement, so it needs no inventory check.
 * Answers `{ status, body }` instead of throwing.
 *
 * @param {object} input
 * @param {ReturnType<typeof createSkillPolicyService>} input.service
 * @param {(directory: string | null) => Promise<Set<string>>} input.listInstalledSkillIds
 */
export async function handleSkillPolicyWrite({ service, body, directory, openCode, listInstalledSkillIds }) {
  const id = isPlainObject(body) ? body.id : undefined;
  const scope = isPlainObject(body) ? body.scope : undefined;
  const enabled = isPlainObject(body) ? body.enabled : undefined;
  try {
    if (scope === 'project' && !directory) throw statusError(400, 'directory_required', 'The project scope needs a directory');
    if (enabled === false && isValidSkillPolicyId(id) && !(await listInstalledSkillIds(directory)).has(id)) {
      throw statusError(404, 'unknown_skill', `No installed skill has the id "${id}"`);
    }
    const result = await service.setEnabled({ directory, id, scope, enabled, openCode });
    return { status: 200, body: { ok: true, id, ...result } };
  } catch (error) {
    if (Number.isInteger(error?.status)) {
      return { status: error.status, body: { ok: false, error: { code: error.code, message: error.message } } };
    }
    console.error('Failed to save skill policy:', error);
    return { status: 500, body: { ok: false, error: { code: 'write_failed', message: errorMessage(error) } } };
  }
}
