# Codex Task Console

Codex Task Console is an independent, local-first internal development tool under development. It is not part of the Panvis product code and is not yet authorized as Hanlin's active operating workflow.

The completed foundation slices currently provide deterministic domain contracts and local embedded storage for Projects, Big Tasks, Subtasks, and Task Dependencies. They do not provide a working Console application. No ChatGPT Project Instructions or Project Sources have been changed or activated.

## Development

Prerequisites: Node.js 24 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Workspace packages are under `packages/`. Deliberate public APIs are exported by the domain and storage package entry points. See `docs/S0A_SCOPE.md` and `docs/S0B1_SCOPE.md` for the implemented boundaries.
