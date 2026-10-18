import { describe, expect, test } from 'bun:test';
import {
  filterAvailableSkills,
  parseSkillPolicyRead,
  parseSkillPolicyWrite,
  switchOnlyIds,
  type SkillPolicyEntry,
  type SkillPolicyState,
} from './skillAvailability';

const entry = (effective: SkillPolicyEntry['effective'], disabledIn: SkillPolicyEntry['disabledIn'] = { global: false, project: false }): SkillPolicyEntry => ({
  disabledIn,
  effective,
  decidedBy: null,
});

const state = (skills: Record<string, SkillPolicyEntry>): SkillPolicyState => ({
  version: '2.0.29',
  location: 'policies',
  writable: true,
  effectiveAvailable: true,
  scopes: { global: { path: '/config/opencode.json', error: null }, project: null },
  skills: new Map(Object.entries(skills)),
});

const web = { id: 'deploy-web', name: 'deploy' };
const api = { id: 'deploy-api', name: 'deploy' };
const audit = { id: 'code-audit', name: 'audit' };

describe('filterAvailableSkills', () => {
  test('drops only skills the policy reports switched off', () => {
    const skills = [web, api, audit];
    const policy = state({ 'deploy-web': entry('disabled'), 'deploy-api': entry('unknown'), 'code-audit': entry('enabled') });
    expect(filterAvailableSkills(skills, policy)).toEqual([api, audit]);
  });

  test('keeps the same array when nothing is off, or nothing was read', () => {
    const skills = [web, audit];
    expect(filterAvailableSkills(skills, null)).toBe(skills);
    expect(filterAvailableSkills(skills, state({ 'deploy-web': entry('enabled') }))).toBe(skills);
  });
});

describe('policy parsing', () => {
  test('an error and an unknown shape are not a state', () => {
    expect(parseSkillPolicyRead({ error: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
    expect(parseSkillPolicyRead(undefined)).toEqual({ kind: 'absent' });
    expect(parseSkillPolicyRead({ ...state({}), skills: [] }).kind).toBe('state');
  });

  test('a write answer that is neither success nor error is a failure', () => {
    expect(parseSkillPolicyWrite(null, 502)).toEqual({ ok: false, code: 'invalid_response', message: 'Unexpected answer (HTTP 502)' });
    expect(parseSkillPolicyWrite({ ok: false, error: { code: 'write_failed', message: 'disk full' } }, 500))
      .toEqual({ ok: false, code: 'write_failed', message: 'disk full' });
  });
});

describe('switchOnlyIds', () => {
  test('lists every id the policy has that no row carries, on or off', () => {
    const policy = state({
      'deploy-web': entry('disabled', { global: true, project: false }),
      'built-in-review': entry('disabled', { global: null, project: true }),
      // A second id behind a display name another row shows.
      'deploy-api': entry('enabled'),
    });
    expect(switchOnlyIds([web], policy)).toEqual(['built-in-review', 'deploy-api']);
    expect(switchOnlyIds([web], null)).toEqual([]);
  });
});
