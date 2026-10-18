type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type SkillPolicyScope = 'global' | 'project';
export type SkillPolicyLocation = 'experimental.policies' | 'policies';

/** One entry of OpenCode's `GET /api/config`, lowest priority first. */
export type SkillPolicyConfigEntry =
  | { type: 'document'; path?: string; info: JsonObject }
  | { type: 'directory'; path: string };

/** What the service reads from the running OpenCode; both reject when it cannot be read. */
export type SkillPolicyOpenCodeReader = {
  readVersion: () => Promise<string | null>;
  readConfigEntries: (directory: string | null) => Promise<SkillPolicyConfigEntry[]>;
};

export type SkillPolicyDecision = {
  path: string | null;
  resource: string;
  effect: 'allow' | 'deny';
};

export type SkillPolicyState = {
  disabledIn: Record<SkillPolicyScope, boolean | null>;
  effective: 'enabled' | 'disabled' | 'unknown';
  decidedBy: (SkillPolicyDecision & { scope: SkillPolicyScope | 'other'; owned: boolean }) | null;
};

export type SkillPolicyScopeTarget = { path: string; error: string | null };

export type SkillPolicySummary = {
  version: string | null;
  location: SkillPolicyLocation | null;
  writable: boolean;
  effectiveAvailable: boolean;
  scopes: { global: SkillPolicyScopeTarget; project: SkillPolicyScopeTarget | null };
};

export type SkillPolicyWriteResult = {
  saved: { scope: SkillPolicyScope; path: string; disabled: boolean; changed: boolean };
  confirmed: boolean;
  state: SkillPolicySummary;
  policy: SkillPolicyState;
};

export type SkillPolicyService = {
  readState: (input: {
    directory: string | null;
    ids: string[];
    openCode: SkillPolicyOpenCodeReader;
  }) => Promise<SkillPolicySummary & { skills: Array<SkillPolicyState & { id: string }> }>;
  setEnabled: (input: {
    directory: string | null;
    id: JsonValue | undefined;
    scope: JsonValue | undefined;
    enabled: JsonValue | undefined;
    openCode: SkillPolicyOpenCodeReader;
  }) => Promise<SkillPolicyWriteResult>;
};

export function skillPolicyLocation(version: string | null | undefined): SkillPolicyLocation | null;
export function isValidSkillPolicyId(id: JsonValue | undefined): id is string;
export function skillIdFromPath(skillPath: string | null | undefined): string | null;
export function listOwnedSkillDenies(config: JsonObject, location?: SkillPolicyLocation | null): string[];
export function setSkillDisabled(config: JsonObject, id: string, disabled: boolean, location: SkillPolicyLocation): boolean;
export function editSkillSwitchText(
  text: string,
  before: JsonObject,
  desired: JsonObject,
  id: string,
  disabled: boolean,
  location: SkillPolicyLocation,
): string | null;
export function findDecidingSkillStatement(
  entries: SkillPolicyConfigEntry[],
  id: string,
  location?: SkillPolicyLocation | null,
): SkillPolicyDecision | null;

export function createSkillPolicyService<Config>(dependencies: {
  resolveTargets: (directory: string | null) => { global: string; project: string | null };
  readConfigFile: (filePath: string) => Config;
  samePath?: (left: string, right: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  confirmAttempts?: number;
  confirmDelayMs?: number;
}): SkillPolicyService;

export function handleSkillPolicyWrite(input: {
  service: SkillPolicyService;
  body: JsonValue | undefined;
  directory: string | null;
  openCode: SkillPolicyOpenCodeReader;
  listInstalledSkillIds: (directory: string | null) => Promise<Set<string>>;
}): Promise<{ status: number; body: JsonObject }>;
