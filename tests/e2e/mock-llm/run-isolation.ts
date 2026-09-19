import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";

export interface MockLlmPorts {
  mockLlm: number;
  ingress: number;
  publicMode: number;
  backend: number;
  automation: number;
  vite: number;
  vscode: number;
}

export interface MockLlmRunPaths {
  runRoot: string;
  stateDir: string;
  automationDbDir: string;
  skillReposHostDir: string;
  userSkillsHostDir: string;
  folderWorkspaceHostDir: string;
}

export interface MockLlmRunContext {
  runId: string;
  ports: MockLlmPorts;
  paths: MockLlmRunPaths;
  leaseDir: string | null;
  ownedPaths: string[];
  ownsLease: boolean;
}

interface CreateRunContextOptions {
  workspaceRoot?: string;
  leaseRoot?: string;
  pid?: number;
}

const PORT_ENV: Record<keyof MockLlmPorts, string> = {
  mockLlm: "MOCK_LLM_PORT",
  ingress: "MOCK_LLM_INGRESS_PORT",
  publicMode: "MOCK_LLM_PUBLIC_MODE_PORT",
  backend: "MOCK_LLM_BACKEND_PORT",
  automation: "MOCK_LLM_AUTOMATION_PORT",
  vite: "MOCK_LLM_VITE_PORT",
  vscode: "MOCK_LLM_VSCODE_PORT",
};

const LEGACY_PORTS: MockLlmPorts = {
  mockLlm: 9999,
  ingress: 18300,
  publicMode: 18301,
  backend: 18000,
  automation: 18001,
  vite: 3001,
  vscode: 8001,
};

const PORT_KEYS = Object.keys(PORT_ENV) as (keyof MockLlmPorts)[];
const DYNAMIC_PORT_MIN = 20_000;
const DYNAMIC_PORT_MAX = 60_000;
const DYNAMIC_PORT_STRIDE = 8;
const MAX_DYNAMIC_ATTEMPTS = 128;

function sanitizeRunId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80);
  return sanitized || "mock-llm-run";
}

