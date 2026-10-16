import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { type IntegrationCatalogStatusTone } from '@/components/sections/integrations/IntegrationCatalogCard';
import { McpOAuthSignIn } from '@/components/sections/mcp/McpOAuthSignIn';
import { MCP_DRAFT_OAUTH_UNSET } from '@/components/sections/mcp/mcpDraft';
import { cn } from '@/lib/utils';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore, type McpDraft } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import type { McpServerStatus } from '@/lib/opencode/model';
import { usePluginsStore, type PluginEntry, type RegistryResult } from '@/stores/usePluginsStore';
import { useSkillsStore, type DiscoveredSkill } from '@/stores/useSkillsStore';
import { useSkillsCatalogStore } from '@/stores/useSkillsCatalogStore';
import { useGuestsStore } from '@/lib/guests/store';
import { installGuest, uninstallGuest } from '@/lib/guests/install';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useUIStore } from '@/stores/useUIStore';
import { brandIconFor } from '@/lib/integrations-catalog/brand-icons';
import {
  CATALOG_CATEGORY_ORDER,
  CATALOG_ENTRIES,
  catalogComponentName,
  catalogEntryHasAllInputs,
  catalogMcpComponent,
  catalogPluginPackageName,
  interpolateCatalogTokens,
  type CatalogCategory,
  type CatalogComponent,
  type CatalogEntry,
  type CatalogExtensionComponent,
  type CatalogMcpComponent,
  type CatalogPluginComponent,
  type CatalogSkillComponent,
} from '@/lib/integrations-catalog/registry';

/** Where a component can be viewed: the skill's folder on GitHub, the plugin on npm. */
const catalogComponentHref = (component: CatalogComponent): string | null => {
  if (component.kind === 'skill') return `https://github.com/${component.source}/tree/HEAD/${component.subpath}`;
  if (component.kind === 'plugin') return `https://www.npmjs.com/package/${catalogPluginPackageName(component.spec)}`;
  if (component.kind === 'extension') return component.gitUrl;
  return null;
};

const readMcpStatusName = (status: { status: { status: string } } | undefined): string | undefined =>
  status?.status?.status;

type ConfirmRequest =
  | { kind: 'plugin-install'; entry: CatalogEntry }
  | { kind: 'uninstall'; entry: CatalogEntry };

/** What the catalog rail selects: a category, or the installed-only view. */
type RailSelection =
  | { kind: 'all' }
  | { kind: 'installed' }
  | { kind: 'category'; category: CatalogCategory };

// Stable empty references: a selector returning a fresh [] or {} on every
// call re-renders the component forever (Maximum update depth exceeded).
const EMPTY_MCP_SERVERS: never[] = [];
const EMPTY_MCP_STATUSES: Record<string, McpServerStatus> = {};
const EMPTY_PLUGIN_ENTRIES: PluginEntry[] = [];
const EMPTY_GUESTS: import('@/lib/guests/types').InstalledGuest[] = [];
const EMPTY_REGISTRY_INFO: Record<string, RegistryResult> = {};
const EMPTY_SKILLS: DiscoveredSkill[] = [];

/** The name OpenCode reports for a skill: SKILL.md frontmatter when it differs from the folder basename. */
const skillReportedName = (component: CatalogSkillComponent): string => component.skillName ?? component.skillDir;

const requiresNoteKey = {
  node: 'integrationsCatalog.requires.node',
  python: 'integrationsCatalog.requires.python',
  docker: 'integrationsCatalog.requires.docker',
} satisfies Record<'node' | 'python' | 'docker', I18nKey>;

const CATEGORY_LABEL_KEY = {
  product: 'integrationsCatalog.category.product',
  code: 'integrationsCatalog.category.code',
  design: 'integrationsCatalog.category.design',
  cloud: 'integrationsCatalog.category.cloud',
  data: 'integrationsCatalog.category.data',
  quality: 'integrationsCatalog.category.quality',
  ai: 'integrationsCatalog.category.ai',
  other: 'integrationsCatalog.category.other',
} satisfies Record<CatalogCategory, I18nKey>;

/** What a card's status pill shows. */
type CatalogCardStatus = { label: string; tone: IntegrationCatalogStatusTone };

/** A user-scope MCP draft with the same defaults the Settings → MCP add form uses. */
const buildCatalogMcpDraft = (entry: CatalogEntry, component: CatalogMcpComponent, values: Record<string, string>, token: string): McpDraft => {
  const base: McpDraft = {
    name: entry.id,
    scope: 'user',
    type: 'local',
    command: [],
    url: '',
    environment: [],
    headers: [],
    ...MCP_DRAFT_OAUTH_UNSET,
    oauthAuthServerMetadataUrl: '',
    protocol: 'legacy',
    timeoutStartup: '',
    timeoutCatalog: '',
    timeoutExecution: '',
    codemode: 'default',
    disabled: false,
  };
  if (component.remote) {
    const header = component.remote.tokenHeader;
    const tokenValue = token.trim();
    return {
      ...base,
      type: 'remote',
      url: interpolateCatalogTokens(component.remote.url, values),
      headers: header && (tokenValue !== '' || !component.remote.tokenOptional)
        ? [{ key: header.name, value: `${header.valuePrefix ?? ''}${tokenValue}` }]
        : [],
    };
  }
  const local = component.local;
  return {
    ...base,
    type: 'local',
    command: local ? local.command.map((part) => interpolateCatalogTokens(part, values)) : [],
    timeoutStartup: local?.timeoutMs ? String(local.timeoutMs) : '',
  };
};

