import { compileOperationalPacket, readOperationalSources } from "./operational-context-assembly.js";
import { serializeOperationalPacket } from "./execution-input-preflight.js";
import type { RepositoryCommitSha, SubtaskId } from "@codex-task-console/domain";
import type { TaskStorage } from "./task-storage.js";
import { TrustedRepositorySourceReader } from "./trusted-repository-source.js";

// Internal composition receives exact durable target rows from governed storage.
// It deliberately uses the accepted FOCUSED_RE_QA compiler and storage profile.
export function compileGovernedFocusedContext(
  storage: TaskStorage,
  subtaskId: SubtaskId,
  targets: readonly Readonly<{
    findingId: string;
    sourceResultId: string;
    violatedInvariant: string;
    affectedContract: string;
    repairedSha: RepositoryCommitSha;
  }>[],
) {
  const {sharedInput} = readOperationalSources(storage, new TrustedRepositorySourceReader(storage), subtaskId, "FOCUSED_RE_QA");
  const packet = compileOperationalPacket({
    profile: "FOCUSED_RE_QA",
    ...sharedInput,
    lockedInvariants: [],
    qaInstructions: [{
      sourceReference: "system:governed-execution#focused-re-qa",
      title: "Focused Re-QA",
      body: "Retest the exact bounded repaired finding batch against canonical contract and acceptance criteria. Use the candidate SHA and owned worktree in the governed input. Exclude builder, hardener and repair reasoning, prior Handoffs, self-assessments, Active Context, Digest, raw history and unrelated Promoted Context. Report remaining target blockers and any new bounded blocker in the repaired surface. Do not write or repair.",
    }],
    boundedRetestTargets: targets.map(target => ({
      sourceReference: `governed-finding:${target.sourceResultId}:${target.findingId}`,
      retestTarget: {
        findingId: target.findingId,
        violatedInvariant: target.violatedInvariant,
        affectedContract: target.affectedContract,
        repairedSha: target.repairedSha,
      },
    })),
  });
  return serializeOperationalPacket(packet, "FOCUSED_RE_QA");
}
