import { create } from "zustand";
import type { StoreApi, UseBoundStore } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { emitConfigChange, scopeMatches, subscribeToConfigChanges } from "@/lib/configSync";
import {
  startConfigUpdate,
  finishConfigUpdate,
  updateConfigUpdateMessage,
} from "@/lib/configUpdate";
import { waitForOpenCodeConnection } from "@/stores/waitForOpenCodeConnection";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { runtimeFetch } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from "@/lib/background-network";
import { useProjectsStore } from "@/stores/useProjectsStore";

import { opencodeClient } from '@/lib/opencode/client';
import { filterSkillsByRuntimeFlags } from './skillVisibility';
import {
  filterAvailableSkills,
  parseSkillPolicyRead,
  parseSkillPolicyWrite,
  type SkillPolicyRead,
  type SkillPolicyScope,
  type SkillPolicyState,
  type SkillPolicyWriteResult,
} from './skillAvailability';

// Prefer the active project path so Settings/Skills discovery matches the
// project selector (and Commands/Agents). Falling back only to the session
// directory misses repository-local `.agents/skills` when the client directory
// is unset or points elsewhere while an active project exists.
/**
 * Directory a call operates on. Settings can browse another project without
 * moving the app, so every entry point takes one; omitting it means the project
 * the app is currently on.
 */
const resolveDirectory = (directory?: string | null): string | null => {
  if (directory !== undefined) {
    const trimmed = directory?.trim();
    return trimmed ? trimmed : null;
  }
  return getRequestDirectory();
};

const getRequestDirectory = (): string | null => {
  try {
    const projectsStore = useProjectsStore.getState();
    const activeProject = projectsStore.getActiveProject?.();

    if (activeProject?.path?.trim()) {
      return activeProject.path.trim();
    }

    const clientDir = opencodeClient.getDirectory();
    if (clientDir?.trim()) {
      return clientDir.trim();
    }
  } catch (err) {
    console.warn('[SkillsStore] Error resolving config directory:', err);
  }

  return null;
};

export type SkillScope = 'user' | 'project';
export type SkillSource = 'opencode' | 'claude' | 'agents';

export interface SupportingFile {
  name: string;
  path: string;
  fullPath: string;
}

interface SkillSources {
  md: {
    exists: boolean;
    path: string | null;
    dir: string | null;
    fields: string[];
    scope?: SkillScope | null;
    source?: SkillSource | null;
    supportingFiles: SupportingFile[];
    // Actual content values
    name?: string;
    description?: string;
    instructions?: string;
    /** The model only loads the skill when asked for it by name. */
    disableModelInvocation?: boolean;
  };
  projectMd?: { exists: boolean; path: string | null };
  claudeMd?: { exists: boolean; path: string | null };
  userMd?: { exists: boolean; path: string | null };
  userClaudeMd?: { exists: boolean; path: string | null };
  userAgentsMd?: { exists: boolean; path: string | null };
}

export interface DiscoveredSkill {
  /**
   * OpenCode's skill id: the folder of `SKILL.md`, which the frontmatter
   * `name` can differ from. Skill policies and the per-skill switches name it.
   */
  id: string;
  /**
   * The id this row's switch names: its own id when no other installed id has
   * its display name, else null, and each id of that name is switched on its
   * own (`switchOnlyIds`). The server decides it from every installed id.
   */
  switchId: string | null;
  name: string;
  path: string;
  scope: SkillScope;
  source: SkillSource;
  description?: string;
  /** Domain folder parsed from file path, e.g. "automation-ai", "lark-ecosystem" */
  group?: string;
  /** Authoritative server flag: skill lives under a managed root and can be renamed in place. */
  renamable?: boolean;
}

/** Parse the domain group folder from a skill file path.
 *  e.g. "~/.config/opencode/skills/automation-ai/ai-production/SKILL.md" → "automation-ai"
 *  e.g. "~/.config/opencode/skills/theme-system/SKILL.md"                → undefined (flat)
 */
function parseSkillGroup(path: string): string | undefined {
  const normalizedPath = path.replace(/\\/g, '/');
  const idx = normalizedPath.lastIndexOf('/skills/');
  if (idx === -1) return undefined;
  const relative = normalizedPath.substring(idx + '/skills/'.length);
  const parts = relative.split('/');
  // Grouped layout: <group>/<name>/SKILL.md → parts.length >= 3
  // Flat layout:    <name>/SKILL.md         → parts.length == 2
  return parts.length >= 3 ? parts[0] : undefined;
}

