# Codex Task Console repository rules

- Keep this repository independent from Panvis product code and other repositories.
- Implement only the currently approved bounded slice; preserve public contracts unless the task changes them.
- Prefer deterministic, pure domain logic and network-free tests.
- Do not add storage, UI, Codex App Server, worktree, deployment, or ChatGPT Project Source integration without a later approved task.
- Before Node-dependent commands, source `scripts/runtime-preflight.sh`; it may recover a compatible bundled runtime for the task shell when direct Node is missing. Do not stop for missing direct Node or a pnpm patch that differs from the preferred baseline while remaining in the supported `package.json` range; stop only if preflight fails after safe recovery. `package.json` defines the supported runtime contract.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before committing.
- Update `CURRENT_STATE.md` on completion of write-enabled tasks when operational state changes; keep it compact and evidence-based.
