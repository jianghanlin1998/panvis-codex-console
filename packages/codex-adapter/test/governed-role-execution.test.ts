import { createGovernedExecutionStoreForTest as createGovernedExecutionStore } from "../../storage/src/governed-execution-public.js";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ChatThreadIdSchema, ExecutionProviderIdSchema, ExecutionRunIdSchema, ProviderThreadReferenceSchema, ProviderRunReferenceSchema,
  BigTaskIdSchema,
  ProjectIdSchema,
  ProjectSchema,
  SubtaskIdSchema,
  TaskContractV0Schema,
} from "@codex-task-console/domain";
import {
  openTaskDatabase,
} from "@codex-task-console/storage";
import type {
  GovernedExecutionStore,
  GovernedPreparationResult,
  TaskStorage,
} from "@codex-task-console/storage";
import { createWorktreeOwnershipManagerForTesting } from "../../storage/src/worktree-ownership.js";
import {
  executeGovernedRoleCodexWithDependenciesForTest,
} from "../src/live-execution.js";
import { validateOwnedWorktreeHardlinkSafety } from "../src/worktree-filesystem-safety.js";
import { TESTED_CODEX_VERSION } from "../src/index.js";

const MOCK_PATH = fileURLToPath(
  new URL("../../../fixtures/mock-governed-app-server.ts", import.meta.url),
);
const BIG_TASK_ID = BigTaskIdSchema.parse("bt_governed_adapter");
const SUBTASK_ID = SubtaskIdSchema.parse("st_governed_adapter");
const PROJECT_ID = ProjectIdSchema.parse("prj_governed_adapter");

type Dependencies = Parameters<
  typeof executeGovernedRoleCodexWithDependenciesForTest
>[2];

interface Fixture {
  readonly directory: string;
  readonly storage: TaskStorage;
  readonly governed: GovernedExecutionStore;
}

const git = (path: string, arguments_: readonly string[]): string =>
  execFileSync("git", ["-C", path, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Governed Adapter",
      GIT_AUTHOR_EMAIL: "adapter@example.invalid",
      GIT_COMMITTER_NAME: "Governed Adapter",
      GIT_COMMITTER_EMAIL: "adapter@example.invalid",
    },
  }).trim();

