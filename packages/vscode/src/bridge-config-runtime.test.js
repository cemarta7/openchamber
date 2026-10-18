import { afterEach, describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

mock.module('vscode', () => ({
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: () => undefined }),
  },
}));

// Point the user-level OpenCode config at a scratch directory BEFORE importing:
// the bridge writes agents, commands and plugins there, and a built-in agent
// such as `build` is materialised as a user-level file. Nothing here may touch
// the real ~/.config/opencode.
const scratchConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-bridge-config-'));
process.env.XDG_CONFIG_HOME = path.join(scratchConfigRoot, 'xdg');
process.env.OPENCODE_CONFIG_DIR = '';

const { handleConfigBridgeMessage } = await import('./bridge-config-runtime.ts');

const tempRoots = [];
const originalOpencodeConfig = process.env.OPENCODE_CONFIG;

const createCtx = (workingDirectory, restartImpl = async () => undefined) => {
  const restart = mock(restartImpl);
  return {
    restart,
    manager: {
      getWorkingDirectory: () => workingDirectory,
      restart,
    },
  };
};

const deps = {
  readSettings: () => ({}),
  persistSettings: async (changes) => changes,
  readMagicPromptOverrides: () => ({ version: 1, overrides: {} }),
  saveMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetMagicPromptOverride: async () => ({ version: 1, overrides: {} }),
  resetAllMagicPromptOverrides: async () => ({ version: 1, overrides: {} }),
  fetchOpenCodeSkillsFromApi: async () => null,
  createOpenCodePolicyReader: () => ({
    readVersion: async () => { throw new Error('OpenCode is not running'); },
    readConfigEntries: async () => { throw new Error('OpenCode is not running'); },
  }),
  clientReloadDelayMs: 800,
};

