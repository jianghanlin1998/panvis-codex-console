import { createHash } from "node:crypto";
import { ConsoleAssetSchema, ConsoleScopeSchema, ProjectIdSchema } from "@codex-task-console/domain";
import type { ConsoleScope } from "@codex-task-console/domain";
import type { TaskStorage } from "./task-storage.js";
import { getTaskStorageWorktreeAccess } from "./task-storage-internals.js";
import { TaskStorageError } from "./errors.js";

export class ConsoleContextEntries {
  constructor(private readonly storage: TaskStorage) {}
  private get access() { return getTaskStorageWorktreeAccess(this.storage)!; }
  put(projectId: string, scope: ConsoleScope, id: string, kind: "NOTE" | "ASSET" | "SUMMARY" | "LINK", payload: object) {
    ProjectIdSchema.parse(projectId); ConsoleScopeSchema.parse(scope);
    if (!this.storage.getProjectById(ProjectIdSchema.parse(projectId))) throw new TaskStorageError("PARENT_NOT_FOUND", "Project unavailable.");
    this.access.sqlite.prepare("INSERT INTO console_context_entries (id, project_id, scope_key, kind, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload WHERE console_context_entries.project_id = excluded.project_id AND console_context_entries.scope_key = excluded.scope_key AND console_context_entries.kind = excluded.kind")
      .run(id, projectId, `${scope.kind}:${scope.id}`, kind, JSON.stringify(payload));
    return payload;
  }
  list(projectId: string, scopes: readonly ConsoleScope[], kind?: string): { id: string; kind: string; payload: Record<string, unknown> }[] {
    if (!scopes.length) return [];
    return this.access.sqlite.prepare(`SELECT id, kind, payload FROM console_context_entries WHERE project_id = ? AND scope_key IN (${scopes.map(() => "?").join(",")})${kind ? " AND kind = ?" : ""} ORDER BY rowid`)
      .all(projectId, ...scopes.map(scope => `${scope.kind}:${scope.id}`), ...(kind ? [kind] : []))
      .map(row => ({ id: String(row.id), kind: String(row.kind), payload: JSON.parse(String(row.payload)) as Record<string, unknown> }));
  }
  saveAsset(projectId: string, scope: ConsoleScope, name: string, dataUrl: string) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw new TaskStorageError("INVALID_INPUT", "Choose a PNG, JPEG or WebP image.");
    const bytes = Buffer.from(match[2]!, "base64");
    const valid = match[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : match[1] === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!valid || bytes.toString("base64") !== match[2]) throw new TaskStorageError("INVALID_INPUT", "Invalid image data.");
    const id = `asset_${createHash("sha256").update(`${projectId}:${scope.kind}:${scope.id}:`).update(bytes).digest("hex").slice(0, 32)}`;
    const asset = ConsoleAssetSchema.parse({ id, name, mimeType: match[1], bytes: bytes.length });
    this.put(projectId, scope, id, "ASSET", { ...asset, dataUrl });
    return asset;
  }
  asset(projectId: string, id: string) {
    const row = this.access.sqlite.prepare("SELECT payload FROM console_context_entries WHERE id = ? AND project_id = ? AND kind = 'ASSET'").get(id, projectId);
    if (!row) throw new TaskStorageError("PARENT_NOT_FOUND", "Image unavailable in this project.");
    const value = JSON.parse(String(row.payload)) as Record<string, unknown>;
    return { ...ConsoleAssetSchema.parse({ id: value.id, name: value.name, mimeType: value.mimeType, bytes: value.bytes }), dataUrl: String(value.dataUrl) };
  }
}