const createFixture = (
  profile: "LOW" | "STANDARD" | "HIGH_RISK_FOUNDATION" = "LOW",
): Fixture => {
  const directory = realpathSync.native(
    mkdtempSync(join(tmpdir(), "ctc-governed-adapter-")),
  );
  const repositoryPath = join(directory, "source");
  execFileSync("git", ["init", "--initial-branch", "main", repositoryPath]);
  writeFileSync(join(repositoryPath, "AGENTS.md"), "Keep it bounded.\n", {
    encoding: "utf8",
  });
  git(repositoryPath, ["add", "--all"]);
  git(repositoryPath, ["commit", "--message", "fixture"]);
  git(repositoryPath, [
    "update-ref",
    "refs/remotes/origin/main",
    git(repositoryPath, ["rev-parse", "HEAD"]),
  ]);
  git(repositoryPath, ["config", "branch.main.remote", "origin"]);
  git(repositoryPath, ["config", "branch.main.merge", "refs/heads/main"]);

  let timestamp = Date.parse("2026-09-04T00:00:00.000Z");
  const storage = openTaskDatabase({
    databasePath: join(directory, "console.sqlite"),
    clock: () => new Date((timestamp += 1_000)),
  });
  storage.createProject(
    ProjectSchema.parse({
      recordType: "PROJECT",
      id: PROJECT_ID,
      name: "Governed Adapter",
      slug: "governed-adapter",
      repository: { kind: "PATH", path: repositoryPath },
      defaultBranch: "main",
      maxActiveCodingSubtasks: 2,
    }),
  );
  storage.createBigTask({
    recordType: "BIG_TASK",
    id: BIG_TASK_ID,
    projectId: PROJECT_ID,
    title: "Governed adapter",
    goal: "Run exact roles",
    rationale: "Protocol coverage",
    scopeIn: ["Mock App Server"],
    scopeOut: ["Network"],
    acceptanceCriteria: ["Structured result persists"],
    status: "IN_PROGRESS",
  });
  const plan: Parameters<TaskStorage["beginDurablePlanningBundle"]>[0] = {
    kind: "PLAN_CANDIDATE",
    projectId: PROJECT_ID,
    bigTaskId: BIG_TASK_ID,
    revision: 1,
    subtasks: [
      {
        id: SUBTASK_ID,
        bigTaskId: BIG_TASK_ID,
        profile,
        taskContractRef: "contract/governed-adapter",
        writeEnabled: true,
      },
    ],
    dependencies: [],
  };
  const bundle = storage.beginDurablePlanningBundle(plan, [
    TaskContractV0Schema.parse({
      taskContractRef: "contract/governed-adapter",
      projectId: PROJECT_ID,
      bigTaskId: BIG_TASK_ID,
      subtaskId: SUBTASK_ID,
      title: "Governed adapter",
      goal: "Run exact roles",
      scopeIn: ["Mock App Server"],
      scopeOut: ["Network"],
      acceptanceCriteria: ["Structured result persists"],
      untouchedAreas: ["Source checkout"],
      promptSeed: "Return the exact governed JSON result.",
      startPolicy: "WHEN_READY",
      delegationPolicy: "NONE",
      recommendedReasoningLevel: "HIGH",
    }),
  ]);
  storage.recordDurableReviewerDecision(BIG_TASK_ID, {
    outcome: "APPROVE",
    planRevision: 1,
    candidateBinding: bundle.reviewState.candidateBinding,
  });
  storage.materializeDurablePlan(BIG_TASK_ID);
  storage.materializeApprovedCanonicalTasks(BIG_TASK_ID);
  storage.initializeDurableSubtaskWorkflows(BIG_TASK_ID);
  const manager = createWorktreeOwnershipManagerForTesting(storage, {
    worktreeRoot: join(directory, "worktrees"),
    idGenerator: () => `wt_${"a".repeat(32)}`,
  });
  manager.provisionOwnedWorktreeForSubtask(SUBTASK_ID);
  return {
    directory,
    storage,
    governed: createGovernedExecutionStore(storage, manager),
  };
};

const cleanup = (fixture: Fixture): void => {
  fixture.storage.close();
  rmSync(fixture.directory, { force: true, recursive: true });
};

const authorization = (
  result: GovernedPreparationResult,
): Extract<GovernedPreparationResult, { readonly kind: "ROLE_AUTHORIZED" }> => {
  expect(result.kind).toBe("ROLE_AUTHORIZED");
  return result as Extract<
    GovernedPreparationResult,
    { readonly kind: "ROLE_AUTHORIZED" }
  >;
};

const dependencies = (
  role: string,
  malformed = false,
  scenario?: string,
): Dependencies => ({
  checkCompatibility: () => true,
  resolveRuntime: () => ({
    canonicalExecutablePath: "/owned/codex/bin/codex",
    exactVersionOutput: TESTED_CODEX_VERSION,
    executable: true,
    readable: true,
    releaseVersion: "0.148.0-alpha.9",
    source: "OWNED_RELEASE",
    target: "aarch64-apple-darwin",
  }),
  resolveOwnedWorktree: () => {
    throw new Error("legacy resolver must not own governed authority");
  },
  generateChatThreadId: () => {
    throw new Error("governed storage owns thread IDs");
  },
  generateExecutionRunId: () => {
    throw new Error("governed storage owns run IDs");
  },
  validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
  spawnAppServer: (_executable, _arguments_, options) =>
    spawn(
      process.execPath,
      [MOCK_PATH, `--role=${role}`, ...(malformed ? ["--malformed"] : []), ...(scenario ? [`--scenario=${scenario}`] : [])],
      options,
    ),
  sourceEnvironment: { LANG: "en_US.UTF-8" },
  normalHomeDirectory: "/fixture/home",
  createWorkspace: () => {
    const path = mkdtempSync(join(realpathSync(tmpdir()), "ctc-governed-runtime-"));
    chmodSync(path, 0o700);
    return path;
  },
  removeWorkspace: (path) => rmSync(path, { force: true, recursive: true }),
  limits: {
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    turnIdleTimeoutMs: 2_000,
    turnAbsoluteTimeoutMs: 5_000,
    interruptTimeoutMs: 500,
    shutdownGraceMs: 500,
    terminateGraceMs: 500,
    maxJsonlLineBytes: 256 * 1_024,
    maxPendingRequests: 8,
    maxNotifications: 64,
    maxAgentResponseBytes: 16 * 1_024,
    maxStderrBytes: 128,
  },
});

