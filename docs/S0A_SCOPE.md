# S0A scope

S0A establishes the independent pnpm/TypeScript repository and the deterministic contracts that later Codex Task Console slices may safely import:

- branded Project, Big Task, Subtask, chat-thread, execution-run, and context-item identifiers;
- the two-level durable Big Task/Subtask hierarchy beneath a Project;
- context kinds, statuses, authorities, and provenance;
- deterministic Subtask dependency and transition validation;
- native-subagent ownership and usage-attribution boundaries;
- the immutable V1 context and usage budget policy with validation.

Later slices may depend on the package exports and stable validation result codes. S0A does not implement an operational Console.

Deferred work includes Project Source integration, Decision/Roadmap provisioning, prompt compilation and other Context Compiler behavior, storage and databases, real Codex/App Server integration, execution and usage enforcement, Git worktrees, browser UI, native-subagent execution, and deployment. No current ChatGPT Project Instructions or Sources are modified by this repository.
