# S0A scope

S0A establishes the independent pnpm/TypeScript repository and the deterministic contracts that later Codex Task Console slices may safely import:

- branded Project, Big Task, Subtask, chat-thread, execution-run, and context-item identifiers;
- the two-level durable Big Task/Subtask hierarchy beneath a Project;
- context kinds, statuses, authorities, and provenance;
- deterministic Subtask dependency and transition validation;
- native-subagent ownership and usage-attribution boundaries;
- the immutable V1 context and usage budget policy with validation.

Later slices may depend on the package exports and stable validation result codes. S0A does not implement an operational Console.

All free-form canonical durable identifiers accepted by the Domain boundary must be well-formed Unicode strings. Unpaired UTF-16 surrogates are invalid, while valid Unicode (including supplementary characters) remains supported. Identifier validation does not perform Unicode normalization, and distinct valid Unicode code-point sequences remain distinct identities. Persistence layers must preserve every accepted canonical identifier exactly.

S0B1 now builds a separate core task-storage layer on these contracts; see `S0B1_SCOPE.md`. Remaining deferred work includes non-task storage entities, search, artifacts, Project Source integration, Decision/Roadmap provisioning, prompt compilation and other Context Compiler behavior, real Codex/App Server integration, execution and usage enforcement, Git worktrees, browser UI, native-subagent execution, and deployment. No current ChatGPT Project Instructions or Sources are modified by this repository.