describe("governed Codex role execution", () => {
  it("runs write and read roles with exact candidate policies and no transcript output", async () => {
    const fixture = createFixture();
    try {
      const execute = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const executeResult = await executeGovernedRoleCodexWithDependenciesForTest(
        fixture.governed,
        execute.authorization.authorizationId,
        dependencies("EXECUTE"),
      );
      expect(executeResult.success, JSON.stringify(executeResult)).toBe(true);
      expect(executeResult).toMatchObject({
        success: true,
        failureCode: null,
        threadPolicy: {
          cwd: "TRUSTED_ACTIVE_OWNED_WORKTREE",
          sandbox: "workspaceWrite",
          writableRootCount: 1,
          networkAccess: false,
        },
        roleResult: { role: "EXECUTE", outcome: "READY" },
        reconciliation: { kind: "TRANSITION_RECORDED", currentStage: "VERIFY" },
      });
      expect(executeResult).not.toHaveProperty("agentResponseText");

      const verify = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const verifyResult = await executeGovernedRoleCodexWithDependenciesForTest(
        fixture.governed,
        verify.authorization.authorizationId,
        dependencies("VERIFY"),
      );
      expect(verifyResult.success, JSON.stringify(verifyResult)).toBe(true);
      expect(verifyResult).toMatchObject({
        success: true,
        threadPolicy: {
          sandbox: "readOnly",
          writableRootCount: 0,
          networkAccess: false,
        },
        roleResult: { role: "VERIFY", outcome: "PASS" },
        reconciliation: { currentStage: "COMPLETE" },
      });
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID).kind).toBe(
        "BIG_TASK_COMPLETE",
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("fails malformed provider output without persisting a successful result", async () => {
    const fixture = createFixture();
    try {
      const execute = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const result = await executeGovernedRoleCodexWithDependenciesForTest(
        fixture.governed,
        execute.authorization.authorizationId,
        dependencies("EXECUTE", true),
      );
      expect(result).toMatchObject({
        success: false,
        failureCode: "STRUCTURED_RESULT_INVALID",
        roleResult: null,
      });
      expect(
        fixture.storage.getExecutionRunById(result.executionRunId!),
      ).toMatchObject({ status: "FAILED", normalizedUsage: { totalTokens: 18 } });
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({
        kind: "BLOCKED",
        reason: "PROVIDER_ROLE_FAILED",
      });
    } finally {
      cleanup(fixture);
    }
  });

  it("binds HIGH_RISK hardening and fresh QA to write/read policies", async () => {
    const fixture = createFixture("HIGH_RISK_FOUNDATION");
    try {
      for (const expected of [
        ["EXECUTE", "workspaceWrite", "STANDARD_SUBTASK_EXECUTION"],
        ["HARDEN", "workspaceWrite", "STANDARD_SUBTASK_EXECUTION"],
        ["FRESH_QA", "readOnly", "FRESH_INDEPENDENT_QA"],
      ] as const) {
        const prepared = authorization(
          fixture.governed.prepareNextRole(BIG_TASK_ID),
        );
        expect(prepared.authorization.role).toBe(expected[0]);
        const result = await executeGovernedRoleCodexWithDependenciesForTest(
          fixture.governed,
          prepared.authorization.authorizationId,
          dependencies(expected[0]),
        );
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(result.threadPolicy?.sandbox).toBe(expected[1]);
        expect(result.preflight?.profile).toBe(expected[2]);
      }
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID).kind).toBe(
        "BIG_TASK_COMPLETE",
      );
    } finally {
      cleanup(fixture);
    }
  });
});