/** The card's mark: the official brand glyph or the generic sprite icon, monochrome on the muted tile. */
function CatalogMark({ entry, large = false }: { entry: CatalogEntry; large?: boolean }): React.ReactNode {
  const brand = brandIconFor(entry.id);
  const tileClass = large ? 'size-16 rounded-2xl' : 'size-10 rounded-[10px]';
  const glyphClass = large ? 'size-9' : 'size-5';
  return (
    <div className={cn(tileClass, 'flex shrink-0 items-center justify-center bg-[var(--surface-muted)] text-muted-foreground')}>
      {brand ? (
        <svg viewBox="0 0 24 24" className={glyphClass} aria-hidden="true">
          <path d={brand.path} fill="currentColor" />
        </svg>
      ) : (
        <Icon name={entry.icon} className={glyphClass} />
      )}
    </div>
  );
}

export function IntegrationsCatalogView(): React.ReactNode {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const mcpServers = useMcpConfigStore((state) => open ? state.mcpServers : EMPTY_MCP_SERVERS);
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const createMcp = useMcpConfigStore((state) => state.createMcp);
  const deleteMcp = useMcpConfigStore((state) => state.deleteMcp);
  const setSelectedMcp = useMcpConfigStore((state) => state.setSelectedMcp);
  const refreshMcpStatus = useMcpStore((state) => state.refresh);
  const mcpStatuses = useMcpStore((state) => open ? state.getStatusForDirectory(currentDirectory) : EMPTY_MCP_STATUSES);
  const pluginEntries = usePluginsStore((state) => open ? state.entries : EMPTY_PLUGIN_ENTRIES);
  const pluginRegistryInfo = usePluginsStore((state) => open ? state.registryInfo : EMPTY_REGISTRY_INFO);
  const loadPlugins = usePluginsStore((state) => state.loadPlugins);
  const createPluginEntry = usePluginsStore((state) => state.createEntry);
  const deletePluginEntry = usePluginsStore((state) => state.deleteEntry);
  const setSelectedPlugin = usePluginsStore((state) => state.setSelected);
  const skills = useSkillsStore((state) => open ? state.skills : EMPTY_SKILLS);
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const installSkills = useSkillsCatalogStore((state) => state.installSkills);
  const guests = useGuestsStore((state) => open ? state.guests : EMPTY_GUESTS);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [railSelection, setRailSelection] = React.useState<RailSelection>({ kind: 'all' });
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmRequest | null>(null);
  const [inputValues, setInputValues] = React.useState<Record<string, Record<string, string>>>({});
  const [tokenValues, setTokenValues] = React.useState<Record<string, string>>({});

  React.useEffect(() => {
    if (!open) return;
    void loadMcpConfigs();
    void loadPlugins();
    void loadSkills();
    void loadGuestCatalog();
    void refreshMcpStatus({ directory: currentDirectory });
  }, [open, loadMcpConfigs, loadPlugins, loadSkills, refreshMcpStatus, currentDirectory]);

  React.useEffect(() => {
    if (!open) {
      setSelectedId(null);
      setQuery('');
      setRailSelection({ kind: 'all' });
      setBusyId(null);
      setConfirm(null);
      setInputValues({});
      setTokenValues({});
    }
  }, [open]);

  const readInput = React.useCallback((entry: CatalogEntry, inputId: string): string => {
    const input = entry.inputs?.find((candidate) => candidate.id === inputId);
    return inputValues[entry.id]?.[inputId] ?? input?.defaultValue ?? '';
  }, [inputValues]);

  const setInputValue = React.useCallback((entryId: string, inputId: string, value: string) => {
    setInputValues((prev) => ({ ...prev, [entryId]: { ...prev[entryId], [inputId]: value } }));
  }, []);

  const readToken = React.useCallback((entry: CatalogEntry): string => tokenValues[entry.id] ?? '', [tokenValues]);
  const setTokenValue = (entryId: string, value: string) => setTokenValues((prev) => ({ ...prev, [entryId]: value }));

  const installedMcp = React.useMemo(
    () => new Set(mcpServers.map((server) => server.name)),
    [mcpServers],
  );
  const installedPluginNames = React.useMemo(
    () => new Set(pluginEntries.filter((entry) => entry.parsedKind === 'npm').map((entry) => catalogPluginPackageName(entry.spec))),
    [pluginEntries],
  );
  const installedSkillNames = React.useMemo(
    () => new Set(skills.map((skill) => skill.name)),
    [skills],
  );
  const installedGuestIds = React.useMemo(
    () => new Set(guests.map((guest) => guest.id)),
    [guests],
  );

  const isMcpInstalled = React.useCallback((entry: CatalogEntry): boolean =>
    installedMcp.has(entry.id), [installedMcp]);
  const isPluginInstalled = React.useCallback((component: CatalogPluginComponent): boolean =>
    installedPluginNames.has(catalogPluginPackageName(component.spec)), [installedPluginNames]);
  const isSkillInstalled = React.useCallback((skillName: string): boolean =>
    installedSkillNames.has(skillName), [installedSkillNames]);
  const isExtensionInstalled = React.useCallback((guestId: string): boolean =>
    installedGuestIds.has(guestId), [installedGuestIds]);

  /** Every installable part of the integration is present. */
  const isEntryInstalled = React.useCallback((entry: CatalogEntry): boolean =>
    entry.components.every((component) => {
      if (component.kind === 'mcp') return isMcpInstalled(entry);
      if (component.kind === 'plugin') return isPluginInstalled(component);
      if (component.kind === 'extension') return isExtensionInstalled(component.guestId);
      return isSkillInstalled(skillReportedName(component));
    }), [isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled]);

  /** How many catalog entries are fully installed right now. */
  const installedCount = React.useMemo(
    () => CATALOG_ENTRIES.filter((entry) => isEntryInstalled(entry)).length,
    [isEntryInstalled],
  );

  const filteredEntries = React.useMemo(() => {
    const entries = [...CATALOG_ENTRIES];
    const selection = railSelection;
    const selectionFiltered = selection.kind === 'category'
      ? entries.filter((entry) => entry.categories.includes(selection.category))
      : selection.kind === 'installed'
        ? entries.filter((entry) => isEntryInstalled(entry))
        : entries;
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return selectionFiltered;
    return rankByQuery(selectionFiltered, normalizedQuery, (entry) => [
      entry.name,
      entry.publisher,
      t(entry.descriptionKey),
    ]);
  }, [query, isEntryInstalled, railSelection, t]);

  const componentKindLabelKey = (component: CatalogComponent): I18nKey => {
    if (component.kind === 'plugin') return 'integrationsCatalog.status.plugin';
    if (component.kind === 'skill') return 'integrationsCatalog.status.skill';
    if (component.kind === 'extension') return 'integrationsCatalog.status.extension';
    if (component.local) return 'integrationsCatalog.status.local';
    if (component.auth === 'token') return 'integrationsCatalog.status.token';
    if (component.auth === 'none') return 'integrationsCatalog.status.noAuth';
    return 'integrationsCatalog.status.oauth';
  };

  const statusOf = React.useCallback((entry: CatalogEntry): CatalogCardStatus => {
    if (entry.status === 'coming-soon') return { label: t('integrationsCatalog.status.comingSoon'), tone: 'neutral' };
    // Runtime status outranks everything: a bundled entry whose MCP server
    // asks for sign-in must show it even while its skills are not installed.
    const runtime = readMcpStatusName(mcpStatuses[entry.id]);
    if (runtime === 'needs_auth') return { label: t('integrationsCatalog.status.needsAuth'), tone: 'warning' };
    if (runtime === 'failed') return { label: t('integrationsCatalog.status.failed'), tone: 'warning' };
    if (isEntryInstalled(entry)) {
      const plugin = entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin');
      if (plugin) {
        const spec = pluginRegistryInfo[plugin.spec];
        if (spec?.kind === 'npm-ok' && spec.hasUpdate) return { label: t('integrationsCatalog.status.updateAvailable'), tone: 'warning' };
      }
      const server = mcpServers.find((candidate) => candidate.name === entry.id);
      if (server?.disabled) return { label: t('integrationsCatalog.status.disabled'), tone: 'neutral' };
      return { label: t('integrationsCatalog.status.installed'), tone: 'success' };
    }
    return { label: t(componentKindLabelKey(entry.components[0])), tone: 'neutral' };
  }, [isEntryInstalled, mcpServers, mcpStatuses, pluginRegistryInfo, t]);

  const openInSettings = React.useCallback((entry: CatalogEntry) => {
    const mcp = catalogMcpComponent(entry);
    const plugin = entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin');
    if (mcp) {
      setSettingsPage('mcp');
      setSelectedMcp(entry.id);
    } else if (plugin) {
      setSettingsPage('plugins');
      const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(plugin.spec));
      setSelectedPlugin(installed?.id ?? null);
    } else {
      setSettingsPage('skills.catalog');
    }
    setSettingsDialogOpen(true);
  }, [pluginEntries, setSettingsDialogOpen, setSelectedMcp, setSelectedPlugin, setSettingsPage]);

  /**
   * Opens Settings on the page that owns one component, with that component
   * selected: MCP → its server page, plugin → its entry, skill → its editor,
   * extension → the extensions page.
   */
  const configureComponent = React.useCallback((entry: CatalogEntry, component: CatalogComponent) => {
    if (component.kind === 'mcp') {
      setSettingsPage('mcp');
      setSelectedMcp(entry.id);
    } else if (component.kind === 'plugin') {
      setSettingsPage('plugins');
      const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(component.spec));
      setSelectedPlugin(installed?.id ?? null);
    } else if (component.kind === 'skill') {
      setSettingsPage('skills.installed');
      // Settings selects by id: the folder the install created, `skillDir`.
      useSkillsStore.getState().setSelectedSkill(component.skillDir);
    } else {
      setSettingsPage('extensions');
    }
    setSettingsDialogOpen(true);
  }, [pluginEntries, setSettingsDialogOpen, setSelectedMcp, setSelectedPlugin, setSettingsPage]);

  /**
   * One Install pass over every component of the entry: the MCP server, the
   * plugin, and the skills. Already-installed components are skipped, so a
   * re-run cannot fail on "already exists". A plugin keeps its explicit
   * confirmation; skills install with skip-all conflicts so nothing is
   * overwritten silently.
   */
  const installEntry = React.useCallback(async (entry: CatalogEntry) => {
    setBusyId(entry.id);
    try {
      let failed = false;
      let errorDetail: string | null = null;
      // Skills of one source install in a single call (one clone), with the
      // repo-root-relative subpath as the selection: the installer
      // sparse-checkouts selections from the repository root.
      const pendingSkills = new Map<string, CatalogSkillComponent[]>();
      for (const component of entry.components) {
        if (component.kind === 'mcp') {
          if (isMcpInstalled(entry)) continue;
          const token = component.auth === 'token' ? readToken(entry) : '';
          const values: Record<string, string> = {};
          for (const input of entry.inputs ?? []) values[input.id] = readInput(entry, input.id);
          const result = await createMcp(buildCatalogMcpDraft(entry, component, values, token));
          if (!result.ok) {
            failed = true;
            continue;
          }
          if (result.reloadFailed) {
            toast.warning(result.message || t('integrationsCatalog.install.success', { name: entry.name }), {
              description: result.warning || undefined,
            });
          }
          // The config write reaches disk immediately, but OpenCode rereads
          // it on its own schedule; without a reload the mcp_* OAuth
          // integration is missing from integration.list and the sign-in
          // panel below cannot appear. The same reload Settings performs
          // on Apply & Restart.
          try {
            const response = await runtimeFetch('/api/config/reload', { method: 'POST' });
            if (!response.ok) {
              const payload = await response.json().catch(() => null);
              if (payload?.requiresManualRestart) {
                toast.warning(payload?.message ?? undefined);
              }
            }
          } catch {
            // The reload is best-effort: the sign-in panel's own retry
            // (McpOAuthSignIn) still picks the integration up late.
          }
          try {
            await useMcpStore.getState().connect(entry.id, currentDirectory);
          } catch {
            if (component.auth === 'oauth') {
              // A failed connect is the expected 401 path for an OAuth
              // server: refresh statuses so needs_auth lands in the map and
              // the sign-in panel can open the browser. A real network or
              // server failure shows up as the failed pill instead.
              await useMcpStore.getState().refresh({ directory: currentDirectory, silent: true }).catch(() => undefined);
            } else {
              toast.error(t('integrationsCatalog.connect.failed', { name: entry.name }));
            }
          }
        } else if (component.kind === 'plugin') {
          if (isPluginInstalled(component)) continue;
          const result = await createPluginEntry({ spec: component.spec, scope: 'user' });
          if (!result.ok) failed = true;
        } else if (component.kind === 'extension') {
          if (isExtensionInstalled(component.guestId)) continue;
          const result = await installGuest(component.gitUrl);
          if (!result.ok) {
            failed = true;
            errorDetail = errorDetail ?? result.code;
          }
        } else {
          if (isSkillInstalled(skillReportedName(component))) continue;
          const batch = pendingSkills.get(component.source) ?? [];
          batch.push(component);
          pendingSkills.set(component.source, batch);
        }
      }
      for (const [source, batch] of pendingSkills) {
        const response = await installSkills({
          source,
          scope: 'user',
          selections: batch.map((component) => ({ skillDir: component.subpath })),
          conflictPolicy: 'skipAll',
        });
        if (!response.ok) {
          failed = true;
          errorDetail = response.error?.message ?? errorDetail;
        }
      }
      if (failed) {
        toast.error(t('integrationsCatalog.install.failed', { name: entry.name }), {
          description: errorDetail ?? undefined,
        });
      } else {
        toast.success(t('integrationsCatalog.install.success', { name: entry.name }));
      }
    } finally {
      setBusyId(null);
    }
  }, [createMcp, createPluginEntry, currentDirectory, installSkills, isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled, readInput, readToken, t]);

  /** One Uninstall pass: removes the MCP server, the plugin entries, and the installed skills. */
  const uninstallEntry = React.useCallback(async (entry: CatalogEntry) => {
    setBusyId(entry.id);
    setConfirm(null);
    try {
      let failed = false;
      let errorDetail: string | null = null;
      const mcp = catalogMcpComponent(entry);
      if (mcp && isMcpInstalled(entry)) {
        const result = await deleteMcp(entry.id);
        if (!result.ok) {
          failed = true;
          errorDetail = t('integrationsCatalog.uninstall.mcpDetail', { name: entry.id });
        }
      }
      for (const component of entry.components) {
        if (component.kind === 'plugin' && isPluginInstalled(component)) {
          const installed = pluginEntries.find((candidate) => catalogPluginPackageName(candidate.spec) === catalogPluginPackageName(component.spec));
          if (installed) {
            const result = await deletePluginEntry(installed.id);
            if (!result.ok) {
              failed = true;
              errorDetail = t('integrationsCatalog.uninstall.pluginDetail', { spec: component.spec });
            }
          }
        }
        if (component.kind === 'extension' && isExtensionInstalled(component.guestId)) {
          const result = await uninstallGuest(component.guestId);
          if (!result.ok) {
            failed = true;
            errorDetail = t('integrationsCatalog.uninstall.extensionDetail', { name: component.guestId });
          }
        }
        // Deletion is filesystem-level and keys on the folder basename, while
        // the installed check keys on the SKILL.md frontmatter name; the two
        // differ for some vendors (Vercel's react skill).
        if (component.kind === 'skill' && isSkillInstalled(skillReportedName(component))) {
          const ok = await useSkillsStore.getState().deleteSkill(
            { id: component.skillDir, name: skillReportedName(component) },
            currentDirectory ?? undefined,
          );
          if (!ok) {
            failed = true;
            errorDetail = t('integrationsCatalog.uninstall.skillDetail', { name: component.skillDir });
          }
        }
      }
      if (failed) {
        toast.error(t('integrationsCatalog.uninstall.failed', { name: entry.name }), {
          description: errorDetail ?? undefined,
        });
      } else {
        toast.success(t('integrationsCatalog.uninstall.success', { name: entry.name }));
      }
    } finally {
      setBusyId(null);
    }
  }, [currentDirectory, deleteMcp, deletePluginEntry, isExtensionInstalled, isMcpInstalled, isPluginInstalled, isSkillInstalled, pluginEntries, t]);

  const canInstallEntry = (entry: CatalogEntry): boolean => {
    if (entry.status === 'coming-soon') return false;
    const mcp = catalogMcpComponent(entry);
    if (!mcp) return true;
    if (mcp.auth === 'token') {
      const token = readToken(entry);
      return token.trim() !== '' || mcp.remote?.tokenOptional === true;
    }
    return catalogEntryHasAllInputs(entry, Object.fromEntries((entry.inputs ?? []).map((input) => [input.id, readInput(entry, input.id)])));
  };

  const statusPillClass = (tone: IntegrationCatalogStatusTone): string => {
    if (tone === 'success') return 'bg-[var(--status-success)]/15 text-[var(--status-success)]';
    if (tone === 'warning') return 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]';
    return 'bg-[var(--surface-muted)] text-muted-foreground';
  };

  /** The mcp component's own controls: token field, links, notes, sign-in panel. */
  const renderMcpComponentControls = (entry: CatalogEntry, component: CatalogMcpComponent): React.ReactNode => {
    const componentInstalled = isMcpInstalled(entry);
    const runtimeStatus = readMcpStatusName(mcpStatuses[entry.id]);

    return (
      <>
        {component.auth === 'token' && component.remote ? (
          <div className="flex items-center gap-2">
            <label htmlFor={`catalog-token-${entry.id}`} className="w-28 shrink-0 text-xs text-muted-foreground">
              {t('integrationsCatalog.token.label')}
            </label>
            <Input
              id={`catalog-token-${entry.id}`}
              type="password"
              autoComplete="off"
              value={readToken(entry)}
              onChange={(event) => setTokenValue(entry.id, event.target.value)}
              placeholder={t('integrationsCatalog.token.placeholder')}
              className="h-8 max-w-xs text-xs"
            />
          </div>
        ) : null}

        {component.tokenHelpUrl ? (
          <p className="text-xs text-muted-foreground">
            <a href={component.tokenHelpUrl} target="_blank" rel="noreferrer" className="text-foreground underline decoration-[var(--interactive-border)] underline-offset-2 hover:decoration-foreground">
              {t('integrationsCatalog.token.getToken')}
            </a>
            {component.remote?.tokenOptional ? ` — ${t('integrationsCatalog.token.optional')}` : ''}
          </p>
        ) : null}

        {component.local ? (
          <p className="text-xs text-muted-foreground">
            {[
              ...(component.local.requires ?? []).map((requirement) => t(requiresNoteKey[requirement])),
              t('integrationsCatalog.local.note'),
              t('integrationsCatalog.requires.prefix'),
            ].join(' ')}
          </p>
        ) : null}

        {component.auth === 'oauth' && component.remote ? (
          <p className="text-xs text-muted-foreground">{t('integrationsCatalog.oauth.note')}</p>
        ) : null}

        {runtimeStatus === 'needs_auth' && componentInstalled ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t('integrationsCatalog.oauth.waiting')}</p>
            <McpOAuthSignIn
              serverName={entry.id}
              directory={currentDirectory}
              onConnected={() => { void useMcpStore.getState().connect(entry.id, currentDirectory); }}
            />
          </div>
        ) : null}
      </>
    );
  };

  /** One informational row of the Includes list: component name, kind, state. */
  const renderComponentRow = (entry: CatalogEntry, component: CatalogComponent): React.ReactNode => {
    const componentInstalled = component.kind === 'mcp'
      ? isMcpInstalled(entry)
      : component.kind === 'plugin'
        ? isPluginInstalled(component)
        : component.kind === 'extension'
          ? isExtensionInstalled(component.guestId)
          : isSkillInstalled(component.kind === 'skill' ? skillReportedName(component) : '');

    return (
      <div key={component.kind} className="flex flex-col gap-2 border-b border-[var(--interactive-border)] py-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
          {(() => {
            const href = catalogComponentHref(component);
            const name = catalogComponentName(entry, component);
            return href ? (
              <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground underline decoration-transparent underline-offset-2 transition-colors hover:decoration-foreground">
                <span className="truncate">{name}</span>
                <Icon name="external-link" className="size-3 shrink-0 text-muted-foreground/50" />
              </a>
            ) : (
              <span className="min-w-0 truncate text-sm font-medium text-foreground">{name}</span>
            );
          })()}
          <div className="ms-auto flex shrink-0 items-center gap-1.5">
            {componentInstalled ? (
              <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-medium', statusPillClass('success'))}>
                {t('integrationsCatalog.status.installed')}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground hover:text-foreground"
              aria-label={t('integrationsCatalog.action.configure')}
              title={t('integrationsCatalog.action.configure')}
              onClick={() => configureComponent(entry, component)}
            >
              <Icon name="settings-3" className="size-3.5" />
            </Button>
          </div>
        </div>
        {component.kind === 'mcp' ? renderMcpComponentControls(entry, component) : null}
      </div>
    );
  };

  /** Hero action row: one Install for the whole entry, then Manage and Uninstall. */
  const renderHeroActions = (entry: CatalogEntry): React.ReactNode => {
    if (entry.status === 'coming-soon') return null;
    const isBusy = busyId === entry.id;
    if (!isEntryInstalled(entry)) {
      const hasPlugin = entry.components.some((component) => component.kind === 'plugin');
      return (
        <Button
          variant="default"
          size="sm"
          disabled={isBusy || !canInstallEntry(entry)}
          onClick={() => hasPlugin
            ? setConfirm({ kind: 'plugin-install', entry })
            : void installEntry(entry)}
        >
          {isBusy ? t('integrationsCatalog.action.installing') : t('integrationsCatalog.action.install')}
        </Button>
      );
    }
    return (
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => openInSettings(entry)}>
          {t('integrationsCatalog.action.manage')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={isBusy}
          onClick={() => setConfirm({ kind: 'uninstall', entry })}
        >
          {t('integrationsCatalog.action.uninstall')}
        </Button>
      </div>
    );
  };

  const selectedEntry = selectedId ? CATALOG_ENTRIES.find((entry) => entry.id === selectedId) : undefined;

  const sameSelection = (a: RailSelection, b: RailSelection): boolean => {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'category' && b.kind === 'category') return a.category === b.category;
    return true;
  };

  const renderRailItem = (selection: RailSelection, label: string, count: number): React.ReactNode => {
    const selected = !selectedEntry && sameSelection(railSelection, selection);
    return (
      <button
        key={selection.kind === 'category' ? `category-${selection.category}` : selection.kind}
        type="button"
        onClick={() => {
          setSelectedId(null);
          setRailSelection(selection);
        }}
        aria-pressed={selected}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start typography-ui-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected
            ? 'bg-interactive-selection text-foreground'
            : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
        )}
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 typography-micro text-muted-foreground/70">{count}</span>
      </button>
    );
  };

  const renderDetail = (entry: CatalogEntry): React.ReactNode => {
    const status = statusOf(entry);
    const mcp = catalogMcpComponent(entry);

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-1 px-6 pt-3">
          <Button variant="ghost" size="xs" className="-ms-2 gap-1.5 text-muted-foreground hover:text-foreground" onClick={() => setSelectedId(null)}>
            <Icon name="arrow-left-s" className="size-4" />
            {t('integrationsCatalog.detail.back')}
          </Button>
          <Icon name="arrow-right-s" className="size-3.5 shrink-0 text-muted-foreground/50" />
          <span className="min-w-0 truncate typography-ui-label text-foreground">{entry.name}</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 pb-6">
            <div className="flex flex-wrap items-start gap-4">
              <CatalogMark entry={entry} large />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-lg font-semibold text-foreground">{entry.name}</h2>
                  <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', statusPillClass(status.tone))}>
                    {status.label}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{t(entry.descriptionKey)}</p>
              </div>
              <div className="flex shrink-0 items-center">{renderHeroActions(entry)}</div>
            </div>

            <p className="text-sm leading-relaxed text-foreground">{t(entry.detailsKey)}</p>

            {entry.status === 'coming-soon' ? (
              <p className="text-sm text-muted-foreground">{t('integrationsCatalog.comingSoon.note')}</p>
            ) : null}

            {entry.status !== 'coming-soon' ? (
              <>
                {mcp ? (
                  <section className="flex flex-col gap-3">
                    <h3 className="typography-ui-label font-semibold text-foreground">
                      {t('integrationsCatalog.group.mcp')}
                    </h3>
                    {entry.inputs ? (
                      <div className="flex flex-col gap-2">
                        {entry.inputs.map((input) => (
                          <div key={input.id} className="flex items-center gap-2">
                            <label htmlFor={`catalog-input-${entry.id}-${input.id}`} className="w-28 shrink-0 text-xs text-muted-foreground">
                              {t(input.labelKey)}
                            </label>
                            <Input
                              id={`catalog-input-${entry.id}-${input.id}`}
                              value={readInput(entry, input.id)}
                              onChange={(event) => setInputValue(entry.id, input.id, event.target.value)}
                              placeholder={input.placeholder}
                              className="h-8 max-w-xs text-xs"
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {renderComponentRow(entry, mcp)}
                  </section>
                ) : null}

                {(() => {
                  const plugins = entry.components.filter((component): component is CatalogPluginComponent => component.kind === 'plugin');
                  if (plugins.length === 0) return null;
                  return (
                    <section className="flex flex-col gap-1">
                      <h3 className="typography-ui-label font-semibold text-foreground">
                        {t('integrationsCatalog.group.plugin')}
                        <span className="ms-2 font-normal text-muted-foreground">{plugins.length}</span>
                      </h3>
                      {plugins.map((component) => renderComponentRow(entry, component))}
                    </section>
                  );
                })()}

                {(() => {
                  const skillComponents = entry.components.filter((component): component is CatalogSkillComponent => component.kind === 'skill');
                  if (skillComponents.length === 0) return null;
                  return (
                    <section className="flex flex-col gap-1">
                      <h3 className="typography-ui-label font-semibold text-foreground">
                        {t('integrationsCatalog.group.skills')}
                        <span className="ms-2 font-normal text-muted-foreground">{skillComponents.length}</span>
                      </h3>
                      {skillComponents.map((component) => renderComponentRow(entry, component))}
                    </section>
                  );
                })()}

                {(() => {
                  const extensions = entry.components.filter((component): component is CatalogExtensionComponent => component.kind === 'extension');
                  if (extensions.length === 0) return null;
                  return (
                    <section className="flex flex-col gap-1">
                      <h3 className="typography-ui-label font-semibold text-foreground">
                        {t('integrationsCatalog.group.extension')}
                        <span className="ms-2 font-normal text-muted-foreground">{extensions.length}</span>
                      </h3>
                      {extensions.map((component) => renderComponentRow(entry, component))}
                    </section>
                  );
                })()}
              </>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="typography-ui-label font-semibold text-foreground">{t('integrationsCatalog.detail.info')}</h3>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">{t('integrationsCatalog.info.developer')}</dt>
                <dd className="min-w-0 text-foreground">{entry.publisher}</dd>
                <dt className="text-muted-foreground">{t('integrationsCatalog.info.category')}</dt>
                <dd className="min-w-0 text-foreground">{t(CATEGORY_LABEL_KEY[entry.categories[0]])}</dd>
                <dt className="text-muted-foreground">{t('integrationsCatalog.info.type')}</dt>
                <dd className="min-w-0 text-foreground">
                  {[
                    ...new Set(entry.components.map((component) => component.kind)),
                  ].map((kind) => t(
                    kind === 'mcp'
                      ? 'integrationsCatalog.group.mcp'
                      : kind === 'plugin'
                        ? 'integrationsCatalog.group.plugin'
                        : kind === 'extension'
                          ? 'integrationsCatalog.group.extension'
                          : 'integrationsCatalog.group.skills',
                  )).join(' · ')}
                </dd>
                <dt className="text-muted-foreground">{t('integrationsCatalog.info.website')}</dt>
                <dd className="min-w-0">
                  <a href={entry.homepage} target="_blank" rel="noreferrer" className="break-all text-foreground underline decoration-[var(--interactive-border)] underline-offset-2 hover:decoration-foreground">
                    {entry.homepage}
                  </a>
                </dd>
                {mcp?.remote ? (
                  <>
                    <dt className="text-muted-foreground">{t('integrationsCatalog.info.endpoint')}</dt>
                    <dd className="min-w-0 break-all font-mono text-xs text-foreground">{interpolateCatalogTokens(mcp.remote.url, Object.fromEntries((entry.inputs ?? []).map((input) => [input.id, readInput(entry, input.id)])))}</dd>
                  </>
                ) : null}
                {(() => {
                  const uniqueSources = [...new Set(entry.components.filter((component): component is CatalogSkillComponent => component.kind === 'skill').map((component) => component.source))];
                  return uniqueSources.map((source) => {
                    const href = `https://github.com/${source}/tree/HEAD`;
                    return [
                      <dt key={`${source}-src`} className="text-muted-foreground">{t('integrationsCatalog.info.source')}</dt>,
                      <dd key={`${source}-srcv`} className="min-w-0 break-all font-mono text-xs text-foreground">
                        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-[var(--interactive-border)] underline-offset-2 hover:decoration-foreground">
                          {source}
                        </a>
                      </dd>,
                    ];
                  });
                })()}
                {entry.components.filter((component): component is CatalogPluginComponent => component.kind === 'plugin').map((component) => [
                  <dt key={`${component.spec}-pkg`} className="text-muted-foreground">{t('integrationsCatalog.info.package')}</dt>,
                  <dd key={`${component.spec}-pkgv`} className="min-w-0 break-all font-mono text-xs text-foreground">
                    <a href={catalogComponentHref(component) ?? entry.homepage} target="_blank" rel="noreferrer" className="underline decoration-[var(--interactive-border)] underline-offset-2 hover:decoration-foreground">
                      {component.spec}
                    </a>
                  </dd>,
                  <dt key={`${component.spec}-lic`} className="text-muted-foreground">{t('integrationsCatalog.info.license')}</dt>,
                  <dd key={`${component.spec}-licv`} className="min-w-0 text-foreground">{component.license ?? t('integrationsCatalog.plugin.confirm.unlicensed')}</dd>,
                ])}
              </dl>
            </section>

            {entry.status !== 'coming-soon' ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t('integrationsCatalog.detail.dataNote')}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  /** The card's own action: one-click install, or Manage once installed. */
  const renderCardAction = (entry: CatalogEntry): React.ReactNode => {
    if (entry.status === 'coming-soon') return null;
    const isBusy = busyId === entry.id;
    if (!isEntryInstalled(entry)) {
      const hasPlugin = entry.components.some((component) => component.kind === 'plugin');
      return (
        <Button
          variant="default"
          size="xs"
          disabled={isBusy || !canInstallEntry(entry)}
          onClick={(event) => {
            event.stopPropagation();
            if (hasPlugin) setConfirm({ kind: 'plugin-install', entry });
            else void installEntry(entry);
          }}
        >
          {isBusy ? t('integrationsCatalog.action.installing') : t('integrationsCatalog.action.install')}
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={(event) => {
          event.stopPropagation();
          openInSettings(entry);
        }}
      >
        {t('integrationsCatalog.action.manage')}
      </Button>
    );
  };

  const renderGridCard = (entry: CatalogEntry): React.ReactNode => {
    const status = statusOf(entry);
    return (
      <div
        key={entry.id}
        role="button"
        tabIndex={0}
        onClick={() => setSelectedId(entry.id)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSelectedId(entry.id);
          }
        }}
        className="group flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-3.5 py-3 text-start transition-colors hover:bg-[var(--interactive-hover)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
      >
        <div className="flex items-start gap-2.5">
          <CatalogMark entry={entry} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-semibold text-foreground">{entry.name}</span>
              <span className={cn('max-w-20 shrink-0 truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium', statusPillClass(status.tone))}>
                {status.label}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">{t(entry.descriptionKey)}</p>
          </div>
        </div>
        <div className="mt-auto flex min-h-6 items-center justify-end">
          {renderCardAction(entry)}
        </div>
      </div>
    );
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-10 flex bg-background">
      <div className="flex w-52 shrink-0 flex-col border-e border-border/50">
        <div className="flex-1 overflow-y-auto p-2">
          {renderRailItem({ kind: 'all' }, t('integrationsCatalog.category.all'), CATALOG_ENTRIES.length)}
          <div className="my-1.5 border-t border-[var(--interactive-border)]/60" />
          {renderRailItem({ kind: 'installed' }, t('integrationsCatalog.filter.installed'), installedCount)}
          <div className="my-1.5 border-t border-[var(--interactive-border)]/60" />
          {CATALOG_CATEGORY_ORDER.map((category) =>
            renderRailItem({ kind: 'category', category }, t(CATEGORY_LABEL_KEY[category]), CATALOG_ENTRIES.filter((entry) => entry.categories.includes(category)).length))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {selectedEntry ? renderDetail(selectedEntry) : (
          <>
            <div className="flex items-center justify-between gap-4 px-6 pt-4">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-foreground">{t('integrationsCatalog.page.title')}</h2>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t('integrationsCatalog.page.subtitle')}
                </p>
              </div>
              <div className="relative w-64 shrink-0">
                <Icon
                  name="search"
                  className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('integrationsCatalog.search.placeholder')}
                  aria-label={t('integrationsCatalog.search.placeholder')}
                  className="h-9 rounded-full border-none bg-[var(--surface-muted)] ps-9 shadow-none ring-1 ring-inset ring-transparent transition-colors hover:bg-[var(--interactive-hover)]/40 focus:bg-[var(--surface-muted)] focus:ring-[var(--interactive-focus-ring)]"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 pt-4">
              <div className="mx-auto grid w-full max-w-4xl gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
                {filteredEntries.length === 0 ? (
                  <div className="col-span-full py-10 text-center text-muted-foreground">
                    <p className="typography-ui-label font-semibold">
                      {t('integrationsCatalog.empty.noMatches', { query })}
                    </p>
                  </div>
                ) : filteredEntries.map((entry) => renderGridCard(entry))}
              </div>
            </div>
          </>
        )}
      </div>

      {confirm ? (
        <Dialog open onOpenChange={(next) => { if (!next) setConfirm(null); }}>
          <DialogContent className="max-w-md">
            {confirm.kind === 'plugin-install' ? (
              <>
                <DialogHeader>
                  <DialogTitle>{t('integrationsCatalog.plugin.confirm.title', { name: confirm.entry.name })}</DialogTitle>
                  <DialogDescription>
                    {t('integrationsCatalog.plugin.confirm.description', { spec: confirm.entry.components.find((component): component is CatalogPluginComponent => component.kind === 'plugin')?.spec ?? '' })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    {t('integrationsCatalog.plugin.confirm.cancel')}
                  </Button>
                  <Button variant="default" size="sm" disabled={busyId === confirm.entry.id} onClick={() => void installEntry(confirm.entry)}>
                    {t('integrationsCatalog.action.install')}
                  </Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>{t('integrationsCatalog.uninstall.title', { name: confirm.entry.name })}</DialogTitle>
                  <DialogDescription>
                    {t('integrationsCatalog.uninstall.description', { name: confirm.entry.name })}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    {t('integrationsCatalog.plugin.confirm.cancel')}
                  </Button>
                  <Button variant="destructive" size="sm" disabled={busyId === confirm.entry.id} onClick={() => void uninstallEntry(confirm.entry)}>
                    {t('integrationsCatalog.uninstall.confirm')}
                  </Button>
                </DialogFooter>
              </>
            )}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}