afterEach(() => {
  if (originalOpencodeConfig === undefined) {
    delete process.env.OPENCODE_CONFIG;
  } else {
    process.env.OPENCODE_CONFIG = originalOpencodeConfig;
  }

  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
// A `skillPolicy` answer's entries by id.
const byId = (skillPolicy) => new Map(skillPolicy.skills.map(({ id, ...entry }) => [id, entry]));

describe('VS Code config bridge plugin parity', () => {
  test('explicit config reload restarts OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-reload-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const reloaded = await handleConfigBridgeMessage({
      id: 'reload',
      type: 'api:config/reload',
    }, ctx, deps);

    expect(reloaded).toEqual({
      id: 'reload',
      type: 'api:config/reload',
      success: true,
      data: { restarted: true },
    });
    expect(ctx.restart).toHaveBeenCalledTimes(1);
  });

  test('removes agent fields when update payload sends null', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-agent-null-'));
    tempRoots.push(root);
    const ctx = createCtx(root);
    const configDir = path.join(root, '.opencode');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
      agent: {
        build: {
          variant: 'fast',
          temperature: 0.3,
          top_p: 0.8,
          mode: 'subagent',
        },
      },
    }, null, 2), 'utf8');

    const updated = await handleConfigBridgeMessage({
      id: 'update-agent-null-fields',
      type: 'api:config/agents',
      payload: {
        method: 'PATCH',
        name: 'build',
        directory: root,
        body: { variant: null, temperature: null, top_p: null },
      },
    }, ctx, deps);

    expect(updated?.success).toBe(true);
    // The v1 `agent` entry is rewritten in place as a v2 `agents` entry, and the
    // cleared v1 fields are removed from where v2 keeps them: `variant` off the
    // model reference, `temperature`/`top_p` out of `request.body`.
    const agentConfig = readJson(configPath);
    expect(agentConfig.agent).toBeUndefined();
    expect(agentConfig.agents.build).toEqual({ mode: 'subagent' });
  });

  test('creates, lists, updates, and deletes project plugin entries', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugins-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'entry',
        directory: root,
        body: { scope: 'project', spec: 'plugin-a', options: { enabled: true } },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'Plugin entry changed.',
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entries = listed?.data?.entries || [];
    const entry = entries.find((candidate) => candidate.spec === 'plugin-a');
    expect(entry?.scope).toBe('project');

    const updated = await handleConfigBridgeMessage({
      id: 'update',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'plugin-b' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(root, '.opencode', 'opencode.json'), 'utf8'));
    expect(config.plugin).toBeUndefined();
    expect(config.plugins).toEqual([{ package: 'plugin-b', options: { enabled: true } }]);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'plugin-b');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
  });

  test('creates and reads project plugin files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-plugin-files-'));
    tempRoots.push(root);
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'project', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);
    expect(created?.success).toBe(true);

    const listed = await handleConfigBridgeMessage({
      id: 'list',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const files = listed?.data?.files || [];
    const file = files.find((candidate) => candidate.fileName === 'demo-plugin.ts');
    expect(file?.scope).toBe('project');

    const read = await handleConfigBridgeMessage({
      id: 'read-file',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'file', directory: root, pluginId: file?.id },
    }, ctx, deps);
    expect(read?.data).toEqual({ fileName: 'demo-plugin.ts', scope: 'project', content: 'export default {}' });
  });

  test('updates and deletes user plugin entries from OPENCODE_CONFIG source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-config-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ plugin: ['custom-plugin'] }, null, 2), 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const listed = await handleConfigBridgeMessage({
      id: 'list-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const entry = (listed?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin');
    expect(entry?.scope).toBe('user');

    const updated = await handleConfigBridgeMessage({
      id: 'update-custom',
      type: 'api:config/plugins',
      payload: {
        method: 'PATCH',
        target: 'entry',
        directory: root,
        pluginId: entry?.id,
        body: { spec: 'custom-plugin-next' },
      },
    }, ctx, deps);
    expect(updated?.success).toBe(true);
    // Touching one entry migrates the whole v1 `plugin` array into v2 `plugins`.
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toEqual(['custom-plugin-next']);

    const relisted = await handleConfigBridgeMessage({
      id: 'relist-custom',
      type: 'api:config/plugins',
      payload: { method: 'GET', target: 'list', directory: root },
    }, ctx, deps);
    const updatedEntry = (relisted?.data?.entries || []).find((candidate) => candidate.spec === 'custom-plugin-next');

    const deleted = await handleConfigBridgeMessage({
      id: 'delete-custom',
      type: 'api:config/plugins',
      payload: { method: 'DELETE', target: 'entry', directory: root, pluginId: updatedEntry?.id },
    }, ctx, deps);
    expect(deleted?.success).toBe(true);
    expect(readJson(configPath).plugin).toBeUndefined();
    expect(readJson(configPath).plugins).toBeUndefined();
  });

  test('writes user plugin files next to OPENCODE_CONFIG', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-custom-files-'));
    tempRoots.push(root);
    const configDir = path.join(root, 'custom-config');
    const configPath = path.join(configDir, 'opencode.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, '{}', 'utf8');
    process.env.OPENCODE_CONFIG = configPath;
    const ctx = createCtx(root);

    const created = await handleConfigBridgeMessage({
      id: 'create-custom-file',
      type: 'api:config/plugins',
      payload: {
        method: 'POST',
        target: 'file',
        directory: root,
        body: { scope: 'user', fileName: 'demo-plugin.ts', content: 'export default {}' },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(fs.readFileSync(path.join(configDir, 'plugins', 'demo-plugin.ts'), 'utf8')).toBe('export default {}');
  });

  // OpenCode 2 watches its config sources, so a write is live as soon as it
  // lands: there is no restart to defer and no restart that can fail. The
  // mutation just reports where it wrote.
  test('creates an MCP server under mcp.servers without restarting OpenCode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-mcp-create-'));
    tempRoots.push(root);
    const ctx = createCtx(root, async () => {
      throw new Error('restart failed');
    });
    const configPath = path.join(root, '.opencode', 'opencode.json');

    const created = await handleConfigBridgeMessage({
      id: 'create-mcp',
      type: 'api:config/mcp',
      payload: {
        method: 'POST',
        name: 'mcp-server',
        directory: root,
        body: { scope: 'project', type: 'local', command: ['node', 'server.js'], enabled: false },
      },
    }, ctx, deps);

    expect(created?.success).toBe(true);
    expect(created?.data).toMatchObject({
      success: true,
      message: 'MCP server "mcp-server" created.',
      path: configPath,
    });
    expect(ctx.restart).not.toHaveBeenCalled();

    const written = readJson(configPath);
    expect(written.mcp['mcp-server']).toBeUndefined();
    expect(written.mcp.servers['mcp-server']).toEqual({
      type: 'local',
      command: ['node', 'server.js'],
      // v1 `enabled: false` becomes the inverse v2 `disabled: true`.
      disabled: true,
    });
  });
});