describe("Step 8D governed provider hardening", () => {
  it.each([
    "malformed-initialization", "wrong-cwd", "wrong-sandbox", "approval-request",
    "duplicate-item", "wrong-thread", "wrong-turn", "post-terminal", "duplicate-key",
    "wrong-fields", "wrong-outcome", "oversized", "malformed-unicode", "missing-usage", "process-exit",
  ])("rejects synthetic protocol/result scenario %s with no semantic retry", async scenario => {
    const fixture = createFixture();
    try {
      const prepared = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const result = await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,
        prepared.authorization.authorizationId, dependencies("EXECUTE", false, scenario));
      expect(result.success, scenario).toBe(false);
      expect(result.roleResult).toBeNull();
      expect(result.appServerChildCleaned).toBe(true);
      expect(result.transientRuntimeCleaned).toBe(true);
      expect(fixture.storage.getSubtaskById(SUBTASK_ID)?.maturity).toBe("NOT_STARTED");
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({kind:"BLOCKED",reason:"PROVIDER_ROLE_FAILED"});
    } finally { cleanup(fixture); }
  });

  it("runs every role in the bounded batch-repair path through a distinct mock App Server", async () => {
    const fixture = createFixture("HIGH_RISK_FOUNDATION");
    try {
      const seenThreads = new Set(); const seenRuns = new Set();
      for (const role of ["EXECUTE", "HARDEN", "FRESH_QA", "REPAIR", "FOCUSED_RE_QA"]) {
        const prepared = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
        expect(prepared.authorization.role).toBe(role);
        const result = await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,
          prepared.authorization.authorizationId, dependencies(role, false, role === "FRESH_QA" ? "two-blockers" : undefined));
        expect(result.success, JSON.stringify(result)).toBe(true);
        expect(seenThreads.has(result.chatThreadId)).toBe(false); seenThreads.add(result.chatThreadId);
        expect(seenRuns.has(result.executionRunId)).toBe(false); seenRuns.add(result.executionRunId);
        expect(result.threadPolicy?.sandbox).toBe(["FRESH_QA", "FOCUSED_RE_QA"].includes(role) ? "readOnly" : "workspaceWrite");
        expect(result.threadPolicy?.networkAccess).toBe(false);
      }
      expect(seenThreads.size).toBe(5);
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BIG_TASK_COMPLETE");
    } finally { cleanup(fixture); }
  }, 20_000);

  it("rejects a write-tool lifecycle in a read-only VERIFY turn", async () => {
    const fixture = createFixture();
    try {
      const execute = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      expect((await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,
        execute.authorization.authorizationId, dependencies("EXECUTE"))).success).toBe(true);
      const verify = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const result = await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,
        verify.authorization.authorizationId, dependencies("VERIFY", false, "read-write-tool"));
      expect(result.success).toBe(false);
      expect(result.roleResult).toBeNull();
      expect(fixture.storage.getSubtaskById(SUBTASK_ID)?.status).toBe("QA_DEBUG");
    } finally { cleanup(fixture); }
  });

  it("does not persist success when transient-runtime cleanup fails", async () => {
    const fixture = createFixture();
    let retained: string | undefined;
    try {
      const prepared = authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const deps = dependencies("EXECUTE");
      const result = await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,
        prepared.authorization.authorizationId, {...deps, removeWorkspace: path => { retained = path; throw new Error("synthetic cleanup failure"); }});
      expect(result.success).toBe(false);
      expect(result.roleResult).toBeNull();
      expect(result.failureCode).toBe("WORKSPACE_CLEANUP_FAILED");
      expect(result.transientRuntimeCleaned).toBe(false);
    } finally { if (retained) rmSync(retained, {recursive:true,force:true}); cleanup(fixture); }
  });
});