/**
 * OpenCode's id for a skill file, the way the server derives it
 * (`skillIdFromPath`): the folder of a `SKILL.md`, or a loose `<id>.md`.
 */
const skillIdFromPath = (path: string): string | null => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const file = parts.at(-1) ?? '';
  if (file === 'SKILL.md') return parts.at(-2) ?? null;
  if (file.endsWith('.md')) return file.slice(0, -3) || null;
  return null;
};

// Raw skill response from API before transformation
interface RawSkillResponse {
  id?: string;
  switchId?: string | null;
  name: string;
  path: string;
  scope?: SkillScope;
  source?: SkillSource;
  renamable?: boolean;
  sources?: {
    md?: {
      description?: string;
    };
  };
}

export interface SkillConfig {
  name: string;
  description: string;
  instructions?: string;
  scope?: SkillScope;
  source?: SkillSource;
  targetPath?: string;
  supportingFiles?: Array<{ path: string; content: string }>;
  disableModelInvocation?: boolean;
}

export interface PendingFile {
  path: string;
  content: string;
}

interface SkillDraft {
  name: string;
  scope: SkillScope;
  source?: SkillSource;
  description: string;
  instructions?: string;
  pendingFiles?: PendingFile[];
}

interface SkillDetail {
  name: string;
  sources: SkillSources;
  scope?: SkillScope | null;
  source?: SkillSource | null;
}

/** The policy state Settings shows for one directory. */
export interface SkillPolicyView {
  /** The latest state read, or the last one known when the latest read failed; null before any. */
  state: SkillPolicyState | null;
  /** Why the latest read failed; null when it succeeded. */
  error: string | null;
}

/** A switch write for one skill in one directory, from the click until the next policy read. */
type SkillSwitchStatus =
  | { phase: 'pending'; scope: SkillPolicyScope }
  /** Saved in the file, but OpenCode had not applied it when the write answered. */
  | { phase: 'unconfirmed'; scope: SkillPolicyScope }
  | { phase: 'failed'; scope: SkillPolicyScope; message: string };

interface SkillsStore {
  selectedSkillName: string | null;
  /**
   * An id Settings shows only with its switches, because no row of the list
   * carries it (`switchOnlyIds`). Kept apart from `selectedSkillName`, so an
   * id that equals another skill's display name never opens that skill.
   */
  selectedSwitchOnlyId: string | null;
  /** Installed skills of the project the app is on. */
  skills: DiscoveredSkill[];
  /** Installed skills of every directory loaded so far, including the ambient one. Settings reads this. */
  skillsByDirectory: Record<string, DiscoveredSkill[]>;
  /** The ambient directory's skills agents can use: chat and autocompletes read this one. */
  availableSkills: DiscoveredSkill[];
  /** Per directory, the installed skills minus the ones a policy switches off. */
  availableSkillsByDirectory: Record<string, DiscoveredSkill[]>;
  policyByDirectory: Record<string, SkillPolicyView>;
  /** Keyed by `skillSwitchKey(directory, id)`. */
  switchStatus: Record<string, SkillSwitchStatus>;
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (name: string | null) => void;
  selectSwitchOnlyId: (id: string) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: (directory?: string | null) => Promise<boolean>;
  /**
   * Switches a skill on or off in one scope's config file. One write per skill
   * and directory at a time; a second call while one runs answers `pending`.
   * The policy the server answers replaces the shown one: nothing is assumed
   * before the answer.
   */
  setSkillEnabled: (
    id: string,
    scope: SkillPolicyScope,
    enabled: boolean,
    directory?: string | null,
  ) => Promise<SkillPolicyWriteResult>;
  getSkillDetail: (name: string, directory?: string | null) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig, directory?: string | null) => Promise<boolean>;
  updateSkill: (name: string, config: Partial<SkillConfig>, directory?: string | null) => Promise<boolean>;
  renameSkill: (name: string, newName: string, directory?: string | null) => Promise<boolean>;
  /** `location` deletes only the copy in that scope and source; without it every copy of the name goes. */
  deleteSkill: (name: string, directory?: string | null, location?: { scope: SkillScope; source: SkillSource }) => Promise<boolean>;
  getSkillByName: (name: string, directory?: string | null) => DiscoveredSkill | undefined;
  /**
   * Skills are discovered on the connected instance and cached by directory,
   * which two instances can share — so a switch must drop the caches rather
   * than report the previous instance's skills for the new one.
   */
  resetForRuntimeSwitch: () => void;

  // Supporting files
  readSupportingFile: (skillName: string, filePath: string, directory?: string | null) => Promise<string | null>;
  writeSupportingFile: (skillName: string, filePath: string, content: string, directory?: string | null) => Promise<boolean>;
  deleteSupportingFile: (skillName: string, filePath: string, directory?: string | null) => Promise<boolean>;
}

