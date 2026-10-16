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
import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch";
import { runBackgroundNetworkTask } from "@/lib/background-network";
import { useProjectsStore } from "@/stores/useProjectsStore";

import { opencodeClient } from '@/lib/opencode/client';
import { filterSkillsByRuntimeFlags } from './skillVisibility';

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
   * `name` can differ from. Unique within one directory's list, so it is the
   * key for selection, local updates and mutations; `name` is only a label.
   */
  id: string;
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

/** The fields that name one installed skill to the server. */
type SkillTarget = Pick<DiscoveredSkill, 'id' | 'name'>;
/** A skill target with the file it was listed at. */
type SkillRef = SkillTarget & Pick<DiscoveredSkill, 'path'>;

interface SkillsStore {
  /** Id of the skill Settings shows, or the name of an unsaved draft. */
  selectedSkillId: string | null;
  /** Skills of the project the app is on. Chat and autocompletes read this one. */
  skills: DiscoveredSkill[];
  /** Every directory loaded so far, including the ambient one. */
  skillsByDirectory: Record<string, DiscoveredSkill[]>;
  isLoading: boolean;
  skillDraft: SkillDraft | null;

  setSelectedSkill: (id: string | null) => void;
  setSkillDraft: (draft: SkillDraft | null) => void;
  loadSkills: (directory?: string | null) => Promise<boolean>;
  /** Null when the read failed or the server answered for another file. */
  getSkillDetail: (skill: SkillRef, directory?: string | null) => Promise<SkillDetail | null>;
  createSkill: (config: SkillConfig, directory?: string | null) => Promise<boolean>;
  updateSkill: (skill: SkillRef, config: Partial<SkillConfig>, directory?: string | null) => Promise<boolean>;
  renameSkill: (skill: SkillTarget, newName: string, directory?: string | null) => Promise<boolean>;
  deleteSkill: (skill: SkillTarget, directory?: string | null) => Promise<boolean>;
  getSkillById: (id: string, directory?: string | null) => DiscoveredSkill | undefined;
  /**
   * Skills are discovered on the connected instance and cached by directory,
   * which two instances can share — so a switch must drop the caches rather
   * than report the previous instance's skills for the new one.
   */
  resetForRuntimeSwitch: () => void;

  // Supporting files
  readSupportingFile: (skill: SkillTarget, filePath: string, directory?: string | null) => Promise<string | null>;
  writeSupportingFile: (skill: SkillTarget, filePath: string, content: string, directory?: string | null) => Promise<boolean>;
  deleteSupportingFile: (skill: SkillTarget, filePath: string, directory?: string | null) => Promise<boolean>;
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
  const partialIds = new Set(partial.map((skill) => skill.id));
  const carried = previous.filter((skill) => !partialIds.has(skill.id) && skill.renamable !== true);
  return carried.length > 0 ? [...partial, ...carried] : partial;
};

const toDiscoveredSkill = (raw: RawSkillResponse): DiscoveredSkill => ({
  // The server sends the id; an entry without one gets the id OpenCode would
  // derive from its path, and only a path without one falls back to the name.
  id: raw.id || skillIdFromPath(raw.path) || raw.name,
  name: raw.name,
  path: raw.path,
  scope: raw.scope ?? 'user',
  source: raw.source ?? 'opencode',
  description: raw.sources?.md?.description || '',
  group: parseSkillGroup(raw.path),
  renamable: raw.renamable === true,
});

/**
 * A route under `/api/config/skills/:name`. The path keeps the display name
 * older servers read; the `id` query selects the skill, and a server given an
 * id matches it exactly, never by name, so two ids sharing a name stay apart.
 */
const skillRoute = (skill: SkillTarget, subPath = ''): string => (
  `/api/config/skills/${encodeURIComponent(skill.name)}${subPath}`
);

const skillRouteInit = (skill: SkillTarget, directory: string | null, init: RequestInit = {}): RuntimeFetchOptions => {
  const headers = new Headers();
  if (init.body) headers.set('Content-Type', 'application/json');
  if (directory) headers.set('x-opencode-directory', directory);
  return { ...init, query: { id: skill.id, directory }, headers };
};

const supportingFilePath = (filePath: string): string => `/files/${encodeURIComponent(filePath)}`;

const BUILT_IN_SKILL_LOCATION = '<built-in>';

const normalizeSkillPath = (path: string): string => path.replace(/\\/g, '/');

/** Whether a detail answer describes the file `skill` points at. */
const isDetailFor = (skill: SkillRef, detail: SkillDetail): boolean => {
  const detailPath = detail.sources.md.path;
  if (skill.path === BUILT_IN_SKILL_LOCATION) return detailPath === null;
  return detailPath !== null && normalizeSkillPath(detailPath) === normalizeSkillPath(skill.path);
};

