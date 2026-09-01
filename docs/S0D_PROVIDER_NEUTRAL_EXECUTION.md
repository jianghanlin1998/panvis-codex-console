# S0D provider-neutral execution contracts

S0D establishes a narrow provider boundary before execution persistence and live runtime integration. Core task, context, lifecycle, and future storage code use the provider-neutral contracts exported by `packages/domain`; they do not use Codex protocol names or depend on `packages/codex-adapter`.

## Core contract

- An execution provider has a bounded, stable slug ID rather than a vendor enum.
- A descriptor records a bounded display name, an optional runtime version, and a validated, unique, canonically ordered capability set.
- Provider thread, run, and model references keep the provider ID separate from opaque provider-owned IDs. These durable provider-owned IDs must be well-formed Unicode; unpaired UTF-16 surrogates are invalid, valid Unicode remains supported, and no Unicode normalization is performed. A provider run belongs to one provider thread without importing a provider-specific term such as Codex turn.
- Normalized usage can record input, cached-input, output, reasoning, and total tokens plus runtime seconds and tool-call count when reported. Unsupported fields remain absent. Cached-input tokens are part of input tokens, and reasoning tokens are part of output tokens, so total-token validation uses input plus output and does not add those subsets again.
- Provider-specific metadata is omitted. The core schemas are strict and expose no authentication, raw prompt, reasoning, transcript, billing, or arbitrary JSON extension field.

Console `ChatThreadId` and `ExecutionRunId` remain internal durable identifiers. Provider references identify external runtime objects and must not replace those Console identities. S0D does not aggregate usage; native-subagent usage remains attributable to its owning Subtask through the existing native-subagent ownership contract.

## V1 Codex boundary

Codex App Server remains the only V1 execution provider. `packages/codex-adapter` owns the provider ID `codex-app-server`, the exact S0C-tested runtime version, App Server method names and fixtures, and pure mappings from Codex thread, turn, and token-usage values into the core references.

The static descriptor claims only S0C-covered persistent threads, thread resume, streaming, interruption, approval requests, usage updates, and Skills. It does not claim review or native-subagent execution. The existing experimental exclusions remain excluded, and the exact-version compatibility check remains fail-closed.

## Dependency and future use

The dependency direction is `codex-adapter -> domain`; `domain` has no runtime dependency on the adapter. S0D adds no runtime process, filesystem, network, authentication, model call, storage migration, provider selection, routing, or discovery behavior.

Future providers must implement the same narrow references, usage semantics, and capability vocabulary without changing core task semantics. This boundary exists to avoid a future core-schema rewrite, not to expand V1 or claim multi-provider support. Claude Code and all other providers remain out of scope.