declare global {
  interface Window {
    __zustand_skills_store__?: UseBoundStore<StoreApi<SkillsStore>>;
  }
}

const CONFIG_EVENT_SOURCE = "useSkillsStore";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SKILLS_LOAD_CACHE_TTL_MS = 5000;
const DEFAULT_SKILLS_CACHE_KEY = '__default__';
const skillsLastLoadedAt = new Map<string, number>();
const skillsLoadInFlight = new Map<string, Promise<boolean>>();
// Bumped on every runtime switch. Skills are discovered on the connected
// instance and cached by directory, which two instances can share, so a load
// already in flight for the previous instance must not write into the new one.
let skillsGeneration = 0;
// Bumped per directory whenever its skills or policies may have changed: a
// write from here, or an event announcing one. A read that started before the
// bump can answer with the old state, so it is not committed; the load reads
// again instead.
const skillsRevision = new Map<string, number>();
const LOAD_RESTARTS = 3;
// Switch writes running, by `skillSwitchKey`.
const skillSwitchesInFlight = new Set<string>();

const revisionOf = (cacheKey: string): number => skillsRevision.get(cacheKey) ?? 0;

const markSkillsChanged = (cacheKey: string): void => {
  skillsRevision.set(cacheKey, revisionOf(cacheKey) + 1);
  skillsLastLoadedAt.delete(cacheKey);
};

/**
 * Merge a partial list (OpenCode's own skill list failed, only the disk scan
 * came back) with what was known before. Previously known skills the disk scan
 * cannot vouch for — built-ins and anything OpenCode found through its config —
 * are kept instead of vanishing on one failed fetch. Managed-root skills
 * (`renamable`) are covered by the disk scan, so their absence is real.
 */
const mergePartialSkills = (
  partial: DiscoveredSkill[],
  previous: DiscoveredSkill[],
): DiscoveredSkill[] => {
  const partialNames = new Set(partial.map((skill) => skill.name));
  const carried = previous.filter((skill) => !partialNames.has(skill.name) && skill.renamable !== true);
  return carried.length > 0 ? [...partial, ...carried] : partial;
};

const toDiscoveredSkill = (raw: RawSkillResponse): DiscoveredSkill => ({
  // The server sends the id; an entry without one gets the id OpenCode would
  // derive from its path, and only a path without one falls back to the name.
  id: raw.id || skillIdFromPath(raw.path) || raw.name,
  switchId: raw.switchId ?? null,
  name: raw.name,
  path: raw.path,
  scope: raw.scope ?? 'user',
  source: raw.source ?? 'opencode',
  description: raw.sources?.md?.description || '',
  group: parseSkillGroup(raw.path),
  renamable: raw.renamable === true,
});

const getSkillsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CACHE_KEY;
};

const ambientCacheKey = (): string => getSkillsCacheKey(getRequestDirectory());

/** The `switchStatus` key of one skill in one directory. */
export const skillSwitchKey = (directory: string | null | undefined, id: string): string => (
  `${getSkillsCacheKey(resolveDirectory(directory))}\n${id}`
);

/**
 * Marks a directory's skills as possibly changed: the next load reads again,
 * and a load already running reads again before it commits, so an answer
 * started before the change cannot land.
 */
export const invalidateSkillsLoadCache = (directory: string | null = getRequestDirectory()) => {
  markSkillsChanged(getSkillsCacheKey(directory));
};

/**
 * One directory's lists after a change to its inventory or policy, with the
 * available list derived from both and the ambient mirrors following when the
 * directory is the one the app is on now.
 */
