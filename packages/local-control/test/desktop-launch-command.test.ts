import { it, expect } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktopLaunchCommand } from "../src/desktop-launch-command.js";

it("returns both captured shell pipes while the launched process remains alive, on repeated opens", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ctc-entry-")));
  const repository = join(root, "repo ' $(touch SHOULD_NOT_RUN)"); mkdirSync(repository);
  const entry = join(repository, "worker ' file.cjs");
  const log = join(root, "output ' file.log");
  const endpoint = join(root, "ipc");
  const peers: Socket[] = [];
  const server = createServer();
  const run = promisify(execFile);
  const searchPath = "/usr/bin:/bin";
  writeFileSync(entry, `const net = require('node:net');
process.stdout.write('worker-out\\n'); process.stderr.write('worker-err\\n');
const socket = net.connect(${JSON.stringify(endpoint)}, () => socket.write(JSON.stringify({ pid: process.pid, cwd: process.cwd(), path: process.env.PATH }) + '\\n'));
socket.on('end', () => socket.end());
`, "utf8");
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(endpoint, resolve);
    });
    const command = desktopLaunchCommand({ repository, entry, log, runtime: process.execPath, searchPath });
    for (let opening = 0; opening < 2; opening++) {
      const connected = new Promise<{ pid: number; cwd: string; path: string }>(resolve => {
        server.once("connection", socket => {
          peers.push(socket); let body = "";
          socket.setEncoding("utf8"); socket.on("data", chunk => {
            body += chunk;
            if (body.endsWith("\n")) resolve(JSON.parse(body) as { pid: number; cwd: string; path: string });
          });
        });
      });
      // Harness watchdog only: the worker remains alive until the finally block.
      // The old command never yields pipe EOF and therefore cannot pass this check.
      const [shell, child] = await Promise.all([run("/bin/sh", ["-c", command], { timeout: 5_000 }), connected]);
      expect(shell.stdout).toBe(""); expect(shell.stderr).toBe("");
      expect(child.cwd).toBe(repository); expect(child.path).toBe(searchPath);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    }
    expect(readFileSync(log, "utf8")).toBe("worker-out\nworker-err\nworker-out\nworker-err\n");
  } finally {
    for (const socket of peers) socket.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
