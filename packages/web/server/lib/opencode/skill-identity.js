/**
 * Selecting one skill by OpenCode skill id on the name-keyed skill routes
 * (`/api/config/skills/:name`, its `files/*` routes). Display names can
 * collide; the id (the folder of `SKILL.md`) cannot within one listing. Shared
 * by the web server and the VS Code extension host so both select alike.
 */
import path from 'path';
import { isValidSkillPolicyId } from './skill-policy.js';

/**
 * The optional `?id=` selector: `{ id: null }` when absent (legacy name
 * lookup), `{ id }` when valid, `{ error }` otherwise.
 */
export function readSkillIdSelector(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return { id: null, error: null };
  return isValidSkillPolicyId(raw) ? { id: raw, error: null } : { id: null, error: 'Invalid skill id' };
}

/**
 * The listed skill with this id and display name, or `null`. Never falls back
 * to another skill with the same name: a caller that named an id gets that id
 * or nothing.
 */
export function selectSkillById(skills, id, name) {
  return skills.find((skill) => skill?.id === id && skill?.name === name) ?? null;
}

const isStrictlyInside = (candidate, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * The folder a delete may remove for one skill file: the folder of a
 * `SKILL.md` that sits strictly inside a managed skill root, nested groups
 * included. `null` for anything else, so a `SKILL.md` placed directly in a
 * root never takes the whole root with it.
 */
export function skillFolderToDelete(skillMdPath, managedRoots) {
  if (!skillMdPath || path.basename(skillMdPath) !== 'SKILL.md') return null;
  const folder = path.dirname(path.resolve(skillMdPath));
  return managedRoots.some((root) => isStrictlyInside(folder, root)) ? folder : null;
}
