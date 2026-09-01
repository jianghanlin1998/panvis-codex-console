# S0B1 scope

S0B1 adds the first local persistence layer for the accepted S0A task contracts. It remains foundation code, not an operational Console.

## Implemented

- `projects`, `big_tasks`, `subtasks`, and `task_dependencies` SQLite tables;
- Drizzle schema definitions and one repository-local generated migration;
- explicit foreign keys with `RESTRICT` deletes, enum checks, uniqueness constraints, and parent/dependency indexes;
- fresh-database migration, recorded migration state, and idempotent reopen behavior;
- explicit file-backed or in-memory database open/close lifecycle with foreign keys enabled;
- Project create, ID/slug lookup, and deterministic list methods;
- Big Task create, ID lookup, and deterministic Project-scoped list methods;
- Subtask create, ID lookup, and deterministic Big-Task-scoped list methods;
- atomic validated dependency replacement and deterministic Big-Task-scoped dependency lists;
- a narrow synchronous transaction callback;
- typed sanitized storage errors.

The selected driver is Node.js 24's built-in `node:sqlite` `DatabaseSync`, integrated through `drizzle-orm/node-sqlite`. It supports file and `:memory:` databases without a database server, cloud dependency, or additional native-driver package. In the verified Node.js 24.14.0 runtime, Node still reports the SQLite module as experimental; that platform caveat must be revisited during later runtime hardening.

Structured string-array fields use compact JSON arrays. Writes clone and encode validated S0A values; reads decode and validate the reconstructed entity through the corresponding S0A Zod schema. Malformed data produces a typed sanitized error rather than a JSON or driver error.

Canonical durable identifiers cross this boundary only after Domain validation as well-formed Unicode. TaskStorage preserves each accepted JavaScript string exactly across write/read and close/reopen; it does not normalize valid Unicode. The stricter validation requires no schema migration and does not rewrite, normalize, or reinterpret existing stored identifiers.

## Deferred

Context Items, Context Digests, Context Packets, audit events, Decision/Roadmap Packets, provisioning batches, FTS5, artifacts, Handoffs, Promoted Context, execution/usage/approval/worktree records, lifecycle mutations, task scheduling, App Server integration, daemon/API work, UI, native-subagent execution, and deployment remain unimplemented.

The next bounded storage or control-plane task may rely on the exported schema, migrated core tables, deterministic task reads, atomic dependency replacement, transaction behavior, and stable storage error codes. It must preserve the S0A state-machine ownership of lifecycle decisions.
