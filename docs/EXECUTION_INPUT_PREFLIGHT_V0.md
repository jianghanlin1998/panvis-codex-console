# Execution Input Preflight V0

Execution Input Preflight V0 is the provider-neutral trusted path from a
canonical Subtask ID and supported Operational Context profile to exact
Console-owned context text and a deterministic byte-budget decision:

```text
TaskStorage
-> OperationalJitContextAssembler
-> accepted JitContextPacket
-> deterministic serialization
-> exact UTF-8 byte measurement
-> fixed budget decision
```

Callers cannot supply the packet, serialized text, byte count, budget policy,
Project, repository evidence, Context Items, or QA policy. A same-shaped packet
or preflight result constructed by a caller remains ordinary DATA and gains no
execution authority.

## Exact serialization and measurement

The format ID is `CTC_JIT_CONTEXT_JSON_V0`. The complete serialized text is the
fixed marker `CODEX_TASK_CONSOLE_JIT_CONTEXT_V0`, one newline, and immediately
`JSON.stringify(packet)`. There is no indentation, replacer, trailing newline,
caller-controlled wrapper, or additional hidden Console context.

The measurement is `Buffer.byteLength(text, "utf8")` over that exact final text.
The result is a UTF-8 byte count, not a token count or token estimate. Provider-
reported actual token usage remains separate post-start usage and accounting
truth.

## Fixed V0 decision

- At or below 40,000 bytes: `WITHIN_TARGET`, allowed with text.
- From 40,001 through 64,000 bytes: `ABOVE_TARGET`, allowed with text.
- Above 64,000 bytes: `HARD_CAP_EXCEEDED`, blocked with no text in the result.

The preflight never truncates, prunes, summarizes, retries with mutated context,
or accepts a caller override. The budget covers only the exact Console-owned
serialized context text; it does not claim to measure provider context, tools,
thread history, protocol envelopes, or provider-side serialization.

## Future provider binding

A future provider adapter must pass the approved text unchanged as the Console
context text input. Any adapter change or additional Console-owned framing must
return the final modified text through deterministic byte measurement before
execution. The adapter may not append unmeasured Console context after
preflight.

Live Codex execution remains disabled until the installed Codex version is
revalidated against the repository compatibility contract.
