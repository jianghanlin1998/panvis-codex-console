import { previewProcessOptions } from "./preview-sandbox.js";
import { execFile, fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute, basename } from "node:path";
import { devNull, tmpdir } from "node:os";

export interface PreviewStatus {
  readonly phase: "STOPPED" | "STARTING" | "READY" | "FAILED";
  readonly url: string | null;
  readonly headSha: string;
  readonly failureCode?: "PREVIEW_UNSUPPORTED" | "PREVIEW_UNAVAILABLE";
}
interface Preview { status: PreviewStatus; child: ChildProcess | null; directory: string; controller: AbortController; preparing: Promise<void>; }
const safeEnvironment = () => ({ PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, HOME: devNull, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });
function git(repository: string, args: string[], maximum: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repository, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args],
      { shell: false, env: safeEnvironment(), timeout: 15_000, maxBuffer: maximum, windowsHide: true, encoding: "buffer", signal },
      (error, stdout) => error ? reject(new Error("PREVIEW_UNAVAILABLE")) : resolve(stdout));
  });
}
const privateFile = (name: string) => name.split("/").some(part => [".git", ".ssh", ".aws", ".azure", ".config", ".codex", "node_modules"].includes(part))
  || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$/i.test(basename(name))
  || /\.(?:pem|key|p12|pfx)$/i.test(name);

/** Runs only a human-selected delivered commit; preparation never blocks the daemon's request loop. */
export class ResultPreviews {
  readonly #previews = new Map<string, Preview>();
  constructor(private readonly observe: (id: string, status: PreviewStatus) => void = () => undefined, private readonly workerUrl = new URL("./preview-worker.js", import.meta.url)) {}
  #set(id: string, preview: Preview, status: PreviewStatus): void { preview.status = status; this.observe(id, status); }
  status(id: string, headSha: string): PreviewStatus { return this.#previews.get(id)?.status ?? { phase: "STOPPED", headSha, url: null }; }
  async start(id: string, repository: string, headSha: string): Promise<PreviewStatus> {
    const prior = this.#previews.get(id);
    if (prior && prior.status.headSha === headSha && ["STARTING", "READY"].includes(prior.status.phase)) return prior.status;
    if (prior) await this.stop(id);
    if ([...this.#previews.values()].filter(item => ["STARTING", "READY"].includes(item.status.phase)).length >= 3) throw new Error("PREVIEW_UNAVAILABLE");
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "ctc-result-preview-")); chmodSync(directory, 0o700);
    const preview: Preview = { directory, child: null, status: { phase: "STARTING", url: null, headSha }, controller: new AbortController(), preparing: Promise.resolve() };
    this.#previews.set(id, preview);
    preview.preparing = this.#prepare(id, preview, repository);
    return preview.status;
  }
  async #prepare(id: string, preview: Preview, repository: string): Promise<void> {
    const { headSha } = preview.status;
    const fail = (failureCode: "PREVIEW_UNSUPPORTED" | "PREVIEW_UNAVAILABLE" = "PREVIEW_UNAVAILABLE") => {
      if (preview.status.phase === "STOPPED") return;
      this.#set(id, preview, { phase: "FAILED", url: null, headSha, failureCode });
      preview.controller.abort();
      preview.child?.kill("SIGTERM");
    };
    const deadline = setTimeout(() => { fail(); }, 45_000); deadline.unref();
    try {
      const records = (await git(repository, ["ls-tree", "-rz", "--full-tree", headSha], 1024 * 1024, preview.controller.signal)).toString("utf8").split("\0").filter(Boolean);
      if (records.length > 3000) throw new Error();
      let total = 0; const files = new Set<string>();
      for (const record of records) {
        const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/u.exec(record);
        if (!match) throw new Error();
        const name = match[3]!;
        if (isAbsolute(name) || name.split("/").some(part => part === "..") || name.includes("\\")) throw new Error();
        if (privateFile(name)) continue;
        const target = join(preview.directory, name);
        if (relative(preview.directory, target).startsWith("..")) throw new Error();
        const bytes = await git(repository, ["cat-file", "blob", match[2]!], 4 * 1024 * 1024, preview.controller.signal);
        total += bytes.length; if (total > 24 * 1024 * 1024) throw new Error();
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, bytes, { flag: "wx", mode: 0o600 }); files.add(name);
      }
      const entry = files.has("server/index.mjs") ? "server/index.mjs" : files.has("index.html") ? "index.html" : null;
      if (!entry) { fail("PREVIEW_UNSUPPORTED"); return; }
      if (preview.controller.signal.aborted) throw new Error();
      const processOptions = previewProcessOptions(preview.directory, this.workerUrl, entry === "server/index.mjs");
      if (!processOptions) { fail("PREVIEW_UNSUPPORTED"); return; }
      const child = fork(this.workerUrl, [entry], { cwd: preview.directory,
        ...processOptions, env: { PATH: safeEnvironment().PATH, HOME: preview.directory, TMPDIR: preview.directory, NODE_ENV: "development", LANG: "en_US.UTF-8" },
        stdio: ["ignore", "ignore", "ignore", "ipc"] });
      preview.child = child;
      // A failed or timed-out application is terminated even if it ignores SIGTERM.
      const finish = () => { clearTimeout(deadline); preview.child = null; rmSync(preview.directory, { recursive: true, force: true }); if (preview.status.phase !== "STOPPED") fail(); };
      child.once("error", finish); child.once("exit", finish);
      child.on("message", message => {
        if (preview.status.phase !== "STARTING") return;
        if (message && typeof message === "object" && "type" in message && message.type === "ready" && "port" in message && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65535) {
          clearTimeout(deadline); this.#set(id, preview, { phase: "READY", url: `http://localhost:${message.port}`, headSha });
        }
      });
      preview.controller.signal.addEventListener("abort", () => { const kill = setTimeout(() => { if (preview.child) child.kill("SIGKILL"); }, 3000); kill.unref(); child.once("exit", () => clearTimeout(kill)); }, { once: true });
    } catch { fail(); }
    finally { if (!preview.child) { clearTimeout(deadline); rmSync(preview.directory, { recursive: true, force: true }); } }
  }
  async stop(id: string): Promise<void> {
    const preview = this.#previews.get(id); if (!preview) return;
    this.#set(id, preview, { phase: "STOPPED", url: null, headSha: preview.status.headSha });
    preview.controller.abort(); await preview.preparing;
    const child = preview.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); }, 3000); timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
      });
    }
    rmSync(preview.directory, { recursive: true, force: true }); this.#previews.delete(id);
  }
  async stopAll(): Promise<void> { for (const id of this.#previews.keys()) await this.stop(id); }
}