const commitDirectory = (
  state: SkillsStore,
  cacheKey: string,
  patch: { skills?: DiscoveredSkill[]; policy?: SkillPolicyView },
): Partial<SkillsStore> => {
  const skills = patch.skills ?? state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
  const policy = patch.policy ?? state.policyByDirectory[cacheKey] ?? null;
  const available = filterAvailableSkills(skills, policy?.state ?? null);
  const next: Partial<SkillsStore> = {
    skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: skills },
    availableSkillsByDirectory: { ...state.availableSkillsByDirectory, [cacheKey]: available },
  };
  if (patch.policy) next.policyByDirectory = { ...state.policyByDirectory, [cacheKey]: patch.policy };
  if (cacheKey === ambientCacheKey()) {
    next.skills = skills;
    next.availableSkills = available;
  }
  return next;
};

/** Drops the `unconfirmed` notes of a directory once a fresh policy read replaced them. */
const withoutUnconfirmed = (statuses: Record<string, SkillSwitchStatus>, cacheKey: string): Record<string, SkillSwitchStatus> => {
  const prefix = `${cacheKey}\n`;
  const entries = Object.entries(statuses);
  const kept = entries.filter(([key, status]) => !(key.startsWith(prefix) && status.phase === 'unconfirmed'));
  return kept.length === entries.length ? statuses : Object.fromEntries(kept);
};

const upsertSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  get: () => SkillsStore,
  name: string,
  config: Partial<SkillConfig>,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  const current = get().skillsByDirectory[cacheKey] ?? [];
  const existing = current.find((skill) => skill.name === name);
  const path = config.targetPath ?? existing?.path ?? '';
  const nextSkill: DiscoveredSkill = {
    ...existing,
    // A new skill's folder, and so its id, is the name it is created with.
    id: existing?.id ?? name,
    // Read from the next list; until then no row switch is offered.
    switchId: existing?.switchId ?? null,
    name,
    path,
    scope: config.scope ?? existing?.scope ?? 'user',
    source: config.source ?? existing?.source ?? 'opencode',
    description: config.description ?? existing?.description ?? '',
    group: parseSkillGroup(path),
  };
  const nextSkills = current.some((skill) => skill.name === name)
    ? current.map((skill) => (skill.name === name ? nextSkill : skill))
    : [...current, nextSkill];
  set((state) => commitDirectory(state, cacheKey, { skills: nextSkills }));
};

const removeSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  name: string,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  set((state) => {
    const next = commitDirectory(state, cacheKey, {
      skills: (state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS).filter((skill) => skill.name !== name),
    });
    if (state.selectedSkillName === name) next.selectedSkillName = null;
    return next;
  });
};

const EMPTY_SKILLS: DiscoveredSkill[] = [];

/**
 * Installed skills of one project, switched off or not: what Settings lists.
 * Returns a stored array so components can select it directly; an omitted
 * directory means the project the app is on.
 */
export const selectSkillsForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

/** Skills of one project agents can use: what the composer offers and sends. */
export const selectAvailableSkillsForDirectory = (
  state: Pick<SkillsStore, 'availableSkillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.availableSkillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

export const selectSkillPolicyForDirectory = (
  state: Pick<SkillsStore, 'policyByDirectory'>,
  directory?: string | null,
): SkillPolicyView | null => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.policyByDirectory[cacheKey] ?? null;
};

/** What one `GET /api/config/skills` gave, before it is committed. */
type SkillsSnapshot = {
  skills: DiscoveredSkill[];
  /** Only the disk scan answered; known skills it cannot vouch for are kept. */
  partial: boolean;
  policy: SkillPolicyRead;
};

