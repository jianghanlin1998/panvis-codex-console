# S0C scope

S0C establishes version-aware protocol test fixtures and an explicit repository Skill. It does not implement or run a production App Server client.

## Validated protocol boundary

S0C was checked on 2026-08-09 against installed `codex-cli 0.147.0-alpha.6.5`, the installed CLI's default generated TypeScript and JSON Schema bundles, and the official OpenAI Codex documentation for App Server, Skills, subagents, and configuration.

The fixture contract covers:

- `initialize` followed by `initialized`;
- `thread/start`, `thread/resume`, `thread/goal/set`, and `thread/goal/get`;
- `turn/start` and `turn/interrupt`;
- `skills/list` and explicit `skill` input items;
- thread, turn, item, agent-message delta, token-usage, completion, and request-resolution events;
- command-execution and file-change approval requests.

Compatibility is exact-version and fail-closed: an untested Codex version requires revalidation. Generated bundles are intentionally not checked in. `pnpm codex:schema:generate -- <absolute-output-path>` invokes both installed generators without `--experimental`, permits only an operating-system temporary descendant or the ignored repository `.codex-schema` path, and returns sanitized typed errors if the CLI is absent or a generator fails.

The installed CLI labels the `app-server` command and schema-generator commands experimental, and the official documentation says WebSocket App Server transport is experimental and unsupported for production workloads. S0C does not claim production App Server support. Its stable subset means only current default-schema methods that are not documented as experimental; the overall App Server version caveat remains mandatory for later integration.

## Mock fixtures

`fixtures/mock-app-server` provides a deterministic Node child process over stdio JSONL, a bounded test harness, and small transcripts. Scenarios cover initialization errors, thread start and resume, goal state, skill listing, ordered message streaming, fixed token usage, accepted and declined command and file approvals, interruption, sanitized failure, malformed JSON, missing and mismatched IDs, unknown methods, and disconnect with a pending approval.

The mock writes protocol JSONL only to stdout and diagnostics only to stderr. It does not use network access, credentials, Codex, arbitrary shell execution, or repository writes. Fixture paths are confined to the fake `/fixture/workspace` namespace.

## Task-execution Skill

The instruction-only Skill is stored at `.agents/skills/task-execution/SKILL.md`. Its `agents/openai.yaml` metadata sets `policy.allow_implicit_invocation: false`; future execution turns must invoke `$task-execution` explicitly and should also provide the App Server `skill` input item. The Skill was initialized, reviewed, and validated with the built-in `skill-creator` workflow.

## Explicit exclusions and next dependency

Experimental `dynamicTools`, `process/spawn`, paginated-thread creation, permission profiles, and unrelated protocol surfaces are excluded. Live App Server transport, authentication, model requests, real threads and turns, approval UI, native-subagent execution, global multi-agent configuration, Context Compiler behavior, persistent execution state, UI, daemon, worktrees, scheduling, and deployment remain deferred.

S3 may rely on the supported-method constants, minimal message and usage types, exact-version compatibility assessment, deterministic mock scenarios, request-ID correlation harness, schema-generation command builder, and explicit repository Skill. S3 must still revalidate its installed Codex version and design the live adapter, security boundary, lifecycle, and operational behavior as separately approved work.