const getSkillsCacheKey = (directory: string | null): string => {
  return directory?.trim() || DEFAULT_SKILLS_CACHE_KEY;
};

export const invalidateSkillsLoadCache = (directory: string | null = getRequestDirectory()) => {
  skillsLastLoadedAt.delete(getSkillsCacheKey(directory));
};

/** A new skill's folder, and so its id, is the name it is created with. */
const upsertSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  get: () => SkillsStore,
  skill: Pick<DiscoveredSkill, 'id' | 'name'> & { path?: string },
  config: Partial<SkillConfig>,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  const isAmbient = cacheKey === getSkillsCacheKey(getRequestDirectory());
  const current = get().skillsByDirectory[cacheKey] ?? [];
  const existing = current.find((entry) => entry.id === skill.id);
  const path = skill.path ?? existing?.path ?? '';
  const nextSkill: DiscoveredSkill = {
    ...existing,
    id: skill.id,
    name: skill.name,
    path,
    scope: config.scope ?? existing?.scope ?? 'user',
    source: config.source ?? existing?.source ?? 'opencode',
    description: config.description ?? existing?.description ?? '',
    group: parseSkillGroup(path),
  };
  const nextSkills = existing
    ? current.map((entry) => (entry.id === skill.id ? nextSkill : entry))
    : [...current, nextSkill];
  set((state) => {
    const next: Partial<SkillsStore> = {
      skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: nextSkills },
    };
    if (isAmbient) next.skills = nextSkills;
    return next;
  });
};

const removeSkillLocal = (
  set: (updater: (state: SkillsStore) => Partial<SkillsStore>) => void,
  id: string,
  directory: string | null,
) => {
  const cacheKey = getSkillsCacheKey(directory);
  const isAmbient = cacheKey === getSkillsCacheKey(getRequestDirectory());
  set((state) => {
    const nextSkills = (state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS).filter((skill) => skill.id !== id);
    const next: Partial<SkillsStore> = {
      skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: nextSkills },
    };
    if (isAmbient) next.skills = nextSkills;
    if (state.selectedSkillId === id) next.selectedSkillId = null;
    return next;
  });
};

const EMPTY_SKILLS: DiscoveredSkill[] = [];

/**
 * Skills of one project. Returns a stored array so components can select it
 * directly; an omitted directory means the project the app is on.
 */
export const selectSkillsForDirectory = (
  state: Pick<SkillsStore, 'skillsByDirectory'>,
  directory?: string | null,
): DiscoveredSkill[] => {
  const cacheKey = getSkillsCacheKey(resolveDirectory(directory));
  return state.skillsByDirectory[cacheKey] ?? EMPTY_SKILLS;
};

