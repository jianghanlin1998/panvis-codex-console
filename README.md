# Codex Task Console

Codex Task Console is an independent, local-first internal development tool under development. It is not part of the Panvis product code and is not yet authorized as Hanlin's active operating workflow.

The completed foundation slices currently provide deterministic domain contracts, local embedded storage for Projects, Big Tasks, Subtasks, Task Dependencies, compact exact-scope Context Items with atomic supersession, one current Context Digest per exact scope, append-only Audit Events supplied explicitly by callers, version-specific mock coverage for a narrow Codex App Server protocol subset, and provider-neutral execution references with pure Codex mappings. Codex App Server remains the only V1 execution provider. These slices do not provide a working Console application, Context Engine, automatic digest generation or audit emission, or live App Server integration. No ChatGPT Project Instructions or Project Sources have been changed or activated.

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

Workspace packages are under `packages/`. Deliberate public APIs are exported by package entry points. See `docs/S0A_SCOPE.md`, `docs/S0B1_SCOPE.md`, `docs/S0B2A_CONTEXT_STORAGE.md`, `docs/S0B2B_DIGEST_AUDIT_STORAGE.md`, `docs/S0C_SCOPE.md`, and `docs/S0D_PROVIDER_NEUTRAL_EXECUTION.md` for the implemented boundaries.
