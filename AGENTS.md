# Codex Task Console repository rules

- Keep this repository independent from Panvis product code and other repositories.
- Implement only the currently approved bounded slice; preserve public contracts unless the task changes them.
- Prefer deterministic, pure domain logic and network-free tests.
- Do not add storage, UI, Codex App Server, worktree, deployment, or ChatGPT Project Source integration without a later approved task.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before committing.
