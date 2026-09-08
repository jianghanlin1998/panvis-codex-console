#!/usr/bin/env node
import { spawn } from "node:child_process";
import { request } from "node:http";
import { startLocalControlDaemon } from "./daemon.js";
import { LocalStateError, productionLocalControlPaths, readSessionDescriptor, ensureProductionStateDirectories } from "./state.js";

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error("INVALID_COMMAND");
  const paths = productionLocalControlPaths();
  ensureProductionStateDirectories(paths);
  let ownsDaemon = false;
  try { readSessionDescriptor(paths); }
  catch (error) {
    if (!(error instanceof LocalStateError) || error.code !== "SESSION_UNAVAILABLE") throw error;
    const daemon = await startLocalControlDaemon();
    ownsDaemon = true;
    let stopping = false;
    const stop = () => { if (!stopping) { stopping = true; void daemon.stop().catch(() => { process.exitCode = 1; }); } };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }
  const session = readSessionDescriptor(paths);
  const code = await new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: session.port, path: "/v0/browser/launch", method: "POST", timeout: 10_000,
      headers: { authorization: `Bearer ${session.sessionToken}`, "x-ctc-request": "1", "content-type": "application/json", "content-length": "2" } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > 1000) response.destroy(); });
      response.on("error", () => reject(new Error("SESSION_UNAVAILABLE")));
      response.on("end", () => {
        try {
          const value: unknown = JSON.parse(body);
          if (response.statusCode !== 200 || !value || typeof value !== "object" || !("code" in value) || typeof value.code !== "string" || !/^[a-f0-9]{64}$/.test(value.code)) throw new Error();
          resolve(value.code);
        } catch { reject(new Error("SESSION_UNAVAILABLE")); }
      });
    });
    req.once("timeout", () => req.destroy()); req.once("error", () => reject(new Error("SESSION_UNAVAILABLE"))); req.end("{}");
  });
  const url = `http://127.0.0.1:${session.port}/#launch=${code}`;
  // The one-use ticket is never logged or persisted. No shell interpolation.
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false, windowsHide: true });
    child.once("error", () => reject(new Error("BROWSER_OPEN_FAILED")));
    child.once("exit", status => status === 0 ? resolve() : reject(new Error("BROWSER_OPEN_FAILED")));
  });
  process.stdout.write(ownsDaemon ? "Console 已打开。保持此窗口运行；Ctrl+C 安全停止。\n" : "Console 已打开，使用正在运行的本机服务。\n");
}
void main().catch(() => { process.stderr.write("Console 启动失败；请检查本机服务状态。没有提交新任务。\n"); process.exitCode = 1; });
