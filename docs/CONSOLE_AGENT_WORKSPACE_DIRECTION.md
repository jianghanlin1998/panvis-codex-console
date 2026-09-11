# Console agent workspace direction

Hanlin confirmed this direction on 2026-09-11: Console chat should have Codex-like working capabilities, with tighter task context and adjustable supervision, supported by agents across the workflow. This is the target design, not a claim that capability parity has already shipped.

## One working conversation

Project chat coordinates the project. Big-task chat coordinates its children. Subtask chat investigates, implements and repairs that subtask. Each uses the same persisted operation services as the corresponding buttons. A successful model reply is not a successful operation: display the actual operation result, current work and next available action.

Approved work proceeds without repeated conversational gates. Read-only investigation may happen before implementation approval. If a requested change has material scope, cost, time or data-use consequences, present the concrete change in the current conversation. Once confirmed, apply it there. Avoid forcing users through a new draft, a different page and a second confirmation for the same decision.

## Capabilities, context and authority

Use the supported Codex App Server and Codex-managed ChatGPT login. Never borrow Panvis API credentials, read auth tokens or build undocumented authentication requests. The desktop app's tools are not automatically inherited by another App Server client.

Track and verify capabilities separately: repository read/write, terminal, public search and page reading, image input/viewing, browser interaction, Git, configured skills/connectors, and task/agent control. Show available, unconfigured or restricted with a specific remedy. Load integrations only for their intended project/account; broad capability is not permission to access unrelated data. Model and reasoning choices come from the installed runtime's supported catalog.

The chat coordinator dispatches approved work to the execution lane; QA has its own context and does not alter the implementation candidate. All lanes receive current goals, owner decisions, relevant files, dependencies, unresolved findings and actual capability settings. Older prose restrictions cannot silently override later owner adjustments. Preserve full history and retrieve relevant detail on demand rather than appending every old transcript to every call.

## Collaboration and recovery

Implementation, optional hardening and independent QA are roles in one visible task. Independent children may run concurrently when dependencies and write scopes allow. Users see who is doing what, current phase, last real activity and completed deliverables. A lack of events is uncertainty, not proof of continued progress.

Distinguish provider interruption, missing usage, unavailable capability, failed result receipt and formal QA failure. Technical recovery must not consume or fabricate QA outcomes. Missing usage remains unknown; measurement mode does not block solely on an unknown count. Hard limits selected by the owner show their source, effect and an adjustment action at the point of interruption. Suggested defaults avoid requiring users to guess token counts.

Each stop must expose: what happened, which task/step, what work is preserved, and an executable next action in both chat and UI. Retry with changed settings, repair, revise QA allowance, pause and end remain discoverable. Preserve failed findings when the owner changes the allowance. Scope-local recovery must not silently resume siblings or change parent-wide authority.

## Delivery order and acceptance

1. Complete the active Board Codex-login recovery with its approved time and remaining QA allowance; preserve old candidates and findings.
2. Unify task controls and chat actions, including scoped subtask recovery and in-place owner adjustments. Test each action through both entry points and after restart.
3. Add verified capability inventory and fill missing tool adapters, then visible coordinator/implementation/QA activity and dependency-aware concurrency. Each new adapter needs supported-protocol evidence and a real bounded capability check before being labeled available.

Acceptance examples: “允许这个任务联网并继续” applies the setting and resumes; “修订 B，再做一次 QA” preserves old findings and runs only the confirmed scope; a provider timeout offers a working retry without resetting QA; a missing browser tool explains setup rather than returning an unverifiable PASS. Existing deterministic regression checks still apply.
