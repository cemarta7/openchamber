import { describe, expect, test } from 'bun:test';
import {
  filterAvailableSkills,
  isSwitchOnlyIdGone,
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

describe('filterAvailableSkills', () => {
  // The store keeps one stable array while nothing is off.
  test('keeps the same array when nothing is off, or nothing was read', () => {
    const skills = [{ id: 'deploy-web', name: 'deploy' }];
    expect(filterAvailableSkills(skills, null)).toBe(skills);
    expect(filterAvailableSkills(skills, state({ 'deploy-web': entry('enabled') }))).toBe(skills);
  });
});

describe('parseSkillPolicyWrite', () => {
  test('a write answer that is neither success nor error is a failure', () => {
    expect(parseSkillPolicyWrite(null, 502)).toEqual({ ok: false, code: 'invalid_response', message: 'Unexpected answer (HTTP 502)' });
    expect(parseSkillPolicyWrite({ ok: false, error: { code: 'write_failed', message: 'disk full' } }, 500))
      .toEqual({ ok: false, code: 'write_failed', message: 'disk full' });
  });
});

describe('switchOnlyIds', () => {
  test('lists every id the policy has that no row switch names, on or off', () => {
    const policy = state({
      'deploy-web': entry('disabled', { global: true, project: false }),
      'built-in-review': entry('disabled', { global: null, project: true }),
      'deploy-api': entry('enabled'),
      'code-audit': entry('enabled'),
    });
    // `deploy-web` has its row switch; the `audit` row has none, because
    // another id shares its display name, so its id is switched on its own.
    const rows = [{ switchId: 'deploy-web' }, { switchId: null }];
    expect(switchOnlyIds(rows, policy)).toEqual(['built-in-review', 'code-audit', 'deploy-api']);
    expect(switchOnlyIds(rows, null)).toEqual([]);
  });
});

describe('isSwitchOnlyIdGone', () => {
  const complete = state({ 'deploy-web': entry('enabled') });
  test('only a successful read with every scope file read proves an id gone', () => {
    expect(isSwitchOnlyIdGone({ state: complete, error: null }, 'old-rule')).toBe(true);
    expect(isSwitchOnlyIdGone({ state: complete, error: null }, 'deploy-web')).toBe(false);
  });

  test('an unreadable scope file, a failed read or no read concludes nothing', () => {
    const projectUnreadable = { ...complete, scopes: { ...complete.scopes, project: { path: '/p/opencode.json', error: 'EACCES' } } };
    const globalUnreadable = { ...complete, scopes: { ...complete.scopes, global: { path: '/config/opencode.json', error: 'EACCES' } } };
    expect(isSwitchOnlyIdGone({ state: projectUnreadable, error: null }, 'old-rule')).toBe(false);
    expect(isSwitchOnlyIdGone({ state: globalUnreadable, error: null }, 'old-rule')).toBe(false);
    expect(isSwitchOnlyIdGone({ state: complete, error: 'OpenCode is not running' }, 'old-rule')).toBe(false);
    // OpenCode down while both files read fine: the server answers a state
    // without effective data, and an OpenCode-only id (a built-in) is missing.
    const openCodeDown = { ...complete, version: null, location: null, writable: false, effectiveAvailable: false, skills: new Map() };
    expect(isSwitchOnlyIdGone({ state: openCodeDown, error: null }, 'built-in-review')).toBe(false);
    expect(isSwitchOnlyIdGone({ state: null, error: null }, 'old-rule')).toBe(false);
    expect(isSwitchOnlyIdGone(null, 'old-rule')).toBe(false);
  });
});
