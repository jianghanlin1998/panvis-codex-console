import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

import { openTaskDatabase } from "@codex-task-console/storage";
import { ensureProductionStateDirectories, localControlPathsForTesting, writeSessionDescriptor } from "../dist/state.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const daemonEntrypoint = join(
  repositoryRoot,
  "packages/local-control/dist/daemon-cli.js",
);
const operatorEntrypoint = join(
  repositoryRoot,
  "packages/local-control/dist/operator-cli.js",
);

assert.equal(existsSync(daemonEntrypoint), true, "build the daemon before E2E");
assert.equal(existsSync(operatorEntrypoint), true, "build the operator before E2E");

const fixtureRoot = realpathSync.native(
  mkdtempSync(join(tmpdir(), "ctc-local-executable-e2e-")),
);
const fixtureHome = join(fixtureRoot, "home");
const sourceRepository = join(fixtureRoot, "source");
const applicationRoot = join(
  fixtureHome,
  "Library",
  "Application Support",
  "Codex Task Console",
);
const stateDirectory = join(applicationRoot, "state");
const operatorDirectory = join(applicationRoot, "operator");
const databasePath = join(stateDirectory, "console.sqlite3");
const sessionPath = join(operatorDirectory, "current-session.json");
const lockPath = join(operatorDirectory, "daemon.lock");
const childEnvironment = {
  ...process.env,
  HOME: fixtureHome,
  LC_ALL: "C",
};
const children = new Set();

const runGit = (arguments_) => {
  const result = spawnSync("git", arguments_, {
    cwd: sourceRepository,
    encoding: "utf-8",
    env: childEnvironment,
    timeout: 10_000,
  });
  assert.equal(result.status, 0, "synthetic Git fixture failed");
};

const waitWithTimeout = async (promise, label, milliseconds = 10_000) => {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
};

