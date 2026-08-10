# Codex Task Console repository rules

- Keep this repository independent from Panvis product code and other repositories.
- Implement only the currently approved bounded slice; preserve public contracts unless the task changes them.
- Prefer deterministic, pure domain logic and network-free tests.
- Do not add storage, UI, Codex App Server, worktree, deployment, or ChatGPT Project Source integration without a later approved task.
- Before any Node-dependent command, source `scripts/runtime-preflight.sh` in the task shell and confirm `node` and `pnpm` meet the versions declared in `package.json`. Treat a missing direct runtime as an environment preflight condition, not a repository test failure.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before committing.
- Update `CURRENT_STATE.md` on completion of write-enabled tasks when operational state changes; keep it compact and evidence-based.