describe("Step 8D mock execution ownership and liveness", () => {
  it.each([1,4])("rejects unsafe hardlinks at governed filesystem gate %i", async gate => {
    const fixture=createFixture();let scans=0;let spawns=0;
    try {
      const prepared=authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));
      const deps=dependencies("EXECUTE");
      const result=await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,prepared.authorization.authorizationId,{
        ...deps,
        spawnAppServer:(...args)=>{spawns++;return deps.spawnAppServer(...args);},
        validateWorktreeFilesystem:path=>{
          scans++;
          if(scans===gate)linkSync(join(path,"AGENTS.md"),join(fixture.directory,"outside-hardlink"));
          validateOwnedWorktreeHardlinkSafety(path);
        },
      });
      expect(result.success).toBe(false);expect(result.roleResult).toBeNull();
      expect(scans).toBe(gate);expect(spawns).toBe(gate===1?0:1);
      expect(fixture.storage.getSubtaskById(SUBTASK_ID)?.maturity).toBe("NOT_STARTED");
    } finally {cleanup(fixture);}
  });

  it("permits exactly one mock provider claimant for concurrent identical role requests",async()=>{
    const fixture=createFixture();let spawns=0;
    try {
      const prepared=authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));const deps=dependencies("EXECUTE");
      const counted={...deps,spawnAppServer:(...args:Parameters<Dependencies["spawnAppServer"]>)=>{spawns++;return deps.spawnAppServer(...args);}};
      const results=await Promise.all([0,1].map(()=>executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,prepared.authorization.authorizationId,counted)));
      expect(results.filter(r=>r.success)).toHaveLength(1);expect(spawns).toBe(1);
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID)).toMatchObject({kind:"ROLE_AUTHORIZED",authorization:{role:"VERIFY"}});
    }finally{cleanup(fixture);}
  });

  it("bounds a silent mock turn with one interrupt and no semantic retry",async()=>{
    const fixture=createFixture();let spawns=0;
    try {
      const prepared=authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));const deps=dependencies("EXECUTE",false,"timeout");
      const result=await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,prepared.authorization.authorizationId,{
        ...deps,spawnAppServer:(...args)=>{spawns++;return deps.spawnAppServer(...args);},
      });
      expect(result.success).toBe(false);expect(result.roleResult).toBeNull();expect(spawns).toBe(1);
      expect(result.appServerChildCleaned).toBe(true);expect(result.transientRuntimeCleaned).toBe(true);
      expect(fixture.governed.prepareNextRole(BIG_TASK_ID).kind).toBe("BLOCKED");
    }finally{cleanup(fixture);}
  },10_000);
});


describe("Step 8D final provider-start freshness",()=>{
  it.each(["spawn","pre-turn"])("rejects changed canonical context at %s",async timing=>{
    const fixture=createFixture();let scans=0;let turns=0;
    try {
      const prepared=authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));const deps=dependencies("EXECUTE");
      const change=()=>{const db=new DatabaseSync(join(fixture.directory,"console.sqlite"));db.exec("UPDATE projects SET name = 'Changed canonical Project'");db.close();};
      const result=await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,prepared.authorization.authorizationId,{
        ...deps,
        spawnAppServer:(...args)=>{
          if(timing==="spawn") change();
          const child=deps.spawnAppServer(...args);
          const write=child.stdin.write.bind(child.stdin);
          child.stdin.write=((...parts:Parameters<typeof child.stdin.write>)=>{
            if(String(parts[0]).includes('"method":"turn/start"')) turns++;
            return write(...parts);
          }) as typeof child.stdin.write;
          return child;
        },
        validateWorktreeFilesystem:path=>{deps.validateWorktreeFilesystem?.(path);if(++scans===3&&timing==="pre-turn") change();},
      });
      expect(result.success).toBe(false);expect(result.roleResult).toBeNull();expect(turns).toBe(0);
    }finally{cleanup(fixture);}
  });
});