/** Reads one directory's skills, retrying twice; null when every attempt failed. */
const fetchSkillsSnapshot = async (directory: string | null): Promise<SkillsSnapshot | null> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const response = await runBackgroundNetworkTask(() => runtimeFetch(`/api/config/skills${queryParams}`, {
        priority: 'low',
        headers: directory ? { 'x-opencode-directory': directory } : undefined,
      }));
      if (!response.ok) {
        throw new Error(`Failed to list skills: ${response.status}`);
      }

      const data = await response.json();
      const rawSkills: RawSkillResponse[] = data.skills || [];
      // OpenCode loads a narrower set than this scan finds, and the
      // rules live in server-side env flags the browser cannot read.
      // The route reports them; `filterSkillsByRuntimeFlags` mirrors
      // OpenCode's discovery, including the `.agents`-wins dedup that
      // matters when `.claude/skills` are symlinks back into it.
      //
      // Deliberately not OpenCode's own skill endpoint: measured
      // against 1.18.14 it lists only global and builtin skills and
      // omits the project skills the agent actually has. On 2.x it also
      // drops a switched-off skill, which Settings still lists.
      const skills = filterSkillsByRuntimeFlags(rawSkills.map(toDiscoveredSkill), data.externalSkills ?? null);
      return {
        skills,
        // The server answers with only its disk scan when OpenCode's
        // own list could not be read. That is not a complete list.
        partial: data.openCodeSkillsUnavailable === true,
        policy: parseSkillPolicyRead(data.skillPolicy),
      };
    } catch (error) {
      lastError = error;
      await sleep(200 * (attempt + 1));
    }
  }
  console.error("Failed to load skills:", lastError);
  return null;
};

/**
 * The policy view after a read: a fresh state replaces the shown one, a failed
 * read keeps the last known state and says why, and an answer without policy
 * (an older server) keeps what was known.
 */
