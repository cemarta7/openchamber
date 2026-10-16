import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

const activeProjectPath = '/workspace/project-with-agents-skills';

let runtimeFetchCalls: Array<{ url: string; init?: RuntimeFetchOptions }> = [];
let runtimeFetchImpl: (url: string, init?: RuntimeFetchOptions) => Promise<Response> = async () => (
  new Response(JSON.stringify({ skills: [] }), {
    headers: { 'Content-Type': 'application/json' },
  })
);
let getDirectoryImpl: () => string | undefined = () => undefined;

const runtimeFetchMock = async (url: string, init?: RuntimeFetchOptions) => {
  runtimeFetchCalls.push({ url: String(url), init });
  return runtimeFetchImpl(url, init);
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => getDirectoryImpl(),
    checkHealth: async () => true,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => ({ path: activeProjectPath }),
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

mock.module('@/lib/background-network', () => ({
  runBackgroundNetworkTask: async <T,>(task: () => Promise<T>) => task(),
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

const { invalidateSkillsLoadCache, useSkillsStore } = await import('./useSkillsStore');

describe('useSkillsStore directory resolution', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    getDirectoryImpl = () => undefined;
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [{
        name: 'repo-local-skill',
        path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
        scope: 'project',
        source: 'agents',
        sources: { md: { description: 'Repository local' } },
      }],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    invalidateSkillsLoadCache(activeProjectPath);
    invalidateSkillsLoadCache('/workspace/other-project');
    useSkillsStore.setState({
      selectedSkillId: null,
      skills: [],
      skillsByDirectory: {},
      isLoading: false,
      skillDraft: null,
    });
  });

  test('loading another project leaves the active project\'s skills alone', async () => {
    // Settings can browse a project the app is not on. Chat autocompletes read
    // `skills`, so that list must keep describing the active project.
    const activeSkills = [{
      id: 'active-only',
      name: 'active-only',
      path: `${activeProjectPath}/.agents/skills/active-only/SKILL.md`,
      scope: 'project' as const,
      source: 'agents' as const,
      description: 'Active project skill',
      group: undefined,
      renamable: false,
    }];
    useSkillsStore.setState({
      skills: activeSkills,
      skillsByDirectory: { [activeProjectPath]: activeSkills },
    });

    const loaded = await useSkillsStore.getState().loadSkills('/workspace/other-project');

    expect(loaded).toBe(true);
    expect(runtimeFetchCalls[0]?.url).toContain(`directory=${encodeURIComponent('/workspace/other-project')}`);
    const state = useSkillsStore.getState();
    expect(state.skills).toEqual(activeSkills);
    expect(state.skillsByDirectory['/workspace/other-project']?.map((skill) => skill.name)).toEqual(['repo-local-skill']);
  });

  test('loadSkills scopes discovery to the active project even when client directory is unset', async () => {
    const loaded = await useSkillsStore.getState().loadSkills();

    expect(loaded).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);
    expect(runtimeFetchCalls[0]?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);
    expect(useSkillsStore.getState().skills).toEqual([{
      id: 'repo-local-skill',
      name: 'repo-local-skill',
      path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
      scope: 'project',
      source: 'agents',
      description: 'Repository local',
      group: undefined,
      renamable: false,
    }]);
  });

  test('loadSkills maps authoritative renamable from the list response', async () => {
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [
        {
          name: 'managed-skill',
          path: `${activeProjectPath}/.opencode/skills/managed-skill/SKILL.md`,
          scope: 'project',
          source: 'opencode',
          renamable: true,
          sources: { md: { description: 'Managed' } },
        },
        {
          name: 'cache-skill',
          path: '/home/ubuntu/.cache/opencode/skills/hash/cache-skill/SKILL.md',
          scope: 'user',
          source: 'opencode',
          renamable: false,
          sources: { md: { description: 'Cache' } },
        },
      ],
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills).toEqual([
      {
        id: 'managed-skill',
        name: 'managed-skill',
        path: `${activeProjectPath}/.opencode/skills/managed-skill/SKILL.md`,
        scope: 'project',
        source: 'opencode',
        description: 'Managed',
        group: undefined,
        renamable: true,
      },
      {
        id: 'cache-skill',
        name: 'cache-skill',
        path: '/home/ubuntu/.cache/opencode/skills/hash/cache-skill/SKILL.md',
        scope: 'user',
        source: 'opencode',
        description: 'Cache',
        group: 'hash',
        renamable: false,
      },
    ]);
  });

  test('renameSkill uses getRequestDirectory query and x-opencode-directory header', async () => {
    runtimeFetchImpl = async (_url, init) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          success: true,
          requiresReload: false,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        skills: [{
          name: 'new-skill',
          path: `${activeProjectPath}/.opencode/skills/new-skill/SKILL.md`,
          scope: 'project',
          source: 'opencode',
          renamable: true,
          sources: { md: { description: 'Renamed' } },
        }],
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const renamed = await useSkillsStore.getState().renameSkill({ id: 'old-skill', name: 'old-skill' }, 'new-skill');
    expect(renamed).toBe(true);

    const renameCall = runtimeFetchCalls.find((call) => String(call.url).includes('/api/config/skills/old-skill'));
    expect(renameCall).toBeTruthy();
    expect(renameCall?.init?.query).toEqual({ id: 'old-skill', directory: activeProjectPath });

    const headers = new Headers(renameCall?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-opencode-directory')).toBe(activeProjectPath);
  });

  test('invalidateSkillsLoadCache() with no argument clears the active-project cache key used by loadSkills', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);

    // Wrong key: client-directory-first null maps to __default__, not the active project.
    invalidateSkillsLoadCache(null);
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(1);

    // Default resolution must match loadSkills (active project first).
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(2);
    expect(runtimeFetchCalls[1]?.url).toContain(`directory=${encodeURIComponent(activeProjectPath)}`);
  });
  test('a partial list keeps previously known OpenCode skills and is not cached as fresh', async () => {
    const builtIn = {
      id: 'OpenCode',
      name: 'OpenCode',
      path: '<built-in>',
      scope: 'user' as const,
      source: 'opencode' as const,
      description: 'Built-in',
      group: undefined,
      renamable: false,
    };
    const deletedManaged = {
      id: 'deleted-managed',
      name: 'deleted-managed',
      path: `${activeProjectPath}/.opencode/skills/deleted-managed/SKILL.md`,
      scope: 'project' as const,
      source: 'opencode' as const,
      description: 'Gone from disk',
      group: undefined,
      renamable: true,
    };
    useSkillsStore.setState({
      skills: [builtIn, deletedManaged],
      skillsByDirectory: { [activeProjectPath]: [builtIn, deletedManaged] },
    });
    const diskOnly = {
      name: 'repo-local-skill',
      path: `${activeProjectPath}/.agents/skills/repo-local-skill/SKILL.md`,
      scope: 'project',
      source: 'agents',
      sources: { md: { description: 'Repository local' } },
    };
    runtimeFetchImpl = async () => new Response(JSON.stringify({
      skills: [diskOnly],
      openCodeSkillsUnavailable: true,
    }), { headers: { 'Content-Type': 'application/json' } });

    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(['repo-local-skill', 'OpenCode']);

    // Not cached: the next load asks again, and a complete answer is authoritative.
    runtimeFetchImpl = async () => new Response(JSON.stringify({ skills: [diskOnly] }), {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(runtimeFetchCalls.length).toBe(2);
    expect(useSkillsStore.getState().skills.map((skill) => skill.name)).toEqual(['repo-local-skill']);
  });
});

