/**
 * Which installed skills an agent can use, and how a typed skill name maps to
 * one skill.
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

const stateSchema = summarySchema.extend({
  skills: z.record(z.string(), entrySchema),
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
export const isSkillSwitchedOff = (policy: SkillPolicyState | null, id: string): boolean => (
  policy?.skills[id]?.effective === 'disabled'
);

type SkillIdentity = { id: string; name: string };

/**
 * Ids a scope's file switches off that the skills list does not have:
 * OpenCode stops listing a switched-off built-in or config-sourced skill, and
 * Settings still has to offer the switch that turns it back on.
 */
export const unlistedSwitchedOffIds = (
  skills: readonly SkillIdentity[],
  policy: SkillPolicyState | null,
): string[] => {
  if (!policy) return [];
  const listed = new Set(skills.map((skill) => skill.id));
  return Object.entries(policy.skills)
    .filter(([id, entry]) => !listed.has(id) && (entry.disabledIn.global === true || entry.disabledIn.project === true))
    .map(([id]) => id)
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
 * The one skill a typed `$token` or `/token` names. A display name names a
 * skill when no other skill shares it; otherwise only the id does. A name two
 * skills share and no id matches names none, so the send never picks one of
 * them at random.
 */
export const resolveSkillToken = <T extends SkillIdentity>(skills: readonly T[], token: string): T | null => {
  const byName = skills.filter((skill) => skill.name === token);
  if (byName.length === 1) return byName[0];
  return skills.find((skill) => skill.id === token) ?? null;
};

/** The token the composer inserts for a skill: its name, or its id when the name would resolve elsewhere. */
export const skillTokenFor = <T extends SkillIdentity>(skills: readonly T[], skill: T): string => (
  resolveSkillToken(skills, skill.name)?.id === skill.id ? skill.name : skill.id
);

/** The skills a message's tokens name, in order, once each; tokens naming no single skill are left out. */
export const resolveSkillMentions = <T extends SkillIdentity>(
  skills: readonly T[],
  tokens: readonly string[],
): Array<{ id: string; name: string }> => {
  const mentions: Array<{ id: string; name: string }> = [];
  for (const token of tokens) {
    const skill = resolveSkillToken(skills, token);
    if (skill && !mentions.some((mention) => mention.id === skill.id)) mentions.push({ id: skill.id, name: token });
  }
  return mentions;
};

/** Every token that resolves to some skill, for highlighting and mention collection. */
export const knownSkillTokens = (skills: readonly SkillIdentity[]): Set<string> => {
  const tokens = new Set<string>();
  for (const skill of skills) {
    tokens.add(skillTokenFor(skills, skill));
    tokens.add(skill.id);
  }
  return tokens;
};
