import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Every user skill root resolves under a scratch home, so nothing here reads
// or deletes the real ~/.config/opencode, ~/.claude or ~/.agents.
const scratchHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-skill-delete-home-')));
const previousEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR };
process.env.HOME = scratchHome;
process.env.XDG_CONFIG_HOME = path.join(scratchHome, '.config');
delete process.env.OPENCODE_CONFIG_DIR;

const { deleteSkill, deleteSkillAt } = await import('./skills.js');

const roots = [];
const tempDir = (label) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-skill-delete-${label}-`)));
  roots.push(dir);
  return dir;
};
const writeSkill = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: Example\ndescription: Example\n---\nBody\n');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
};
const project = () => {
  const root = tempDir('project');
  fs.mkdirSync(path.join(root, '.git'));
  return root;
};

beforeAll(() => {
  expect(os.homedir()).toBe(scratchHome);
});

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe('deleting a skill through symlinks', () => {
  it('refuses a nested skill reached through a group symlink that leads out of the root', async () => {
    const root = project();
    const library = tempDir('library');
    writeSkill(path.join(library, 'example'));
    fs.mkdirSync(path.join(root, '.opencode', 'skills'), { recursive: true });
    fs.symlinkSync(library, path.join(root, '.opencode', 'skills', 'group'), 'dir');

    await expect(deleteSkillAt(path.join(root, '.opencode', 'skills', 'group', 'example', 'SKILL.md'), root))
      .rejects.toThrow('outside managed skill directories');
    expect(fs.readFileSync(path.join(library, 'example', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('deletes a nested skill in a real group folder and keeps the group', async () => {
    const root = project();
    const skillDir = path.join(root, '.opencode', 'skills', 'group', 'example');
    writeSkill(skillDir);
    writeSkill(path.join(root, '.opencode', 'skills', 'group', 'sibling'));

    await deleteSkillAt(path.join(skillDir, 'SKILL.md'), root);

    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(path.join(root, '.opencode', 'skills', 'group', 'sibling', 'SKILL.md'))).toBe(true);
  });

  it('removes only the link of a skill folder that is itself a symlink', async () => {
    const root = project();
    const library = tempDir('library');
    writeSkill(path.join(library, 'example'));
    const link = path.join(root, '.opencode', 'skills', 'example');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(library, 'example'), link, 'dir');

    await deleteSkillAt(path.join(link, 'SKILL.md'), root);

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(library, 'example', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('treats a managed root that is itself a symlink as its target', async () => {
    const root = project();
    const shared = tempDir('shared-root');
    writeSkill(path.join(shared, 'group', 'example'));
    writeSkill(path.join(shared, 'group', 'sibling'));
    fs.mkdirSync(path.join(root, '.opencode'));
    fs.symlinkSync(shared, path.join(root, '.opencode', 'skills'), 'dir');

    await deleteSkillAt(path.join(root, '.opencode', 'skills', 'group', 'example', 'SKILL.md'), root);

    expect(fs.existsSync(path.join(shared, 'group', 'example'))).toBe(false);
    expect(fs.existsSync(path.join(shared, 'group', 'sibling', 'SKILL.md'))).toBe(true);
  });

  it('a located delete removes only the link of a symlinked skill folder', () => {
    const root = project();
    const library = tempDir('library');
    writeSkill(path.join(library, 'example'));
    const link = path.join(root, '.claude', 'skills', 'example');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(library, 'example'), link, 'dir');

    deleteSkill('example', root, { scope: 'project', source: 'claude' });

    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(library, 'example', 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('refuses a name that is not one folder name, located or not', () => {
    const root = project();
    writeSkill(path.join(root, '.claude', 'skills', 'example'));

    for (const name of ['..', '.', 'a/b', 'a\\b', '']) {
      expect(() => deleteSkill(name, path.join(root, '.claude', 'skills', 'example'), { scope: 'project', source: 'claude' })).toThrow('Invalid skill name');
      expect(() => deleteSkill(name, root)).toThrow('Invalid skill name');
    }
    expect(fs.existsSync(path.join(root, '.claude', 'skills', 'example', 'keep.txt'))).toBe(true);
  });
});