const jsonResponse = (json: string) => new Response(json, {
  headers: { 'Content-Type': 'application/json' },
});

// Two OpenCode ids whose frontmatter shares the display name `deploy`.
const deployWeb = {
  id: 'deploy-web',
  name: 'deploy',
  path: `${activeProjectPath}/.agents/skills/deploy-web/SKILL.md`,
  scope: 'project',
  source: 'agents',
  renamable: true,
  sources: { md: { description: 'Web' } },
};
const deployApi = {
  id: 'deploy-api',
  name: 'deploy',
  path: '/shared/skills/deploy-api/SKILL.md',
  scope: 'user',
  source: 'opencode',
  renamable: false,
  sources: { md: { description: 'API' } },
};

describe('useSkillsStore skill identity', () => {
  beforeEach(() => {
    runtimeFetchCalls = [];
    getDirectoryImpl = () => undefined;
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [deployWeb, deployApi] }));
    invalidateSkillsLoadCache(activeProjectPath);
    useSkillsStore.setState({
      selectedSkillId: null,
      skills: [],
      skillsByDirectory: {},
      isLoading: false,
      skillDraft: null,
    });
  });

  test('two ids sharing a display name stay two rows through full and partial loads', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);

    // OpenCode's list failed and the disk scan found only one of them. The
    // other id is not on a managed root, so it is carried over, not dropped
    // because its display name matches.
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [deployWeb], openCodeSkillsUnavailable: true }));
    invalidateSkillsLoadCache();
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual(['deploy-web', 'deploy-api']);
    expect(useSkillsStore.getState().getSkillById('deploy-api')?.path).toBe(deployApi.path);
  });

  test('an entry without an id keeps the id its folder gives it', async () => {
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({
      skills: [{ name: 'Display Name', path: `${activeProjectPath}/.opencode/skills/folder-id/SKILL.md` }],
    }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    expect(useSkillsStore.getState().skills.map((skill) => [skill.id, skill.name])).toEqual([['folder-id', 'Display Name']]);
  });

  test('source copies of one id stay one row, the .agents copy winning', async () => {
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({
      skills: [
        { id: 'dup', name: 'dup', path: `${activeProjectPath}/.claude/skills/dup/SKILL.md` },
        { id: 'dup', name: 'dup', path: `${activeProjectPath}/.agents/skills/dup/SKILL.md` },
      ],
      externalSkills: { claudeDisabled: false, allDisabled: false },
    }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    const skills = useSkillsStore.getState().skills;
    expect(skills).toHaveLength(1);
    expect(skills[0]?.path).toContain('/.agents/');
  });

  test('each of two ids sharing a display name is read and changed through its own id', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    // A server that honours the `id` selector answers for exactly that skill.
    const byId = new Map([[deployWeb.id, deployWeb], [deployApi.id, deployApi]]);
    const isListCall = (url: string) => url.startsWith('/api/config/skills?');
    runtimeFetchImpl = async (url, init) => {
      if (isListCall(url)) return jsonResponse(JSON.stringify({ skills: [deployWeb, deployApi] }));
      const query = init?.query instanceof URLSearchParams ? null : init?.query;
      const target = byId.get(String(query?.id));
      if (!target) return new Response(null, { status: 404 });
      if (url.includes('/files/')) return jsonResponse(JSON.stringify({ content: `notes of ${target.id}` }));
      if (init?.method) return jsonResponse(JSON.stringify({ success: true, requiresReload: false }));
      return jsonResponse(JSON.stringify({
        name: target.name,
        sources: { md: { exists: true, path: target.path, dir: null, fields: [], supportingFiles: [] } },
      }));
    };
    const store = useSkillsStore.getState();

    for (const listed of [deployWeb, deployApi]) {
      const skill = store.getSkillById(listed.id);
      if (!skill) throw new Error(`${listed.id} not loaded`);
      runtimeFetchCalls = [];

      expect((await store.getSkillDetail(skill))?.sources.md.path).toBe(listed.path);
      expect(await store.readSupportingFile(skill, 'notes.md')).toBe(`notes of ${listed.id}`);
      expect(await store.writeSupportingFile(skill, 'notes.md', 'text')).toBe(true);
      expect(await store.deleteSupportingFile(skill, 'notes.md')).toBe(true);
      expect(await store.updateSkill(skill, { description: 'Edited' })).toBe(true);
      expect(await store.renameSkill(skill, `${listed.id}-renamed`)).toBe(true);
      expect(await store.deleteSkill(skill)).toBe(true);

      // Every call keeps the display name in the path and selects by id.
      const skillCalls = runtimeFetchCalls.filter((call) => !isListCall(call.url));
      expect(skillCalls).toHaveLength(7);
      for (const call of skillCalls) {
        expect(call.url.startsWith('/api/config/skills/deploy')).toBe(true);
        expect(call.init?.query).toEqual({ id: listed.id, directory: activeProjectPath });
      }
      const patch = skillCalls.find((call) => call.init?.method === 'PATCH' && String(call.init.body).includes('description'));
      expect(JSON.parse(String(patch?.init?.body)).targetPath).toBe(listed.path);
    }
  });

  test('deleting the selected skill clears the selection', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method
      ? { success: true, requiresReload: false }
      : { skills: [deployWeb] }));
    useSkillsStore.getState().setSelectedSkill(deployApi.id);
    expect(await useSkillsStore.getState().deleteSkill(deployApi)).toBe(true);
    expect(useSkillsStore.getState().selectedSkillId).toBe(null);
  });

  test('a lower-priority copy of a deleted id comes back from the refreshed list', async () => {
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);
    // Delete removed the effective `.agents` copy; the `.claude` copy of the
    // same id is what OpenCode loads now.
    const remainingCopy = { ...deployWeb, path: `${activeProjectPath}/.claude/skills/deploy-web/SKILL.md`, source: 'claude' };
    runtimeFetchImpl = async (_url, init) => jsonResponse(JSON.stringify(init?.method
      ? { success: true, requiresReload: false }
      : { skills: [remainingCopy, deployApi] }));
    useSkillsStore.getState().setSelectedSkill(deployWeb.id);

    expect(await useSkillsStore.getState().deleteSkill(deployWeb)).toBe(true);
    expect(useSkillsStore.getState().getSkillById(deployWeb.id)?.path).toBe(remainingCopy.path);
    expect(useSkillsStore.getState().selectedSkillId).toBe(deployWeb.id);
  });

  test('a detail answer for another file is dropped', async () => {
    const skill = {
      id: 'folder-id',
      name: 'display',
      path: `${activeProjectPath}/.opencode/skills/folder-id/SKILL.md`,
    };
    runtimeFetchImpl = async () => jsonResponse(JSON.stringify({ skills: [skill] }));
    expect(await useSkillsStore.getState().loadSkills()).toBe(true);

    const detailFor = (path: string) => jsonResponse(JSON.stringify({
      name: 'display',
      sources: { md: { exists: true, path, dir: null, fields: [], supportingFiles: [] } },
    }));
    runtimeFetchImpl = async () => detailFor(`${activeProjectPath}/.opencode/skills/display/SKILL.md`);
    expect(await useSkillsStore.getState().getSkillDetail(skill)).toBe(null);

    runtimeFetchImpl = async () => detailFor(skill.path);
    expect((await useSkillsStore.getState().getSkillDetail(skill))?.sources.md.path).toBe(skill.path);
  });
});
