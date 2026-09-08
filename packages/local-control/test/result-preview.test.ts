import { mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "node:http";
import { describe, expect, it } from "vitest";
import { makePlanningFixture } from "../../storage/test/live-planning-fixture.js";
import { ResultPreviews } from "../src/result-preview.js";
import type { PreviewStatus } from "../src/result-preview.js";

function observe() {
  let resolve!: (status: PreviewStatus) => void;
  const settled = new Promise<PreviewStatus>(done => { resolve = done; });
  const previews = new ResultPreviews((_id, status) => { if (["READY", "FAILED"].includes(status.phase)) resolve(status); }, new URL("../src/preview-worker.ts", import.meta.url));
  return { previews, settled };
}
const fetchLocal = (url: string) => new Promise<{ status: number; body: string }>((resolve, reject) => { get(url, response => { let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode!, body })); }).on("error", reject); });
function commit(f: ReturnType<typeof makePlanningFixture>) { f.git(["add", "."]); f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Preview fixture"]); return f.git(["rev-parse", "HEAD"]).toString().trim(); }
describe("delivered-commit preview", () => {
  it("previews committed content, excludes private files and stops without modifying the source checkout", async () => {
    const f = makePlanningFixture(); const { previews, settled } = observe();
    try {
      writeFileSync(join(f.repository, "index.html"), "<h1>Committed result</h1>", "utf8");
      writeFileSync(join(f.repository, ".env"), "SYNTHETIC_SECRET_SENTINEL", "utf8");
      const sha = commit(f); writeFileSync(join(f.repository, "index.html"), "Uncommitted local work", "utf8");
      const before = f.git(["status", "--porcelain"]).toString();
      expect(await previews.start("task", f.repository, sha)).toMatchObject({ phase: "STARTING" });
      const ready = await settled; expect(ready.phase).toBe("READY");
      expect(await fetchLocal(ready.url!)).toMatchObject({ status: 200, body: "<h1>Committed result</h1>" });
      expect((await fetchLocal(`${ready.url}/.env`)).status).toBe(404);
      expect(await previews.start("task", f.repository, sha)).toEqual(ready);
      await previews.stop("task"); expect(previews.status("task", sha).phase).toBe("STOPPED");
      expect(f.git(["status", "--porcelain"]).toString()).toBe(before);
    } finally { await previews.stopAll(); f.close(); }
  });
  it("runs a Node result with no inherited provider credentials or copied credential files", async () => {
    const f = makePlanningFixture(); const { previews, settled } = observe();
    try {
      mkdirSync(join(f.repository, "server"));
      writeFileSync(join(f.repository, ".env"), "SYNTHETIC_SECRET_SENTINEL", "utf8");
      writeFileSync(join(f.repository, "server/index.mjs"), `import {createServer} from 'node:http'; import {existsSync} from 'node:fs'; createServer((_q,r)=>r.end(JSON.stringify({secretFile:existsSync('.env'), environment:Object.keys(process.env).sort()}))).listen(8000,'127.0.0.1');`, "utf8");
      const sha = commit(f); await previews.start("task", f.repository, sha); const ready = await settled;
      if (process.platform !== "darwin") { expect(ready).toMatchObject({ phase: "FAILED", failureCode: "PREVIEW_UNSUPPORTED" }); return; }
      expect(ready.phase).toBe("READY"); const response = await fetchLocal(ready.url!); const result = JSON.parse(response.body);
      expect(result.secretFile).toBe(false); expect(result.environment).toEqual(["HOME", "LANG", "NODE_ENV", "PATH", "TMPDIR"]);
    } finally { await previews.stopAll(); f.close(); }
  });
  it("blocks result code from reading or writing outside its snapshot and spawning subprocesses", async () => {
    const f = makePlanningFixture(); const { previews, settled } = observe();
    try {
      const outside = join(f.root, "outside-sentinel.txt"); writeFileSync(outside, "SYNTHETIC_OUTSIDE", "utf8");
      mkdirSync(join(f.repository, "server"));
      const code = `import {createServer} from 'node:http'; import {readFileSync,writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; import {DatabaseSync} from 'node:sqlite';
      let read=false,write=false,spawn=false,sqlite=false;
      try{readFileSync(${JSON.stringify(outside)},'utf8');read=true}catch{}
      try{writeFileSync(${JSON.stringify(outside)},'changed','utf8');write=true}catch{}
      try{spawn=spawnSync(process.execPath,['-e','process.exit(0)']).status===0}catch{}
      try{const db=new DatabaseSync(${JSON.stringify(f.databasePath)},{readOnly:true}); db.prepare('SELECT name FROM sqlite_master').all();db.close();sqlite=true}catch{}
      createServer((_q,r)=>r.end(JSON.stringify({read,write,spawn,sqlite}))).listen(8000,'127.0.0.1');`;
      writeFileSync(join(f.repository, "server/index.mjs"), code, "utf8");
      await previews.start("task", f.repository, commit(f)); const ready = await settled;
      if (process.platform !== "darwin") { expect(ready).toMatchObject({ phase: "FAILED", failureCode: "PREVIEW_UNSUPPORTED" }); return; }
      expect(ready.phase).toBe("READY");
      expect(JSON.parse((await fetchLocal(ready.url!)).body)).toEqual({ read: false, write: false, spawn: false, sqlite: false });
      expect(readFileSync(outside, "utf8")).toBe("SYNTHETIC_OUTSIDE");
    } finally { await previews.stopAll(); f.close(); }
  });
  it("reports unsupported results explicitly and rejects symlink trees before launching", async () => {
    const f = makePlanningFixture(); const first = observe(); const second = observe();
    try {
      const sha = f.git(["rev-parse", "HEAD"]).toString().trim(); await first.previews.start("task", f.repository, sha);
      expect(await first.settled).toMatchObject({ phase: "FAILED", failureCode: "PREVIEW_UNSUPPORTED" });
      symlinkSync("AGENTS.md", join(f.repository, "index.html")); const linked = commit(f);
      await second.previews.start("task", f.repository, linked);
      expect(await second.settled).toMatchObject({ phase: "FAILED", failureCode: "PREVIEW_UNAVAILABLE" });
    } finally { await first.previews.stopAll(); await second.previews.stopAll(); f.close(); }
  });
});