describe('VS Code skill policy parity', () => {
  const globalConfigPath = path.join(process.env.XDG_CONFIG_HOME, 'opencode', 'opencode.json');

  const writeSkill = (root, id, name) => {
    const skillFile = path.join(root, '.opencode', 'skills', id, 'SKILL.md');
    fs.mkdirSync(path.dirname(skillFile), { recursive: true });
    fs.writeFileSync(skillFile, `---\nname: ${name}\ndescription: ${id}\n---\nBody\n`);
  };

  // OpenCode serves statements without the provenance key (measured on 2.0.25, 2.0.28, 2.0.29 and 2.0.30).
  const served = (info) => {
    const copy = { ...info };
    if (copy.policies) copy.policies = copy.policies.map(({ action, resource, effect }) => ({ action, resource, effect }));
    return copy;
  };

  // `hostDirectory` is the host's working directory; the requests name `root`.
  // `openCodeSkills`: OpenCode's own list; `readOpenCodeSkills` answers it per
  // read instead, for a list that changes during the test.
  const setup = ({ hostDirectory = null, openCodeSkills = null, readOpenCodeSkills = () => openCodeSkills } = {}) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-policy-')));
    tempRoots.push(root);
    fs.mkdirSync(path.join(root, '.git'));
    writeSkill(root, 'alpha-skill', 'Alpha Display');
    const projectConfigPath = path.join(root, '.opencode', 'opencode.json');
    // A watching OpenCode: it serves whatever the config files hold now.
    const policyDeps = {
      ...deps,
      fetchOpenCodeSkillsFromApi: async () => readOpenCodeSkills(),
      createOpenCodePolicyReader: () => ({
        readVersion: async () => '2.0.29',
        // A file OpenCode cannot parse is left out of what it serves.
        readConfigEntries: async () => [globalConfigPath, projectConfigPath]
          .filter((file) => fs.existsSync(file))
          .flatMap((file) => {
            const errors = [];
            const info = parseJsonc(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
            return errors.length > 0 ? [] : [{ type: 'document', path: file, info: served(info) }];
          }),
      }),
    };
    const ctx = createCtx(hostDirectory ?? root);
    const send = (payload) => handleConfigBridgeMessage({ id: 'policy', type: 'api:config/skill-policy', payload }, ctx, policyDeps);
    const list = (directory) => handleConfigBridgeMessage({ id: 'list', type: 'api:config/skills', payload: { method: 'GET', directory } }, ctx, policyDeps);
    return { root, projectConfigPath, send, list };
  };

  afterEach(() => {
    fs.rmSync(globalConfigPath, { force: true });
  });

  test('switches a skill off and on in the project config by its OpenCode id', async () => {
    const { root, projectConfigPath, send, list } = setup();

    const byName = await send({ directory: root, body: { id: 'Alpha Display', scope: 'project', enabled: false } });
    expect(byName.data).toMatchObject({ status: 404, body: { ok: false, error: { code: 'unknown_skill' } } });

    const off = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } });
    expect(off.data).toMatchObject({
      status: 200,
      body: {
        ok: true,
        id: 'alpha-skill',
        confirmed: true,
        saved: { scope: 'project', path: projectConfigPath, disabled: true, changed: true },
        policy: { effective: 'disabled', decidedBy: { scope: 'project', owned: true } },
      },
    });
    expect(readJson(projectConfigPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny', openchamber: 'skill-switch' }],
    });
    expect(fs.existsSync(globalConfigPath)).toBe(false);

    const listed = await list(root);
    expect(listed.data.skills.find((skill) => skill.id === 'alpha-skill')).toMatchObject({ name: 'Alpha Display' });
    expect(byId(listed.data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });

    const on = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(on.data).toMatchObject({ status: 200, body: { ok: true, saved: { changed: true }, policy: { effective: 'enabled' } } });
    expect(readJson(projectConfigPath)).toEqual({ policies: [] });
  });

  test('reports a switched-off skill as unknown while its project file cannot be parsed, as the web runtime does', async () => {
    const { root, projectConfigPath, send, list } = setup();
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    const validText = fs.readFileSync(projectConfigPath, 'utf8');

    fs.writeFileSync(projectConfigPath, `${validText.trimEnd().slice(0, -1)} oops }`);
    const broken = (await list(root)).data.skillPolicy;
    expect(broken.effectiveAvailable).toBe(true);
    expect(broken.scopes.project.error).toBeTruthy();
    expect(byId(broken).get('alpha-skill')).toEqual({ disabledIn: { global: false, project: null }, effective: 'unknown', decidedBy: null });

    fs.writeFileSync(projectConfigPath, validText);
    expect(byId((await list(root)).data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
  });

  test('keeps user rules and the comments inside the policy list through off and on', async () => {
    const { root, projectConfigPath, send } = setup();
    const text = '{\n  // project rules\n  "policies": [\n    { "action": "integration.use", "resource": "skill:wild-*", "effect": "deny" }, // keep\n  ],\n}\n';
    fs.writeFileSync(projectConfigPath, text);
    const readJsonc = () => fs.readFileSync(projectConfigPath, 'utf8');
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    expect(readJsonc()).toContain('"skill:wild-*", "effect": "deny" }, // keep');
    expect(readJsonc()).toContain('skill:alpha-skill');
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } })).data.status).toBe(200);
    expect(readJsonc()).toBe(text);
  });

  test('lists the skills of the directory the webview names, not the host working directory', async () => {
    const hostDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-host-cwd-')));
    tempRoots.push(hostDirectory);
    writeSkill(hostDirectory, 'host-only', 'Host Only');
    const { root, projectConfigPath, send, list } = setup({ hostDirectory });

    const fromRoot = await list(root);
    expect(fromRoot.data.skills.map((skill) => skill.id)).toContain('alpha-skill');
    expect(fromRoot.data.skills.map((skill) => skill.id)).not.toContain('host-only');
    expect(fromRoot.data.skillPolicy.scopes.project.path).toBe(projectConfigPath);

    const fromHost = await list(undefined);
    expect(fromHost.data.skills.map((skill) => skill.id)).toContain('host-only');

    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data.status).toBe(200);
    expect(byId((await list(root)).data.skillPolicy).get('alpha-skill')).toMatchObject({ disabledIn: { project: true }, effective: 'disabled' });
  });

  test('keeps a second id behind a shared display name switchable, like the web server', async () => {
    const root0 = fs.realpathSync(os.tmpdir());
    const skill = (id) => ({ id, name: 'Same Name', path: path.join(root0, id, 'SKILL.md'), scope: 'user', source: 'opencode' });
    const { root, projectConfigPath, send, list } = setup({ openCodeSkills: [skill('beta-one'), skill('beta-two')] });

    const listed = await list(root);
    expect(listed.data.skills.filter((entry) => entry.name === 'Same Name').map((entry) => [entry.id, entry.switchId])).toEqual([['beta-one', null]]);
    expect([...byId(listed.data.skillPolicy).keys()]).toEqual(expect.arrayContaining(['beta-one', 'beta-two']));

    const off = await send({ directory: root, body: { id: 'beta-two', scope: 'project', enabled: false } });
    expect(off.data).toMatchObject({ status: 200, body: { ok: true, id: 'beta-two' } });
    expect(readJson(projectConfigPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:beta-two', effect: 'deny', openchamber: 'skill-switch' }],
    });
  });

  test('gives every skill id and each row the same switch target before and after OpenCode lists its skills, like the web server', async () => {
    let cold = true;
    const project = (root, id, name) => ({ id, name, path: path.join(root, '.opencode', 'skills', id, 'SKILL.md'), scope: 'project', source: 'opencode' });
    let warmList = [];
    const { root, list } = setup({ readOpenCodeSkills: () => (cold ? [] : warmList) });
    // Two ids share the display name `Twin`; another skill's display name is the id `beta-two`.
    const fixtures = [['alpha-skill', 'Alpha Display'], ['beta-one', 'Twin'], ['beta-two', 'Twin'], ['name-holder', 'beta-two']];
    for (const [id, name] of fixtures.slice(1)) writeSkill(root, id, name);
    warmList = fixtures.map(([id, name]) => project(root, id, name));
    const targets = async () => {
      const listed = (await list(root)).data;
      return {
        rows: Object.fromEntries(listed.skills.map((entry) => [entry.name, entry.switchId])),
        ids: [...byId(listed.skillPolicy).keys()].sort(),
      };
    };

    const coldTargets = await targets();
    cold = false;
    expect(await targets()).toEqual(coldTargets);
    expect(coldTargets).toEqual({
      rows: { 'Alpha Display': 'alpha-skill', Twin: null, 'beta-two': 'name-holder' },
      ids: ['alpha-skill', 'beta-one', 'beta-two', 'name-holder'],
    });
  });

  test('lets each display name of one id switch that id, before and after OpenCode lists it, like the web server', async () => {
    let cold = true;
    let warmList = [];
    const { root, list } = setup({ readOpenCodeSkills: () => (cold ? [] : warmList) });
    // Two copies of `shared-id` whose names differ; OpenCode loads the `.opencode` one.
    writeSkill(root, 'shared-id', 'Copy A');
    const claudeCopy = path.join(root, '.claude', 'skills', 'shared-id', 'SKILL.md');
    fs.mkdirSync(path.dirname(claudeCopy), { recursive: true });
    fs.writeFileSync(claudeCopy, '---\nname: Copy B\ndescription: copy\n---\nBody\n');
    warmList = [{ id: 'shared-id', name: 'Copy A', path: path.join(root, '.opencode', 'skills', 'shared-id', 'SKILL.md'), scope: 'project', source: 'opencode' }];
    const targets = async () => Object.fromEntries((await list(root)).data.skills.map((entry) => [entry.name, entry.switchId]));

    const coldTargets = await targets();
    cold = false;
    expect(await targets()).toEqual(coldTargets);
    expect(coldTargets).toMatchObject({ 'Copy A': 'shared-id', 'Copy B': 'shared-id' });
  });

  test.skipIf(process.getuid?.() === 0)('keeps the global switch and refuses the project one while the project file cannot be read, like the web server', async () => {
    const { root, projectConfigPath, send, list } = setup();
    const projectText = '{\n  "model": "a/b"\n}\n';
    fs.mkdirSync(path.dirname(projectConfigPath), { recursive: true });
    fs.writeFileSync(projectConfigPath, projectText);
    fs.chmodSync(projectConfigPath, 0o000);
    try {
      const policy = (await list(root)).data.skillPolicy;
      expect(policy.scopes.global.error).toBeNull();
      expect(policy.scopes.project.error).toBeTruthy();
      const refused = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } });
      expect(refused.data).toMatchObject({ status: 409, body: { error: { code: 'read_failed' } } });
      expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'global', enabled: false } })).data.status).toBe(200);
    } finally {
      fs.chmodSync(projectConfigPath, 0o644);
    }
    expect(fs.readFileSync(projectConfigPath, 'utf8')).toBe(projectText);
  });

  test('keeps a user exact deny through off and on, like the web server', async () => {
    const { root, projectConfigPath, send } = setup();
    const text = JSON.stringify({ policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny' }] }, null, 2);
    fs.writeFileSync(projectConfigPath, text);
    const off = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: false } });
    expect(off.data.body).toMatchObject({ saved: { disabled: false, changed: false }, policy: { effective: 'disabled', decidedBy: { owned: false } } });
    const on = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(on.data.body).toMatchObject({ saved: { changed: false }, policy: { effective: 'disabled', decidedBy: { owned: false } } });
    expect(fs.readFileSync(projectConfigPath, 'utf8')).toBe(text);
  });

  test('writes the global switch to the user config and reports it over the project one', async () => {
    const { root, send } = setup();
    expect((await send({ directory: root, body: { id: 'alpha-skill', scope: 'global', enabled: false } })).data.status).toBe(200);
    expect(readJson(globalConfigPath)).toEqual({
      policies: [{ action: 'integration.use', resource: 'skill:alpha-skill', effect: 'deny', openchamber: 'skill-switch' }],
    });
    const project = await send({ directory: root, body: { id: 'alpha-skill', scope: 'project', enabled: true } });
    expect(project.data.body).toMatchObject({ policy: { effective: 'disabled', decidedBy: { scope: 'global', owned: true } } });
  });

  test('refuses malformed requests, unknown directories and a project switch without a directory', async () => {
    const { root, send } = setup();
    expect((await send({ directory: 42 })).data).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect((await send({ directory: path.join(root, 'missing'), body: { id: 'alpha-skill', scope: 'global', enabled: false } })).data)
      .toMatchObject({ status: 400, body: { error: { code: 'invalid_directory' } } });
    expect((await send({ body: { id: 'alpha-skill', scope: 'project', enabled: false } })).data)
      .toMatchObject({ status: 400, body: { error: { code: 'directory_required' } } });
  });

  test('answers 503 without writing when OpenCode cannot be read', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-vscode-skill-policy-down-'));
    tempRoots.push(root);
    const result = await handleConfigBridgeMessage({
      id: 'policy',
      type: 'api:config/skill-policy',
      payload: { directory: root, body: { id: 'alpha-skill', scope: 'global', enabled: true } },
    }, createCtx(root), deps);
    expect(result.data).toMatchObject({ status: 503, body: { error: { code: 'opencode_unavailable' } } });
    expect(fs.existsSync(globalConfigPath)).toBe(false);
  });
});