const nextPolicyView = (previous: SkillPolicyView | null, read: SkillPolicyRead): SkillPolicyView => {
  if (read.kind === 'state') return { state: read.state, error: null };
  if (read.kind === 'error') return { state: previous?.state ?? null, error: read.message };
  return previous ?? { state: null, error: null };
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillName: null,
        selectedSwitchOnlyId: null,
        skills: [],
        skillsByDirectory: {},
        availableSkills: [],
        availableSkillsByDirectory: {},
        policyByDirectory: {},
        switchStatus: {},
        isLoading: false,
        skillDraft: null,

        resetForRuntimeSwitch: () => {
          skillsGeneration += 1;
          skillsLastLoadedAt.clear();
          skillsLoadInFlight.clear();
          skillsRevision.clear();
          skillSwitchesInFlight.clear();
          set({
            skills: [],
            skillsByDirectory: {},
            availableSkills: [],
            availableSkillsByDirectory: {},
            policyByDirectory: {},
            switchStatus: {},
            isLoading: false,
          });
        },

        setSelectedSkill: (name: string | null) => {
          set({ selectedSkillName: name, selectedSwitchOnlyId: null });
        },

        selectSwitchOnlyId: (id: string) => {
          set({ selectedSkillName: null, selectedSwitchOnlyId: id });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const loadedAt = skillsLastLoadedAt.get(cacheKey) ?? 0;
          const cached = get().skillsByDirectory[cacheKey];

          if (cached && cached.length > 0 && Date.now() - loadedAt < SKILLS_LOAD_CACHE_TTL_MS) {
            // The app may have moved to this directory since it was read:
            // the mirrors follow the directory the app is on now.
            if (cacheKey === ambientCacheKey() && get().skills !== cached) {
              set((state) => commitDirectory(state, cacheKey, {}));
            }
            return true;
          }

          const inFlight = skillsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const generation = skillsGeneration;
          const request = (async () => {
            set({ isLoading: true });
            for (let restart = 0; restart < LOAD_RESTARTS; restart++) {
              const revision = revisionOf(cacheKey);
              const snapshot = await fetchSkillsSnapshot(directory);
              if (generation !== skillsGeneration) return false;
              // Something changed while this read was out; its answer may
              // predate the change. Read again.
              if (revision !== revisionOf(cacheKey)) continue;
              // Failure must never look like an empty project: the lists
              // stay as they are.
              if (!snapshot) {
                set({ isLoading: false });
                return false;
              }
              set((state) => {
                const previousSkills = state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
                const policy = nextPolicyView(state.policyByDirectory[cacheKey] ?? null, snapshot.policy);
                const next = commitDirectory(state, cacheKey, {
                  skills: snapshot.partial ? mergePartialSkills(snapshot.skills, previousSkills) : snapshot.skills,
                  policy,
                });
                next.isLoading = false;
                if (snapshot.policy.kind === 'state') next.switchStatus = withoutUnconfirmed(state.switchStatus, cacheKey);
                return next;
              });
              if (snapshot.partial) {
                skillsLastLoadedAt.delete(cacheKey);
              } else {
                skillsLastLoadedAt.set(cacheKey, Date.now());
              }
              return true;
            }
            // Changes kept landing while reading; leave the lists for the
            // next load rather than commit an answer that may be stale.
            if (generation === skillsGeneration) set({ isLoading: false });
            return false;
          })();

          skillsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            if (skillsLoadInFlight.get(cacheKey) === request) skillsLoadInFlight.delete(cacheKey);
          }
        },

        setSkillEnabled: async (id, scope, enabled, requestedDirectory) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const switchKey = `${cacheKey}\n${id}`;
          if (skillSwitchesInFlight.has(switchKey)) {
            return { ok: false, code: 'pending', message: 'A change to this skill is still being saved' };
          }
          skillSwitchesInFlight.add(switchKey);
          const generation = skillsGeneration;
          const setStatus = (status: SkillSwitchStatus) => set((state) => ({
            switchStatus: { ...state.switchStatus, [switchKey]: status },
          }));
          setStatus({ phase: 'pending', scope });

          const headers = new Headers({ 'Content-Type': 'application/json' });
          if (directory) headers.set('x-opencode-directory', directory);
          let result: SkillPolicyWriteResult;
          try {
            const response = await runtimeFetch('/api/config/skill-policy', {
              method: 'PUT',
              query: { directory },
              headers,
              body: JSON.stringify({ id, scope, enabled }),
            });
            result = parseSkillPolicyWrite(await response.json().catch(() => null), response.status);
          } catch (error) {
            result = { ok: false, code: 'network', message: error instanceof Error ? error.message : String(error) };
          } finally {
            skillSwitchesInFlight.delete(switchKey);
          }
          if (generation !== skillsGeneration) return result;

          if (!result.ok) {
            // Nothing was written: the shown policy stays the last confirmed one.
            setStatus({ phase: 'failed', scope, message: result.message });
            return result;
          }

          const { write } = result;
          // A global file applies to every directory; a project file to its own.
          const affected = scope === 'global'
            ? new Set([cacheKey, ambientCacheKey(), ...Object.keys(get().skillsByDirectory)])
            : new Set([cacheKey]);
          for (const key of affected) markSkillsChanged(key);
          set((state) => {
            const previous = state.policyByDirectory[cacheKey]?.state ?? null;
            const policy: SkillPolicyView = {
              state: { ...write.state, skills: new Map(previous?.skills).set(id, write.policy) },
              error: null,
            };
            const next = commitDirectory(state, cacheKey, { policy });
            const switchStatus = { ...state.switchStatus };
            if (write.confirmed) delete switchStatus[switchKey];
            else switchStatus[switchKey] = { phase: 'unconfirmed', scope };
            next.switchStatus = switchStatus;
            return next;
          });
          emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
          // OpenCode applied it: re-read the lists it changes. Switching a
          // built-in skill back on brings it back into the list, and chat
          // reads the directory the app is on, which a global change reaches
          // too. An unconfirmed write is re-read when OpenCode announces the
          // config change, or when the user asks to check again.
          if (write.confirmed) {
            void get().loadSkills(directory);
            const ambient = ambientCacheKey();
            if (affected.has(ambient) && ambient !== cacheKey) void get().loadSkills();
          }
          return result;
        },

        getSkillDetail: async (name: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });
            if (!response.ok) {
              return null;
            }
            
            return await response.json() as SkillDetail;
          } catch {
            return null;
          }
        },

        createSkill: async (config: SkillConfig, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {
              name: config.name,
              description: config.description,
            };

            if (config.instructions) skillConfig.instructions = config.instructions;
            if (config.scope) skillConfig.scope = config.scope;
            if (config.source) skillConfig.source = config.source;
            if (config.supportingFiles) skillConfig.supportingFiles = config.supportingFiles;
            if (config.disableModelInvocation) skillConfig.disableModelInvocation = true;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(config.name)}${queryParams}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to create skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, get, config.name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Creating skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        updateSkill: async (name: string, config: Partial<SkillConfig>, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;
            if (config.targetPath !== undefined) skillConfig.targetPath = config.targetPath;
            if (config.disableModelInvocation !== undefined) skillConfig.disableModelInvocation = config.disableModelInvocation;

            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify(skillConfig)
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, get, name, config, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Updating skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        renameSkill: async (name: string, newName: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'PATCH',
              headers: {
                'Content-Type': 'application/json',
                ...(directory ? { 'x-opencode-directory': directory } : {}),
              },
              body: JSON.stringify({ renameTo: newName }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to rename skill';
              throw new Error(message);
            }

            const needsReload = payload?.requiresReload ?? false;
            invalidateSkillsLoadCache(directory);
            if (needsReload) {
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }
            return loaded;
          } catch {
            return false;
          }
        },

        deleteSkill: async (name: string, requestedDirectory?: string | null, location?: { scope: SkillScope; source: SkillSource }) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const params = new URLSearchParams();
            if (directory) params.set('directory', directory);
            if (location) {
              params.set('scope', location.scope);
              params.set('source', location.source);
            }
            const query = params.toString();
            const queryParams = query ? `?${query}` : '';

            const response = await runtimeFetch(`/api/config/skills/${encodeURIComponent(name)}${queryParams}`, {
              method: 'DELETE',
              headers: directory ? { 'x-opencode-directory': directory } : undefined,
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              removeSkillLocal(set, name, directory);
              return true;
            }

            if (payload?.requiresReload) {
              startConfigUpdate("Deleting skill...");
              await refreshSkillsAfterOpenCodeRestart({
                message: payload?.message,
                delayMs: payload?.reloadDelayMs,
              });
              return true;
            }

            const loaded = await get().loadSkills(directory);
            if (loaded) {
              emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
            }

            if (get().selectedSkillName === name) {
              set({ selectedSkillName: null });
            }

            return loaded;
          } catch {
            return false;
          }
        },

        getSkillByName: (name: string, requestedDirectory?: string | null) => {
          return selectSkillsForDirectory(get(), requestedDirectory).find((skill) => skill.name === name);
        },

        readSupportingFile: async (skillName: string, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `&directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}?${queryParams.slice(1)}`,
              { headers: directory ? { 'x-opencode-directory': directory } : undefined },
            );
            if (!response.ok) {
              return null;
            }
            
            const data = await response.json();
            return data.content ?? null;
          } catch {
            return null;
          }
        },

        writeSupportingFile: async (skillName: string, filePath: string, content: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'PUT',
                headers: {
                  'Content-Type': 'application/json',
                  ...(directory ? { 'x-opencode-directory': directory } : {}),
                },
                body: JSON.stringify({ content })
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skillName: string, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const queryParams = directory ? `?directory=${encodeURIComponent(directory)}` : '';
            
            const response = await runtimeFetch(
              `/api/config/skills/${encodeURIComponent(skillName)}/files/${encodeURIComponent(filePath)}${queryParams}`,
              {
                method: 'DELETE',
                headers: directory ? { 'x-opencode-directory': directory } : undefined,
              }
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },
      }),
      {
        name: "skills-store",
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          selectedSkillName: state.selectedSkillName,
        }),
      },
    ),
    {
      name: "skills-store",
    },
  ),
);