function parsePort(value: string | undefined, envName: string): number | null {
  if (value == null || value.trim() === "") return null;
  const port = Number.parseInt(value, 10);
  if (
    !Number.isInteger(port) ||
    String(port) !== value.trim() ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error(
      `${envName} must be an integer port between 1 and 65535 (got ${JSON.stringify(value)}).`,
    );
  }
  return port;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function readLeasePid(leaseDir: string): number | null {
  try {
    const owner = JSON.parse(
      readFileSync(join(leaseDir, "owner.json"), "utf8"),
    ) as { pid?: unknown };
    return typeof owner.pid === "number" ? owner.pid : null;
  } catch {
    return null;
  }
}

function tryClaimLease(leaseDir: string, runId: string, pid: number): boolean {
  try {
    mkdirSync(leaseDir, { recursive: false });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? error.code
        : undefined;
    if (code !== "EEXIST") throw error;

    const ownerPid = readLeasePid(leaseDir);
    if (ownerPid != null && processIsAlive(ownerPid)) return false;

    // A killed test process cannot release its lease. Reap only leases whose
    // recorded owner is no longer alive; a missing/garbled owner is treated as
    // stale because the directory cannot represent a valid active reservation.
    rmSync(leaseDir, { recursive: true, force: true });
    try {
      mkdirSync(leaseDir, { recursive: false });
    } catch {
      return false;
    }
  }

  writeFileSync(
    join(leaseDir, "owner.json"),
    `${JSON.stringify({ pid, runId })}\n`,
    "utf8",
  );
  return true;
}

function mergePorts(
  defaults: MockLlmPorts,
  explicit: Partial<MockLlmPorts>,
): MockLlmPorts {
  return {
    mockLlm: explicit.mockLlm ?? defaults.mockLlm,
    ingress: explicit.ingress ?? defaults.ingress,
    publicMode: explicit.publicMode ?? defaults.publicMode,
    backend: explicit.backend ?? defaults.backend,
    automation: explicit.automation ?? defaults.automation,
    vite: explicit.vite ?? defaults.vite,
    vscode: explicit.vscode ?? defaults.vscode,
  };
}

function assertUniquePorts(ports: MockLlmPorts): void {
  const seen = new Map<number, keyof MockLlmPorts>();
  for (const key of PORT_KEYS) {
    const port = ports[key];
    const previous = seen.get(port);
    if (previous) {
      throw new Error(
        `Mock-LLM port collision: ${PORT_ENV[previous]} and ${PORT_ENV[key]} both resolve to ${port}.`,
      );
    }
    seen.set(port, key);
  }
}

function dynamicPortBlock(base: number): MockLlmPorts {
  return {
    mockLlm: base,
    ingress: base + 1,
    publicMode: base + 2,
    backend: base + 3,
    automation: base + 4,
    vite: base + 5,
    vscode: base + 6,
  };
}

function hasCrossRoleCollision(
  defaults: MockLlmPorts,
  explicit: Partial<MockLlmPorts>,
): boolean {
  try {
    assertUniquePorts(mergePorts(defaults, explicit));
    return false;
  } catch {
    return true;
  }
}

function allocatePorts(
  env: NodeJS.ProcessEnv,
  leaseRoot: string,
  runId: string,
  pid: number,
): { ports: MockLlmPorts; leaseDir: string | null; ownsLease: boolean } {
  const explicit: Partial<MockLlmPorts> = {};
  for (const key of PORT_KEYS) {
    const port = parsePort(env[PORT_ENV[key]], PORT_ENV[key]);
    if (port != null) explicit[key] = port;
  }

  if (PORT_KEYS.every((key) => explicit[key] != null)) {
    const ports = mergePorts(LEGACY_PORTS, explicit);
    assertUniquePorts(ports);
    return { ports, leaseDir: null, ownsLease: false };
  }

  mkdirSync(leaseRoot, { recursive: true });

  if (!hasCrossRoleCollision(LEGACY_PORTS, explicit)) {
    const legacyLeaseDir = join(leaseRoot, "legacy");
    if (tryClaimLease(legacyLeaseDir, runId, pid)) {
      const ports = mergePorts(LEGACY_PORTS, explicit);
      assertUniquePorts(ports);
      return { ports, leaseDir: legacyLeaseDir, ownsLease: true };
    }
  }

  const maxBase = DYNAMIC_PORT_MAX - DYNAMIC_PORT_STRIDE;
  for (let attempt = 0; attempt < MAX_DYNAMIC_ATTEMPTS; attempt++) {
    const slotCount = Math.floor(
      (maxBase - DYNAMIC_PORT_MIN) / DYNAMIC_PORT_STRIDE,
    );
    const base =
      DYNAMIC_PORT_MIN + randomInt(slotCount + 1) * DYNAMIC_PORT_STRIDE;
    const defaults = dynamicPortBlock(base);
    if (hasCrossRoleCollision(defaults, explicit)) continue;

    const leaseDir = join(leaseRoot, `block-${base}`);
    if (!tryClaimLease(leaseDir, runId, pid)) continue;

    const ports = mergePorts(defaults, explicit);
    assertUniquePorts(ports);
    return { ports, leaseDir, ownsLease: true };
  }

  throw new Error(
    `Unable to reserve an isolated Mock-LLM port block after ${MAX_DYNAMIC_ATTEMPTS} attempts.`,
  );
}

function addOwnedPath(
  ownedPaths: string[],
  explicitValue: string | undefined,
  path: string,
): void {
  if (!explicitValue?.trim()) ownedPaths.push(path);
}

export function applyMockLlmRunContext(
  context: MockLlmRunContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env.MOCK_LLM_RUN_ID = context.runId;
  env.MOCK_LLM_RUN_ROOT = context.paths.runRoot;
  env.MOCK_LLM_PORT_LEASE_DIR = context.leaseDir ?? "";

  for (const key of PORT_KEYS) {
    env[PORT_ENV[key]] = String(context.ports[key]);
  }

  env.MOCK_LLM_STATE_DIR = context.paths.stateDir;
  env.MOCK_LLM_AUTOMATION_DB_DIR = context.paths.automationDbDir;
  env.MOCK_LLM_SKILL_REPOS_HOST_DIR = context.paths.skillReposHostDir;
  env.MOCK_LLM_USER_SKILLS_HOST_DIR = context.paths.userSkillsHostDir;
  env.MOCK_LLM_FOLDER_WORKSPACE_HOST_DIR = context.paths.folderWorkspaceHostDir;
}

export function createMockLlmRunContext(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateRunContextOptions = {},
): MockLlmRunContext {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const pid = options.pid ?? process.pid;
  const runId = sanitizeRunId(
    env.MOCK_LLM_RUN_ID?.trim() || `${pid}-${randomBytes(6).toString("hex")}`,
  );
  const runRoot = resolve(
    env.MOCK_LLM_RUN_ROOT?.trim() ||
      join(workspaceRoot, ".tmp", "mock-llm-runs", runId),
  );
  const leaseRoot = resolve(
    options.leaseRoot ?? join(workspaceRoot, ".tmp", "mock-llm-port-leases"),
  );

  const stateOverride =
    env.MOCK_LLM_STATE_DIR?.trim() || env.OH_CANVAS_SAFE_STATE_DIR?.trim();
  const stateDir = resolve(stateOverride || join(runRoot, "state"));
  const automationOverride = env.MOCK_LLM_AUTOMATION_DB_DIR?.trim();
  const automationDbDir = resolve(
    automationOverride || join(dirname(stateDir), "automation"),
  );
  const skillReposOverride = env.MOCK_LLM_SKILL_REPOS_HOST_DIR?.trim();
  const skillReposHostDir = resolve(
    skillReposOverride || join(runRoot, "skill-repos"),
  );
  const userSkillsOverride = env.MOCK_LLM_USER_SKILLS_HOST_DIR?.trim();
  const userSkillsHostDir = resolve(
    userSkillsOverride || join(runRoot, "user-skills"),
  );
  const folderWorkspaceOverride =
    env.MOCK_LLM_FOLDER_WORKSPACE_HOST_DIR?.trim();
  const folderWorkspaceHostDir = resolve(
    folderWorkspaceOverride || join(runRoot, "folder-workspace"),
  );

  const ownedPaths: string[] = [];
  addOwnedPath(ownedPaths, stateOverride, stateDir);
  addOwnedPath(ownedPaths, automationOverride, automationDbDir);
  addOwnedPath(ownedPaths, skillReposOverride, skillReposHostDir);
  addOwnedPath(ownedPaths, userSkillsOverride, userSkillsHostDir);
  addOwnedPath(ownedPaths, folderWorkspaceOverride, folderWorkspaceHostDir);

  // Deterministic pre-cleaning: only paths this run owns are deleted. Explicit
  // overrides are never removed because callers may be intentionally
  // preserving them for debugging.
  for (const ownedPath of ownedPaths) {
    rmSync(ownedPath, { recursive: true, force: true });
    mkdirSync(ownedPath, { recursive: true });
  }

  const existingLease = env.MOCK_LLM_PORT_LEASE_DIR?.trim();
  let allocation: {
    ports: MockLlmPorts;
    leaseDir: string | null;
    ownsLease: boolean;
  };
  if (existingLease && PORT_KEYS.every((key) => env[PORT_ENV[key]]?.trim())) {
    const ports = {} as MockLlmPorts;
    for (const key of PORT_KEYS) {
      ports[key] = parsePort(env[PORT_ENV[key]], PORT_ENV[key])!;
    }
    assertUniquePorts(ports);
    allocation = { ports, leaseDir: existingLease, ownsLease: false };
  } else {
    allocation = allocatePorts(env, leaseRoot, runId, pid);
  }

  const context: MockLlmRunContext = {
    runId,
    ports: allocation.ports,
    paths: {
      runRoot,
      stateDir,
      automationDbDir,
      skillReposHostDir,
      userSkillsHostDir,
      folderWorkspaceHostDir,
    },
    leaseDir: allocation.leaseDir,
    ownedPaths,
    ownsLease: allocation.ownsLease,
  };

  applyMockLlmRunContext(context, env);
  return context;
}

export function scopedMockLlmArtifactPath(
  basePath: string,
  context: MockLlmRunContext,
): string {
  // Preserve the historical artifact paths for the one run that owns the
  // legacy port set so existing CI/report tooling remains compatible. Any
  // overlapping run gets a run-id suffix and cannot overwrite its reports
  // or completion markers.
  if (context.leaseDir && basename(context.leaseDir) === "legacy") {
    return basePath;
  }
  return `${basePath}-${context.runId}`;
}

export function cleanupMockLlmRunContext(context: MockLlmRunContext): void {
  for (const ownedPath of [...context.ownedPaths].reverse()) {
    rmSync(ownedPath, { recursive: true, force: true });
  }

  // Remove the generated run root if all of its owned children are gone.
  // force=true keeps cleanup idempotent after partial teardown.
  if (
    context.paths.runRoot.includes(
      `${join(".tmp", "mock-llm-runs")}${process.platform === "win32" ? "\\" : "/"}`,
    )
  ) {
    rmSync(context.paths.runRoot, { recursive: true, force: true });
  }

  if (context.ownsLease && context.leaseDir) {
    rmSync(context.leaseDir, { recursive: true, force: true });
  }
}

export function installMockLlmRunCleanup(context: MockLlmRunContext): void {
  if (!context.ownsLease) return;
  process.once("exit", () => cleanupMockLlmRunContext(context));
}
