# Codex Task Console repository rules

- Keep this repository independent from Panvis product code and other repositories.
- Implement only the currently approved bounded slice; preserve public contracts unless the task changes them.
- Prefer deterministic, pure domain logic and network-free tests.
- Do not add storage, UI, Codex App Server, worktree, deployment, or ChatGPT Project Source integration without a later approved task.
- After repository-truth checks and before Node-dependent work, source `scripts/dev-environment-preflight.sh` once from the repository root. It reuses the runtime preflight, validates the installed workspace offline, and fails closed without installing or refreshing dependencies.
- Run `pnpm public:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check` before committing. The pinned workspace settings prevent automatic dependency repair, and the canonical full test script uses four workers.
- Update `CURRENT_STATE.md` on completion of write-enabled tasks when operational state changes; keep it compact and evidence-based.

## Hanlin's product-direction and approval policy

- Before new product work or a material change of direction, align with Hanlin in plain language on the desired result, useful examples, success criteria, non-goals and consequential assumptions. A list of tools, feeds or providers is not product-direction confirmation. Do not silently replace broad product intent with a convenient implementation.
- Once direction and execution scope are approved, proceed with ordinary tools, existing-provider calls, implementation, engineering review and permitted repairs without repeating permission questions. Ask again only for a real product decision or a material change of scope, cost/time limit, data use or authority.
- Review depth is adjustable to task difficulty. Independent QA and an optional deeper hardening sweep are engineering checks; they are not separate conversational approval gates. Preserve the current task's approved contract when changing defaults for future work.
- Distinguish engineering completion, product acceptance and human-directed closeout. If Hanlin waives a check or defers product changes, retain the waiver and unresolved findings; never label an unperformed check PASS or a direction mismatch accepted.
