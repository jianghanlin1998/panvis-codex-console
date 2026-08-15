# Codex Task Console

Codex Task Console is an independent, local-first internal development tool under development. It is not part of the Panvis product code and is not yet authorized as Hanlin's active operating workflow.

The completed foundation slices currently provide deterministic domain contracts, local embedded storage for Projects, Big Tasks, Subtasks with explicit maturity, Task Dependencies with explicit gates and reasons, pure dependency-readiness evaluation, a scope-local storage-backed readiness snapshot read, one atomic initial implementation-completion transition with immutable commit checkpoint evidence, compact exact-scope Context Items with atomic supersession, one current Context Digest per exact scope, append-only Audit Events supplied explicitly by callers, one pure default-deny raw context-scope access boundary, one storage-backed snapshot that retrieves raw Context Items only from an allowed target's Project, parent Big Task, and own Subtask scopes, one ACTIVE-only view derived from that validated raw snapshot, one pure clean-context QA profile that can only narrow already-allowed metadata candidates before future retrieval, one pure promoted-conclusion route-eligibility contract limited to a Subtask's own parent or an exact downstream dependency, one hardened strict Promoted Context candidate contract bound to that route policy, and one pure policy declaring the future acceptance authority required by an eligible candidate. Version-specific mock coverage exists for a narrow Codex App Server protocol subset, alongside provider-neutral execution references with pure Codex mappings. Codex App Server remains the only V1 execution provider. These slices do not provide a working Console application, general lifecycle or maturity mutation, start or repair orchestration, scheduling, context conflict resolution, actual Promoted Context acceptance, evidence validation, persistence, search, prompt compilation, automatic digest generation or audit emission, or live App Server integration. No ChatGPT Project Instructions or Project Sources have been changed or activated.

## Development

Prerequisites: Node.js 24 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

To verify the installed Codex protocol generators without starting App Server, provide an explicit temporary or ignored output path:

```sh
pnpm codex:schema:generate -- /absolute/temporary/path
```

Workspace packages are under `packages/`. Deliberate public APIs are exported by package entry points. See `docs/S0A_SCOPE.md`, `docs/S0B1_SCOPE.md`, `docs/S0B2A_CONTEXT_STORAGE.md`, `docs/S0B2B_DIGEST_AUDIT_STORAGE.md`, `docs/S0C_SCOPE.md`, `docs/S0D_PROVIDER_NEUTRAL_EXECUTION.md`, `docs/S1A_MATURITY_DEPENDENCY_READINESS.md`, `docs/S1B1_PERSISTED_READINESS_SNAPSHOT.md`, `docs/S1B2A_IMPLEMENTATION_COMPLETION.md`, `docs/S2A_CONTEXT_SCOPE_ACL.md`, `docs/S2B1_ALLOWED_RAW_CONTEXT_RETRIEVAL.md`, `docs/S2B2_ACTIVE_CONTEXT_SELECTION.md`, `docs/S2C1_QA_CLEAN_CONTEXT_PROFILE.md`, `docs/S2D1_PROMOTED_CONTEXT_ROUTE_ELIGIBILITY.md`, `docs/S2D2_PROMOTED_CONTEXT_CANDIDATE.md`, and `docs/S2D3_PROMOTED_CONTEXT_ACCEPTANCE_AUTHORITY.md` for the implemented boundaries.
