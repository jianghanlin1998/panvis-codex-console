import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BigTaskPlanningIntakeSchema, ProjectSchema } from "@codex-task-console/domain";
import { LivePlanningStore, openTaskDatabase } from "../src/index.js";
import { fixedClock, makeBigTask, makeProject } from "./fixtures.js";

export const makePlanningFixture = () => {
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
  let storage = openTaskDatabase({ databasePath, clock: fixedClock });
  const project = ProjectSchema.parse({ ...makeProject("prj_live_plan", "live-plan"), repository: { kind: "PATH", path: repository } });
  storage.createProject(project);
  const intake = BigTaskPlanningIntakeSchema.parse({
    bigTask: makeBigTask("bt_live_plan", project.id), approved: true,
    productDecisions: ["Use real public AI news with links to original sources."], planningTokenLimit: 120_000,
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
    reopen() { storage.close(); storage = openTaskDatabase({ databasePath, clock: fixedClock }); },
    close() { if (storage.isOpen) storage.close(); rmSync(root, { recursive: true, force: true }); },
  };
};