describe("Step 8D provider-start aggregate budget timing",()=>{
  it.each([
    {total:119_999,extend:false,allowed:true},
    {total:120_000,extend:false,allowed:false},
    {total:120_000,extend:true,allowed:true},
    {total:160_000,extend:false,allowed:false},
    {total:null,extend:false,allowed:false},
  ])("rechecks $total usage after provider setup (extension $extend)",async({total,extend,allowed})=>{
    const fixture=createFixture();let scans=0;let turns=0;
    try{
      const providerId=ExecutionProviderIdSchema.parse("codex-app-server");
      const chatThreadId=ChatThreadIdSchema.parse("thr_adapter_budget");
      const executionRunId=ExecutionRunIdSchema.parse("run_adapter_budget");
      const providerThread=ProviderThreadReferenceSchema.parse({providerId,providerThreadId:"provider-budget-history"});
      fixture.storage.createChatThread({id:chatThreadId,subtaskId:SUBTASK_ID,providerId});
      fixture.storage.bindChatThreadProviderReference({chatThreadId,providerThread});
      fixture.storage.createExecutionRun({id:executionRunId,chatThreadId});
      fixture.storage.startExecutionRun({executionRunId,providerRun:ProviderRunReferenceSchema.parse({...providerThread,providerRunId:"provider-budget-run"})});
      fixture.storage.finalizePrimaryExecutionAttempt({executionRunId,status:"SUCCEEDED",normalizedUsage:{inputTokens:1,cachedInputTokens:0,outputTokens:0,reasoningTokens:0,totalTokens:1}});
      const prepared=authorization(fixture.governed.prepareNextRole(BIG_TASK_ID));const deps=dependencies("EXECUTE");
      const result=await executeGovernedRoleCodexWithDependenciesForTest(fixture.governed,prepared.authorization.authorizationId,{
        ...deps,
        spawnAppServer:(...args)=>{
          const child=deps.spawnAppServer(...args);const write=child.stdin.write.bind(child.stdin);
          child.stdin.write=((...parts:Parameters<typeof child.stdin.write>)=>{if(String(parts[0]).includes('"method":"turn/start"'))turns++;return write(...parts);}) as typeof child.stdin.write;
          return child;
        },
        validateWorktreeFilesystem:path=>{
          deps.validateWorktreeFilesystem?.(path);
          if(++scans!==3)return;
          const db=new DatabaseSync(join(fixture.directory,"console.sqlite"));
          const guards=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name='execution_runs'").all();
          for(const guard of guards)db.exec(`DROP TRIGGER "${guard.name}"`);
          db.exec(total===null?"UPDATE execution_runs SET usage_present=0,input_tokens=NULL,cached_input_tokens=NULL,output_tokens=NULL,reasoning_tokens=NULL,total_tokens=NULL WHERE id='run_adapter_budget'":`UPDATE execution_runs SET input_tokens=${total},total_tokens=${total} WHERE id='run_adapter_budget'`);
          for(const guard of guards)db.exec(String(guard.sql));db.close();
          if(extend)fixture.governed.authorizeOneTimeBudgetExtension(SUBTASK_ID);
        },
      });
      expect(result.success).toBe(allowed);expect(turns).toBe(allowed?1:0);
      if(!allowed){expect(result.roleResult).toBeNull();expect(fixture.storage.listExecutionRunsForChatThread(result.chatThreadId!).map(run=>run.status)).toEqual(["FAILED"]);}
    }finally{cleanup(fixture);}
  });
});