const spawnDaemon = () => {
  const child = spawn(process.execPath, [daemonEntrypoint], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const lineEnd = stdout.indexOf("\n");
    if (lineEnd >= 0) {
      try {
        const line = stdout.slice(0, lineEnd);
        const parsed = JSON.parse(line);
        if (parsed.ready === true) {
          resolveReady({ child, line, parsed });
        }
      } catch (error) {
        rejectReady(error);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("exit", (code) => {
    children.delete(child);
    rejectReady(new Error(`daemon exited before readiness with ${code}: ${stderr}`));
  });
  return {
    child,
    ready,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const waitForExit = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return [child.exitCode, child.signalCode];
  }
  return waitWithTimeout(once(child, "exit"), "daemon exit");
};

const runOperator = (arguments_, expectedStatus) => {
  const result = spawnSync(process.execPath, [operatorEntrypoint, ...arguments_], {
    cwd: repositoryRoot,
    encoding: "utf-8",
    env: childEnvironment,
    timeout: 30_000,
  });
  assert.equal(result.status, expectedStatus, `operator ${arguments_[0]} exit status`);
  assert.equal(result.stderr, "", `operator ${arguments_[0]} stderr`);
  const parsed = JSON.parse(result.stdout);
  const sessionToken = JSON.parse(
    readFileSync(sessionPath, { encoding: "utf-8" }),
  ).sessionToken;
  assert.equal(result.stdout.includes(sessionToken), false, "operator leaked token");
  return parsed;
};

const runIsolatedOperator = async (arguments_, reply, expectedStatus, expectedBody, expectedError) => {
  const mockHome = mkdtempSync(join(fixtureRoot, "operator-mock-home-"));
  const paths = localControlPathsForTesting(join(mockHome, "Library", "Application Support", "Codex Task Console"));
  ensureProductionStateDirectories(paths);
  const token = "f".repeat(64);
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    request.resume();
    reply(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  writeSessionDescriptor(paths, { schemaVersion: 1, instanceId: `inst_${"f".repeat(32)}`, pid: 88,
    port: server.address().port, startedAt: "2026-09-07T00:00:00.000Z", sessionToken: token });
  try {
    const child = spawn(process.execPath, [operatorEntrypoint, ...arguments_], {
      cwd: repositoryRoot, env: { ...childEnvironment, HOME: mockHome }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf-8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf-8").on("data", chunk => { stderr += chunk; });
    const [status, signal] = await waitWithTimeout(once(child, "close"), "isolated operator exit");
    assert.equal(signal, null);
    assert.equal(status, expectedStatus);
    assert.equal((stdout + stderr).includes(token), false, "operator reflected session authority");
    assert.equal(requests, expectedStatus === 2 ? 0 : 1, "operator must never retry");
    if (expectedError === undefined) {
      assert.equal(stderr, "");
      assert.deepEqual(JSON.parse(stdout), expectedBody);
    } else {
      assert.equal(stdout, "");
      assert.deepEqual(JSON.parse(stderr), { error: { code: expectedError } });
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
};

try {
  mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRepository, { mode: 0o700 });
  runGit(["init", "-b", "main"]);
  writeFileSync(join(sourceRepository, "README.md"), "synthetic executable E2E\n", {
    encoding: "utf-8",
  });
  runGit(["add", "README.md"]);
  runGit([
    "-c",
    "user.name=Codex Task Console Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic fixture",
  ]);

  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(fixtureHome, 0o700);
  chmodSync(join(fixtureHome, "Library"), 0o700);
  chmodSync(join(fixtureHome, "Library", "Application Support"), 0o700);
  chmodSync(applicationRoot, 0o700);
  chmodSync(stateDirectory, 0o700);
  writeFileSync(databasePath, "", { mode: 0o600 });
  const storage = openTaskDatabase({ databasePath });
  storage.createProject({
    recordType: "PROJECT",
    id: "prj_executable_e2e",
    name: "Executable E2E",
    slug: "executable-e2e",
    repository: { kind: "PATH", path: sourceRepository },
    defaultBranch: "main",
    maxActiveCodingSubtasks: 2,
  });
  storage.createBigTask({
    recordType: "BIG_TASK",
    id: "bt_executable_e2e",
    projectId: "prj_executable_e2e",
    title: "Executable E2E",
    goal: "Exercise the exact local-control entrypoints",
    rationale: "Synthetic deterministic hardening",
    scopeIn: ["local control"],
    scopeOut: ["provider turns"],
    acceptanceCriteria: ["bounded executable path passes"],
    status: "IN_PROGRESS",
  });
  storage.createSubtask({
    recordType: "SUBTASK",
    id: "st_executable_e2e",
    bigTaskId: "bt_executable_e2e",
    title: "Executable E2E Subtask",
    goal: "Exercise daemon and operator",
    scopeIn: ["synthetic worktree"],
    scopeOut: ["provider turns"],
    acceptanceCriteria: ["provision inspect release"],
    untouchedAreas: [],
    status: "IN_PROGRESS",
    maturity: "NOT_STARTED",
    startPolicy: "MANUAL",
    delegationPolicy: "NONE",
    recommendedReasoningLevel: "LOW",
    promptSeed: "private synthetic prompt",
  });
  // A separate owned planning graph exercises the real governed HTTP routes
  // without ever making a role eligible for a provider attempt.
  const governedBigTaskId = "bt_executable_governed";
  const governedSubtaskId = "st_executable_governed";
  storage.createBigTask({
    recordType: "BIG_TASK", id: governedBigTaskId, projectId: "prj_executable_e2e",
    title: "Governed executable E2E", goal: "Inspect explicit manual authority",
    rationale: "Verify operator transport", scopeIn: ["synthetic operator routes"],
    scopeOut: ["provider turns"], acceptanceCriteria: ["manual authority is explicit"], status: "IN_PROGRESS",
  });
  storage.beginDurablePlanningBundle({
    kind: "PLAN_CANDIDATE", projectId: "prj_executable_e2e", bigTaskId: governedBigTaskId, revision: 1,
    subtasks: [{ id: governedSubtaskId, bigTaskId: governedBigTaskId, profile: "STANDARD",
      taskContractRef: "contract/executable-governed/v1", writeEnabled: true }], dependencies: [],
  }, [{
    taskContractRef: "contract/executable-governed/v1", projectId: "prj_executable_e2e",
    bigTaskId: governedBigTaskId, subtaskId: governedSubtaskId, title: "Synthetic governed task",
    goal: "Verify operator transport", scopeIn: ["synthetic operator routes"], scopeOut: ["provider turns"],
    acceptanceCriteria: ["manual authority is explicit"], untouchedAreas: ["real targets"],
    promptSeed: "Synthetic fixture only", startPolicy: "MANUAL", delegationPolicy: "NONE", recommendedReasoningLevel: "LOW",
  }]);
  const bundle = storage.getDurablePlanningReviewBundle(governedBigTaskId);
  storage.recordDurableReviewerDecision(governedBigTaskId, { outcome: "APPROVE", planRevision: 1, candidateBinding: bundle.candidateBinding });
  storage.materializeDurablePlan(governedBigTaskId);
  storage.materializeApprovedCanonicalTasks(governedBigTaskId);
  storage.initializeDurableSubtaskWorkflows(governedBigTaskId);
  storage.close();

  const first = spawnDaemon();
  const second = spawnDaemon();
  const winnerReady = await waitWithTimeout(
    Promise.any([first.ready, second.ready]),
    "racing daemon readiness",
  );
  const winner = winnerReady.child === first.child ? first : second;
  const loser = winner === first ? second : first;
  await waitForExit(loser.child);
  assert.equal(loser.child.exitCode, 1, "racing daemon loser exit status");
  assert.match(loser.stderr(), /DAEMON_ALREADY_RUNNING/u);
  assert.equal(winnerReady.line.includes("sessionToken"), false);
  assert.equal(winnerReady.line.includes("e".repeat(64)), false);
  assert.equal(lstatSync(sessionPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(lockPath).mode & 0o777, 0o600);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);

  assert.deepEqual(runOperator(["ping"], 0), { ok: true, schemaVersion: 1 });
  const governedBefore = runOperator(["governed-status", governedBigTaskId], 0);
  assert.equal(governedBefore.status, "IN_PROGRESS");
  assert.equal(governedBefore.dispatchReceipts.length, 0);
  const human = runOperator(["governed-advance", governedBigTaskId], 1);
  assert.equal(human.prepared.kind, "HUMAN_REQUIRED");
  assert.equal(human.prepared.reason, "MANUAL_START_REQUIRED");
  assert.equal(human.execution, null);
  const manual = runOperator(["governed-manual-start", governedSubtaskId], 0);
  assert.equal(manual.subtaskId, governedSubtaskId);
  const refusedExtension = runOperator(["governed-budget-extension", governedSubtaskId], 1);
  assert.equal(refusedExtension.error.code, "OPERATION_CONFLICT");
  const governedAfter = runOperator(["governed-status", governedBigTaskId], 0);
  assert.equal(governedAfter.dispatchReceipts.length, 0, "manual start must not dispatch");
  assert.equal(governedAfter.budgets[0].extensionApplied, false, "early extension must not grant budget");
  const untouched = runOperator(["status", governedSubtaskId], 0);
  assert.equal(untouched.durableExecution.chatThreadCount, 0, "no implicit provider execution");
  assert.equal(untouched.worktree, null, "no implicit provisioning");
  const initial = runOperator(["status", "st_executable_e2e"], 0);
  assert.equal(initial.worktree, null);
  const provisioned = runOperator(["provision", "st_executable_e2e"], 0);
  assert.equal(provisioned.worktree.status, "ACTIVE");
  assert.equal("worktreePath" in provisioned.worktree, false);
  const active = runOperator(["status", "st_executable_e2e"], 0);
  assert.equal(active.worktree.status, "ACTIVE");
  assert.equal(active.worktree.activeAuthorityVerified, true);
  const released = runOperator(["release", "st_executable_e2e"], 0);
  assert.equal(released.worktree.status, "RELEASED");
  const preProviderFailure = runOperator(["run", "st_executable_e2e"], 1);
  assert.equal(preProviderFailure.execution.success, false);
  assert.equal(
    preProviderFailure.execution.failureCode,
    "ACTIVE_WORKTREE_REQUIRED",
  );
  assert.equal(preProviderFailure.execution.providerThreadId, null);
  assert.equal(preProviderFailure.execution.providerRunId, null);

  winner.child.kill("SIGTERM");
  await waitForExit(winner.child);
  assert.equal(existsSync(sessionPath), false, "SIGTERM session cleanup");
  assert.equal(existsSync(lockPath), false, "SIGTERM lock cleanup");

  const restarted = spawnDaemon();
  await waitWithTimeout(restarted.ready, "restart readiness");
  assert.deepEqual(runOperator(["ping"], 0), { ok: true, schemaVersion: 1 });
  restarted.child.kill("SIGINT");
  await waitForExit(restarted.child);
  assert.equal(existsSync(sessionPath), false, "SIGINT session cleanup");
  assert.equal(existsSync(lockPath), false, "SIGINT lock cleanup");

  const owner = { projectId: "prj_executable", bigTaskId: "bt_executable", subtaskId: "st_executable",
    planRevision: 1, candidateBinding: "candidate-审阅-🚀" };
  const stamp = "2026-09-07T00:00:00.000Z";
  const commandCases = [
    { args: ["governed-status", owner.bigTaskId], body: { bigTaskId: owner.bigTaskId, status: "IN_PROGRESS",
      candidateBinding: null, workflows: [], budgets: [], dispatchReceipts: [] } },
    { args: ["governed-advance", owner.bigTaskId], body: { prepared: { kind: "BIG_TASK_COMPLETE",
      bigTaskId: owner.bigTaskId, completionReceiptId: "completion-🚀" }, execution: null } },
    { args: ["governed-manual-start", owner.subtaskId], body: { ...owner, authorityId: "manual-🚀", workflowSequence: 0, authorizedAt: stamp } },
    { args: ["governed-budget-extension", owner.subtaskId], body: { ...owner, authorityId: "budget-🚀", grantedTokens: 40_000, authorizedAt: stamp } },
  ];
  const jsonReply = body => response => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
  for (const { args, body } of commandCases) {
    await runIsolatedOperator(args, jsonReply(body), 0, body);
    await runIsolatedOperator([...args, "--auto"], jsonReply(body), 2, undefined, "INVALID_COMMAND");
    await runIsolatedOperator(args, jsonReply({ ...body, unexpected: true }), 1, undefined, "RESPONSE_MALFORMED");
  }
  const stopped = { prepared: { kind: "BLOCKED", reason: "NO_ELIGIBLE_ACTION", subtaskId: null }, execution: null };
  await runIsolatedOperator(["governed-advance", owner.bigTaskId], jsonReply(stopped), 1, stopped);
  for (const header of ["content-type", "content-length"]) {
    await runIsolatedOperator(["governed-advance", owner.bigTaskId], response => {
      response.setHeader("content-type", header === "content-type" ? "text/plain" : "application/json");
      if (header === "content-length") response.setHeader("content-length", String(1024 * 1024 + 1));
      response.flushHeaders(); // deliberately never end: the operator must close its socket and exit
    }, 1, undefined, header === "content-type" ? "RESPONSE_MALFORMED" : "RESPONSE_TOO_LARGE");
  }

  process.stdout.write(
    `${JSON.stringify({
      executableE2E: "PASS",
      daemonRace: "PASS",
      governedCommands: "PASS",
      governedExitAndCleanup: "PASS",
      signals: ["SIGTERM", "SIGINT"],
      providerModelTurns: 0,
      realTargetWrites: 0,
    })}\n`,
  );
} finally {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  rmSync(fixtureRoot, { recursive: true, force: true });
}