export const useSkillsStore = create<SkillsStore>()(
  devtools(
    persist(
      (set, get) => ({
        selectedSkillId: null,
        skills: [],
        skillsByDirectory: {},
        isLoading: false,
        skillDraft: null,

        resetForRuntimeSwitch: () => {
          skillsGeneration += 1;
          skillsLastLoadedAt.clear();
          skillsLoadInFlight.clear();
          set({ skills: [], skillsByDirectory: {}, isLoading: false });
        },

        setSelectedSkill: (id: string | null) => {
          set({ selectedSkillId: id });
        },

        setSkillDraft: (draft: SkillDraft | null) => {
          set({ skillDraft: draft });
        },

        loadSkills: async (requestedDirectory?: string | null) => {
          const directory = resolveDirectory(requestedDirectory);
          const cacheKey = getSkillsCacheKey(directory);
          const isAmbient = cacheKey === getSkillsCacheKey(getRequestDirectory());
          const now = Date.now();
          const loadedAt = skillsLastLoadedAt.get(cacheKey) ?? 0;
          const hasCachedSkills = (get().skillsByDirectory[cacheKey] ?? (isAmbient ? get().skills : [])).length > 0;

          if (hasCachedSkills && now - loadedAt < SKILLS_LOAD_CACHE_TTL_MS) {
            return true;
          }

          const inFlight = skillsLoadInFlight.get(cacheKey);
          if (inFlight) {
            return inFlight;
          }

          const generation = skillsGeneration;
          const request = (async () => {
            set({ isLoading: true });
            // Failure must never look like an empty project. The mirror is the
            // fallback so a directory loaded before this map existed still counts.
            const previousSkills = get().skillsByDirectory[cacheKey] ?? (isAmbient ? get().skills : []);
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
                const configSkills = rawSkills.map(toDiscoveredSkill);

                // OpenCode loads a narrower set than this scan finds, and the
                // rules live in server-side env flags the browser cannot read.
                // The route reports them; `filterSkillsByRuntimeFlags` mirrors
                // OpenCode's discovery, including the `.agents`-wins dedup that
                // matters when `.claude/skills` are symlinks back into it.
                //
                // Deliberately not OpenCode's own skill endpoint: measured
                // against 1.18.14 it lists only global and builtin skills and
                // omits the project skills the agent actually has.
                const scannedSkills = filterSkillsByRuntimeFlags(
                  configSkills,
                  data.externalSkills ?? null,
                );
                // The server answers with only its disk scan when OpenCode's
                // own list could not be read. That is not a complete list:
                // keep what was known and retry on the next load.
                const isPartial = data.openCodeSkillsUnavailable === true;
                const visibleSkills = isPartial
                  ? mergePartialSkills(scannedSkills, previousSkills)
                  : scannedSkills;

                if (generation !== skillsGeneration) return false;
                set((state) => {
                  const next: Partial<SkillsStore> = {
                    skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: visibleSkills },
                    isLoading: false,
                  };
                  if (isAmbient) next.skills = visibleSkills;
                  return next;
                });
                if (isPartial) {
                  skillsLastLoadedAt.delete(cacheKey);
                } else {
                  skillsLastLoadedAt.set(cacheKey, Date.now());
                }
                return true;
              } catch (error) {
                lastError = error;
                const waitMs = 200 * (attempt + 1);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
              }
            }

            console.error("Failed to load skills:", lastError);
            if (generation !== skillsGeneration) return false;
            set((state) => {
              const next: Partial<SkillsStore> = {
                skillsByDirectory: { ...state.skillsByDirectory, [cacheKey]: previousSkills },
                isLoading: false,
              };
              if (isAmbient) next.skills = previousSkills;
              return next;
            });
            return false;
          })();

          skillsLoadInFlight.set(cacheKey, request);
          try {
            return await request;
          } finally {
            skillsLoadInFlight.delete(cacheKey);
          }
        },

        getSkillDetail: async (skill: SkillRef, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory));
            if (!response.ok) {
              return null;
            }
            
            // An answer about another file must not fill the editor that
            // saves back to this one.
            const detail = await response.json() as SkillDetail;
            return isDetailFor(skill, detail) ? detail : null;
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
              upsertSkillLocal(set, get, { id: config.name, name: config.name }, config, directory);
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

        updateSkill: async (skill: SkillRef, config: Partial<SkillConfig>, requestedDirectory?: string | null) => {
          try {
            const skillConfig: Record<string, unknown> = {};

            if (config.description !== undefined) skillConfig.description = config.description;
            if (config.instructions !== undefined) skillConfig.instructions = config.instructions;
            if (config.supportingFiles !== undefined) skillConfig.supportingFiles = config.supportingFiles;
            if (config.disableModelInvocation !== undefined) skillConfig.disableModelInvocation = config.disableModelInvocation;
            // The file the skill was listed at, which the server checks
            // against the selected skill before it writes.
            if (skill.path && skill.path !== BUILT_IN_SKILL_LOCATION) skillConfig.targetPath = skill.path;

            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, {
              method: 'PATCH',
              body: JSON.stringify(skillConfig),
            }));

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to update skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              upsertSkillLocal(set, get, skill, config, directory);
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

        renameSkill: async (skill: SkillTarget, newName: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, {
              method: 'PATCH',
              body: JSON.stringify({ renameTo: newName }),
            }));

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

        deleteSkill: async (skill: SkillTarget, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(skillRoute(skill), skillRouteInit(skill, directory, { method: 'DELETE' }));

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const message = payload?.error || 'Failed to delete skill';
              throw new Error(message);
            }

            invalidateSkillsLoadCache(directory);

            if (payload?.requiresManualRestart) {
              removeSkillLocal(set, skill.id, directory);
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

            // Delete removes the file OpenCode loads; a lower-priority copy of
            // the same id can remain and then shows up in the refreshed list.
            // The selection stays on the id while the list still has it.
            const idStillListed = loaded
              && selectSkillsForDirectory(get(), directory).some((entry) => entry.id === skill.id);
            if (get().selectedSkillId === skill.id && !idStillListed) {
              set({ selectedSkillId: null });
            }

            return loaded;
          } catch {
            return false;
          }
        },

        getSkillById: (id: string, requestedDirectory?: string | null) => {
          return selectSkillsForDirectory(get(), requestedDirectory).find((skill) => skill.id === id);
        },

        readSupportingFile: async (skill: SkillTarget, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory),
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

        writeSupportingFile: async (skill: SkillTarget, filePath: string, content: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory, { method: 'PUT', body: JSON.stringify({ content }) }),
            );
            
            return response.ok;
          } catch {
            return false;
          }
        },

        deleteSupportingFile: async (skill: SkillTarget, filePath: string, requestedDirectory?: string | null) => {
          try {
            const directory = resolveDirectory(requestedDirectory);
            const response = await runtimeFetch(
              skillRoute(skill, supportingFilePath(filePath)),
              skillRouteInit(skill, directory, { method: 'DELETE' }),
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
          selectedSkillId: state.selectedSkillId,
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
