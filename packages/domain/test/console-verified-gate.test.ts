import { describe, expect, it } from "vitest";
import {
  BigTaskIdSchema, SubtaskDependencySchema, SubtaskIdSchema, evaluateSubtaskDependencyReadiness,
} from "../src/index.js";

describe("Console LIGHT verified dependency gate", () => {
  it.each(["NOT_STARTED", "IMPLEMENTED", "HARDENED", "ACCEPTED"] as const)("does not infer verification completion from %s maturity", maturity => {
    const bigTaskId = BigTaskIdSchema.parse("bt_console_gate");
    const upstream = { id: SubtaskIdSchema.parse("st_console_upstream"), bigTaskId, maturity };
    const downstream = { id: SubtaskIdSchema.parse("st_console_downstream"), bigTaskId, maturity: "NOT_STARTED" as const };
    const dependency = SubtaskDependencySchema.parse({ upstreamSubtaskId: upstream.id, downstreamSubtaskId: downstream.id,
      dependencyType: "BLOCKING", requiredGate: "VERIFIED", reason: "Consume only verified output" });
    for (const observation of [upstream, { ...upstream, verificationComplete: false }]) {
      expect(evaluateSubtaskDependencyReadiness([observation, downstream], [dependency], downstream.id)).toMatchObject({
        valid: true, ready: false, blockers: [{ upstreamSubtaskId: upstream.id, requiredGate: "VERIFIED", actualMaturity: maturity }],
      });
    }
    expect(evaluateSubtaskDependencyReadiness([{ ...upstream, verificationComplete: true }, downstream], [dependency], downstream.id))
      .toMatchObject({ valid: true, ready: true, blockers: [] });
  });

  it("keeps HARDENED and ACCEPTED gates independent of basic verification", () => {
    const bigTaskId = BigTaskIdSchema.parse("bt_console_stronger_gate");
    const upstream = { id: SubtaskIdSchema.parse("st_console_verified"), bigTaskId, maturity: "IMPLEMENTED" as const, verificationComplete: true };
    const downstream = { id: SubtaskIdSchema.parse("st_console_reviewed"), bigTaskId, maturity: "NOT_STARTED" as const };
    for (const requiredGate of ["HARDENED", "ACCEPTED"] as const) {
      const dependency = SubtaskDependencySchema.parse({ upstreamSubtaskId: upstream.id, downstreamSubtaskId: downstream.id,
        dependencyType: "BLOCKING", requiredGate, reason: "Require the stronger reviewed result" });
      expect(evaluateSubtaskDependencyReadiness([upstream, downstream], [dependency], downstream.id))
        .toMatchObject({ valid: true, ready: false, blockers: [{ requiredGate, actualMaturity: "IMPLEMENTED" }] });
    }
  });
});
