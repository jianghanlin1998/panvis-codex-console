import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BigTaskPlanningIntakeSchema, PlannerResponseSchema, ProjectSchema } from "@codex-task-console/domain";
import { LivePlanningStore, openTaskDatabase } from "../src/index.js";
import { fixedClock, makeBigTask, makeProject } from "./fixtures.js";

/** A real four-task JSON shape, filled evenly with Unicode scope text to an exact byte boundary. */
export const sizedPlanningProposal = (byteLength: number) => {
  const keys = byteLength > 250_000 ? Array.from({ length: 20 }, (_, index) => `part_${index}`) : ["ui", "collector", "integration", "validation"];
  const tasks = keys.map(key => ({
    key, title: key, goal: `Complete ${key}`, scopeIn: [key], scopeOut: ["Deployment"],
    acceptanceCriteria: [`Verify ${key}`], untouchedAreas: [], promptSeed: `Implement ${key}`,
    profile: "HIGH_RISK_FOUNDATION", writeEnabled: true,
  }));
  const proposal = { outcome: "PROPOSE", questions: [], tasks,
    dependencies: tasks.slice(1).map((task, index) => ({ upstreamKey: tasks[index]!.key,
      downstreamKey: task.key, requiredGate: "ACCEPTED", reason: "Use the integrated predecessor." })),
  };
  for (let index = 0; ; index += 1) {
    const remaining = byteLength - Buffer.byteLength(JSON.stringify(proposal), "utf8");
    if (remaining < 0) throw new Error("Requested fixture size is too small.");
    if (remaining <= 12) { tasks[0]!.goal += "x".repeat(remaining); break; }
    const task = tasks[index % tasks.length]!;
    if (task.scopeIn.length >= 24) throw new Error("Requested fixture size exceeds field limits.");
    const prefix = `${index}:`;
    const fillBytes = Math.min(2_800, remaining - 3) - prefix.length;
    task.scopeIn.push(prefix + "你".repeat(Math.floor(fillBytes / 3)) + "x".repeat(fillBytes % 3));
  }
  return PlannerResponseSchema.parse(proposal);
};

export const makePlanningFixture = (clock: () => Date = fixedClock) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ctc-planning-test-"));
  const repository = join(root, "repository");
  mkdirSync(repository);
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: repository, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_DATE: "2026-09-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T00:00:00Z" },
  });
  git(["init", "-b", "main"]);
  writeFileSync(join(repository, "AGENTS.md"), "Respect the approved task boundary.\n", "utf8");
  git(["add", "AGENTS.md"]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Initial fixture"]);
  const databasePath = join(root, "tasks.sqlite");
  let storage = openTaskDatabase({ databasePath, clock });
  const project = ProjectSchema.parse({ ...makeProject("prj_live_plan", "live-plan"), repository: { kind: "PATH", path: repository } });
  storage.createProject(project);
  const intake = BigTaskPlanningIntakeSchema.parse({
    bigTask: makeBigTask("bt_live_plan", project.id), approved: true,
    productDecisions: ["Use real public AI news with links to original sources."], planningTokenLimit: 120_000,
    productDirection: { confirmed: true, summary: "A local board for meaningful AI technology progress.",
      successCriteria: ["Surface substantive research or technical advances with original evidence."], scopeBoundaries: ["No deployment or unrelated marketing feed aggregation."] },
    reviewIntensity: "STANDARD",
  });
  const proposal = {
    outcome: "PROPOSE", questions: [],
    tasks: ["collect", "board"].map((key) => ({ key, title: key, goal: `Implement ${key}`,
      scopeIn: [key], scopeOut: ["Deployment"], acceptanceCriteria: [`Verify ${key}`], untouchedAreas: [],
      promptSeed: `Complete ${key}`, profile: "STANDARD", writeEnabled: true,
    })),
    dependencies: [{ upstreamKey: "collect", downstreamKey: "board", requiredGate: "ACCEPTED", reason: "Board consumes collected articles." }],
  };
  return {
    root, repository, databasePath, intake, proposal, git,
    get storage() { return storage; },
    get planning() { return new LivePlanningStore(storage); },
    reopen() { storage.close(); storage = openTaskDatabase({ databasePath, clock }); },
    close() { if (storage.isOpen) storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
};
