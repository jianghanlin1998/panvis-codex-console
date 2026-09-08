import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderThreadReferenceSchema, ProviderRunReferenceSchema, ProviderModelReferenceSchema } from "@codex-task-console/domain";
import { BigTaskExecutionStore } from "../src/big-task-execution.js";
import { makePlanningFixture } from "./live-planning-fixture.js";
import { createWorktreeOwnershipManagerForTesting } from "../src/worktree-ownership.js";
import { createGovernedExecutionStoreForTest, getGovernedProviderBridge } from "../src/governed-execution-public.js";
import type { executeGovernedRoleCodex } from "../../codex-adapter/src/live-execution.js";
import { executeGovernedRoleCodexWithDependenciesForTest } from "../../codex-adapter/src/live-execution.js";
import { validateOwnedWorktreeHardlinkSafety } from "../../codex-adapter/src/worktree-filesystem-safety.js";
import { planningProviderFixture } from "../../codex-adapter/test/planning-provider-fixture.js";

export function makeExecutionFixture(clock?: () => Date, scenario?: (role: string, occurrence: number) => string | undefined, profile: "STANDARD" | "HIGH_RISK_FOUNDATION" = "HIGH_RISK_FOUNDATION") {
  let instant = Date.parse("2026-09-07T00:00:00.000Z");
  const now = clock ?? (() => new Date(instant++));
  const f = makePlanningFixture(now);
  f.git(["update-ref", "refs/remotes/origin/main", f.git(["rev-parse", "HEAD"]).toString().trim()]);
  f.git(["config", "branch.main.remote", "origin"]);
  f.git(["config", "branch.main.merge", "refs/heads/main"]);
  f.planning.accept(f.intake);
  const finish = (output: unknown) => {
    const claim = f.planning.claim(f.intake.bigTask.id);
    const threadId = `execution-plan-${claim.sequence}`;
    f.planning.observe(f.intake.bigTask.id, claim.sequence, {
      providerThread: ProviderThreadReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId }),
      providerRun: ProviderRunReferenceSchema.parse({ providerId: "codex-app-server", providerThreadId: threadId, providerRunId: `turn-${claim.sequence}` }),
      model: ProviderModelReferenceSchema.parse({ providerId: "codex-app-server", providerModelId: "fixture" }), normalizedUsage: { totalTokens: 100 },
    });
    f.planning.finish(f.intake.bigTask.id, claim.sequence, true, JSON.stringify(output));
  };
  f.proposal.tasks.forEach(task => { task.profile = profile; });
  finish(f.proposal);
  const bundle = f.storage.getDurablePlanningReviewBundle(f.intake.bigTask.id)!;
  finish({ outcome: "APPROVE", planRevision: bundle.reviewState.candidate.revision,
    candidateBinding: createHash("sha256").update(bundle.candidateBinding, "utf8").digest("hex"), revisionRequirements: [], questions: [] });
  const execution = new BigTaskExecutionStore(f.storage);
  const review = execution.review(f.intake.bigTask.id);
  const approval = { bigTaskId: review.bigTaskId, planDigest: review.planDigest, repositoryHeadSha: review.repositoryHeadSha,
    limits: { durationMilliseconds: 10_800_000, totalTokenLimit: 120_000, roleCallLimit: 16, repairCycleLimit: 1 as const } };
  let nextWorktree = 0;
  const manager = createWorktreeOwnershipManagerForTesting(f.storage, {
    worktreeRoot: join(f.root, "worktrees"), idGenerator: () => `wt_${(++nextWorktree).toString(16).padStart(32, "0")}`,
  });
  const governed = createGovernedExecutionStoreForTest(f.storage, manager);
  const decisions: unknown[] = [];
  const bridge = getGovernedProviderBridge(governed);
  const prepare = bridge.prepareNextRole.bind(bridge);
  bridge.prepareNextRole = (...args) => { const result = prepare(...args); decisions.push(result.kind === "ROLE_AUTHORIZED" ? { kind: result.kind, role: result.authorization.role } : result); return result; };
  const starts: string[] = [];
  const outcomes: Array<{ code: string | null; success: boolean }> = [];
  const provider = planningProviderFixture(() => f.proposal);
  const execute: typeof executeGovernedRoleCodex = async (handle, id, signal) => {
    const role = handle.getRoleAuthorization(id)!;
    const occurrence = starts.filter(prior => handle.getRoleAuthorization(prior)?.role === role.role).length + 1;
    const selected = scenario?.(role.role, occurrence);
    starts.push(id);
    const result = await executeGovernedRoleCodexWithDependenciesForTest(handle, id, {
      ...provider.dependencies, checkCompatibility: () => true, validateWorktreeFilesystem: validateOwnedWorktreeHardlinkSafety,
      generateChatThreadId: () => { throw new Error("Governed storage owns identifiers"); },
      generateExecutionRunId: () => { throw new Error("Governed storage owns identifiers"); },
      resolveOwnedWorktree: () => { throw new Error("Governed storage owns worktrees"); },
      ...(signal === undefined ? {} : { signal }),
      createWorkspace: () => { const path = mkdtempSync(join(realpathSync(tmpdir()), "ctc-governed-runtime-")); chmodSync(path, 0o700); return path; },
      removeWorkspace: path => rmSync(path, { recursive: true, force: true }),
      spawnAppServer: (_file, _args, options) => spawn(process.execPath,
        [fileURLToPath(new URL("../../../fixtures/mock-governed-app-server.ts", import.meta.url)), `--role=${role.role}`,
          `--occurrence=${id}`, "--write-candidate", ...(selected === undefined ? [] : [`--scenario=${selected}`]), ...(role.writeEnabled ? [] : ["--readonly-role"])], options),
    });
    outcomes.push({ code: result.failureCode, success: result.success });
    return result;
  };
  return { ...f, execution, approval, manager, governed, starts, outcomes, decisions, execute, get storage() { return f.storage; } };
}
