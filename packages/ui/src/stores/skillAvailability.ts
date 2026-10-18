/**
 * Which installed skills an agent can use.
 *
 * The skills list is the installed inventory: OpenCode's own list merged with
 * a disk scan, so a skill switched off by an `integration.use` deny is still
 * in it. The server reports the policy state next to it (`skillPolicy`, see the
 * "Per-skill switches" section of `packages/web/server/lib/opencode/DOCUMENTATION.md`).
 * A skill is available unless that state says it is switched off; an unknown
 * state, a failed read or a skill missing from the policy keeps it available,
 * because absence from a cold OpenCode list proves nothing.
 */
import { z } from 'zod';

export type SkillPolicyScope = 'global' | 'project';

const scopeTargetSchema = z.object({
  path: z.string(),
  error: z.string().nullable(),
});

const decisionSchema = z.object({
  path: z.string().nullable(),
  resource: z.string(),
  effect: z.enum(['allow', 'deny']),
  scope: z.enum(['global', 'project', 'other']),
  owned: z.boolean(),
});

const entrySchema = z.object({
  disabledIn: z.object({
    global: z.boolean().nullable(),
    project: z.boolean().nullable(),
  }),
  effective: z.enum(['enabled', 'disabled', 'unknown']),
  decidedBy: decisionSchema.nullable(),
});

const summarySchema = z.object({
  version: z.string().nullable(),
  location: z.enum(['experimental.policies', 'policies']).nullable(),
  writable: z.boolean(),
  effectiveAvailable: z.boolean(),
  scopes: z.object({
    global: scopeTargetSchema,
    project: scopeTargetSchema.nullable(),
  }),
});

// The server lists entries with their id as a value, and they are kept in a
// Map: every valid id, `__proto__` included, is a key there, while a zod
// record and a plain object both lose that one.
const stateSchema = summarySchema.extend({
  skills: z.array(entrySchema.extend({ id: z.string() }))
    .transform((entries) => new Map(entries.map(({ id, ...entry }) => [id, entry]))),
});

/** One skill's policy: the switch's own rule per scope, and what OpenCode applies. */
export type SkillPolicyEntry = z.infer<typeof entrySchema>;
/** The policy state of one directory's skills. */
export type SkillPolicyState = z.infer<typeof stateSchema>;

const readErrorSchema = z.object({ error: z.string() });

/**
 * The `skillPolicy` of a skills list answer: the state, the error the server
 * reported instead, or nothing (an answer without the field, or a shape this
 * build does not know, which counts as not read).
 */
export type SkillPolicyRead =
  | { kind: 'state'; state: SkillPolicyState }
  | { kind: 'error'; message: string }
  | { kind: 'absent' };

export const parseSkillPolicyRead = (value: z.input<typeof stateSchema> | z.input<typeof readErrorSchema> | null | undefined): SkillPolicyRead => {
  const state = stateSchema.safeParse(value);
  if (state.success) return { kind: 'state', state: state.data };
  const failure = readErrorSchema.safeParse(value);
  if (failure.success) return { kind: 'error', message: failure.data.error };
  return { kind: 'absent' };
};

const writeSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  saved: z.object({
    scope: z.enum(['global', 'project']),
    path: z.string(),
    disabled: z.boolean(),
    changed: z.boolean(),
  }),
  confirmed: z.boolean(),
  state: summarySchema,
  policy: entrySchema,
});

const writeFailureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
});

export type SkillPolicyWrite = z.infer<typeof writeSuccessSchema>;

/** A `PUT /api/config/skill-policy` answer, or the reason it is not one. */
export type SkillPolicyWriteResult =
  | { ok: true; write: SkillPolicyWrite }
  | { ok: false; code: string; message: string };

export const parseSkillPolicyWrite = (
  value: z.input<typeof writeSuccessSchema> | z.input<typeof writeFailureSchema> | null,
  status: number,
): SkillPolicyWriteResult => {
  const success = writeSuccessSchema.safeParse(value);
  if (success.success) return { ok: true, write: success.data };
  const failure = writeFailureSchema.safeParse(value);
  if (failure.success) return { ok: false, code: failure.data.error.code, message: failure.data.error.message };
  return { ok: false, code: 'invalid_response', message: `Unexpected answer (HTTP ${status})` };
};

/** Whether OpenCode lets agents use the skill, as far as the policy state knows. */
const isSkillSwitchedOff = (policy: SkillPolicyState | null, id: string): boolean => (
  policy?.skills.get(id)?.effective === 'disabled'
);

type SkillIdentity = { id: string; name: string };

/**
 * Ids the policy state has that no row's switch names (`switchId`). The list
 * keeps one row per display name, so every id of a name several ids share is
 * here, as is a switched-off id OpenCode no longer lists (a built-in, say).
 * Settings offers the switches of each such id on its own.
 */
export const switchOnlyIds = (
  skills: readonly { switchId: string | null }[],
  policy: SkillPolicyState | null,
): string[] => {
  if (!policy) return [];
  const listed = new Set(skills.map((skill) => skill.switchId));
  return [...policy.skills.keys()]
    .filter((id) => !listed.has(id))
    .sort((a, b) => a.localeCompare(b));
};

/**
 * The skills of `skills` agents can use. Returns `skills` itself when nothing
 * is switched off, so a store can keep one stable array.
 */
export const filterAvailableSkills = <T extends SkillIdentity>(
  skills: T[],
  policy: SkillPolicyState | null,
): T[] => {
  if (!policy || !skills.some((skill) => isSkillSwitchedOff(policy, skill.id))) return skills;
  return skills.filter((skill) => !isSkillSwitchedOff(policy, skill.id));
};

/**
 * Whether the policy state proves that a switch-only `id` is gone. Only a read
 * that succeeded, reached OpenCode (`effectiveAvailable`: its own list holds
 * ids no skill file has, a built-in say) and read every scope's file lists
 * every installed id and every switch rule, so only then does a missing id
 * have nothing left to switch. Otherwise the id's skill or rule may be hidden:
 * nothing is concluded, and the page keeps the id with the read error.
 */
export const isSwitchOnlyIdGone = (
  view: { state: SkillPolicyState | null; error: string | null } | null,
  id: string,
): boolean => {
  const state = view?.state;
  if (!state || view?.error || !state.effectiveAvailable) return false;
  if (state.scopes.global.error || state.scopes.project?.error) return false;
  return !state.skills.has(id);
};
