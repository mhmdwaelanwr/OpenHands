// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupMockLlmRunContext,
  createMockLlmRunContext,
  type MockLlmRunContext,
} from "../../tests/e2e/mock-llm/run-isolation";

describe("mock-LLM run isolation", () => {
  const contexts: MockLlmRunContext[] = [];
  const roots: string[] = [];

  afterEach(() => {
    for (const context of contexts.splice(0)) {
      cleanupMockLlmRunContext(context);
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "mock-llm-isolation-"));
    roots.push(root);
    return root;
  }

  it("gives concurrent runs distinct state roots and reserved port sets", () => {
    const workspaceRoot = makeWorkspace();
    const leaseRoot = join(workspaceRoot, "leases");

    const first = createMockLlmRunContext(
      {},
      { workspaceRoot, leaseRoot, pid: process.pid },
    );
    contexts.push(first);
    const second = createMockLlmRunContext(
      {},
      { workspaceRoot, leaseRoot, pid: process.pid },
    );
    contexts.push(second);

    expect(first.paths.runRoot).not.toBe(second.paths.runRoot);
    expect(new Set(Object.values(first.ports)).size).toBe(7);
    expect(new Set(Object.values(second.ports)).size).toBe(7);

    const firstPorts = new Set(Object.values(first.ports));
    for (const port of Object.values(second.ports)) {
      expect(firstPorts.has(port)).toBe(false);
    }

    // The first run preserves the historical defaults; a concurrent run is
    // forced onto a separate leased block rather than sharing them.
    expect(first.ports.ingress).toBe(18300);
    expect(second.ports.ingress).not.toBe(18300);
  });

  it("keeps user-skill fixtures inside the run root by default", () => {
    const workspaceRoot = makeWorkspace();
    const context = createMockLlmRunContext(
      {},
      {
        workspaceRoot,
        leaseRoot: join(workspaceRoot, "leases"),
        pid: process.pid,
      },
    );
    contexts.push(context);

    expect(context.paths.userSkillsHostDir.startsWith(context.paths.runRoot)).toBe(
      true,
    );
    expect(context.paths.skillReposHostDir.startsWith(context.paths.runRoot)).toBe(
      true,
    );
    expect(existsSync(context.paths.userSkillsHostDir)).toBe(true);
  });

  it("preserves explicit port and state-directory overrides", () => {
    const workspaceRoot = makeWorkspace();
    const explicitState = join(workspaceRoot, "kept-state");
    mkdirSync(explicitState, { recursive: true });
    writeFileSync(join(explicitState, "sentinel"), "keep me");

    const context = createMockLlmRunContext(
      {
        MOCK_LLM_INGRESS_PORT: "25101",
        MOCK_LLM_PUBLIC_MODE_PORT: "25102",
        MOCK_LLM_PORT: "25103",
        MOCK_LLM_BACKEND_PORT: "25104",
        MOCK_LLM_AUTOMATION_PORT: "25105",
        MOCK_LLM_VITE_PORT: "25106",
        MOCK_LLM_VSCODE_PORT: "25107",
        OH_CANVAS_SAFE_STATE_DIR: explicitState,
      },
      {
        workspaceRoot,
        leaseRoot: join(workspaceRoot, "leases"),
        pid: process.pid,
      },
    );
    contexts.push(context);

    expect(context.ports).toEqual({
      mockLlm: 25103,
      ingress: 25101,
      publicMode: 25102,
      backend: 25104,
      automation: 25105,
      vite: 25106,
      vscode: 25107,
    });
    expect(context.paths.stateDir).toBe(explicitState);
    expect(readFileSync(join(explicitState, "sentinel"), "utf8")).toBe(
      "keep me",
    );
  });

  it("rejects explicit cross-service port collisions", () => {
    const workspaceRoot = makeWorkspace();

    expect(() =>
      createMockLlmRunContext(
        {
          MOCK_LLM_INGRESS_PORT: "25200",
          MOCK_LLM_BACKEND_PORT: "25200",
          MOCK_LLM_PORT: "25201",
          MOCK_LLM_PUBLIC_MODE_PORT: "25202",
          MOCK_LLM_AUTOMATION_PORT: "25203",
          MOCK_LLM_VITE_PORT: "25204",
          MOCK_LLM_VSCODE_PORT: "25205",
        },
        {
          workspaceRoot,
          leaseRoot: join(workspaceRoot, "leases"),
          pid: process.pid,
        },
      ),
    ).toThrow(/port collision/i);
  });

  it("reaps a stale legacy lease before reusing the historical defaults", () => {
    const workspaceRoot = makeWorkspace();
    const leaseRoot = join(workspaceRoot, "leases");
    const staleLease = join(leaseRoot, "legacy");
    mkdirSync(staleLease, { recursive: true });
    writeFileSync(
      join(staleLease, "owner.json"),
      JSON.stringify({ pid: 999_999_999, runId: "dead" }),
    );

    const context = createMockLlmRunContext(
      {},
      { workspaceRoot, leaseRoot, pid: process.pid },
    );
    contexts.push(context);

    expect(context.ports.ingress).toBe(18300);
    expect(context.leaseDir).toBe(staleLease);
  });
});