if (typeof window !== "undefined") {
  window.__zustand_skills_store__ = useSkillsStore;
}

export async function refreshSkillsAfterOpenCodeRestart(options?: { message?: string; delayMs?: number }) {
  try {
    updateConfigUpdateMessage(options?.message || "Refreshing skills…");
  } catch {
    // ignore
  }

  try {
    await waitForOpenCodeConnection(options?.delayMs);
    updateConfigUpdateMessage("Refreshing skills…");
    const skillsStore = useSkillsStore.getState();
    invalidateSkillsLoadCache();
    const loaded = await skillsStore.loadSkills();
    if (loaded) {
      emitConfigChange("skills", { source: CONFIG_EVENT_SOURCE });
    }
  } catch (error) {
    updateConfigUpdateMessage("OpenCode refresh failed. Please retry.");
    await sleep(1500);
    throw error;
  } finally {
    finishConfigUpdate();
  }
}

// Subscribe to config changes from other stores
let unsubscribeSkillsConfigChanges: (() => void) | null = null;

if (!unsubscribeSkillsConfigChanges) {
  unsubscribeSkillsConfigChanges = subscribeToConfigChanges((event) => {
    if (event.source === CONFIG_EVENT_SOURCE) {
      return;
    }

    if (scopeMatches(event, "skills")) {
      const { loadSkills } = useSkillsStore.getState();
      void loadSkills();
    }
  });
}
