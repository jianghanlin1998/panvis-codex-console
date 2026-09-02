# Codex Task Console repository rules

- Keep this repository independent from Panvis product code and other repositories.
- Implement only the currently approved bounded slice; preserve public contracts unless the task changes them.
- Prefer deterministic, pure domain logic and network-free tests.
- Do not add storage, UI, Codex App Server, worktree, deployment, or ChatGPT Project Source integration without a later approved task.
- After repository-truth checks and before Node-dependent work, source `scripts/dev-environment-preflight.sh` once from the repository root. It reuses the runtime preflight, validates the installed workspace offline, and fails closed without installing or refreshing dependencies.
- Use `scripts/run-repo-check.sh public|lint|typecheck|test|build` for canonical checks, then run `git diff --check` before committing. The canonical full test path uses four workers.
- Update `CURRENT_STATE.md` on completion of write-enabled tasks when operational state changes; keep it compact and evidence-based.
