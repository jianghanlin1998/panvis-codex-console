#!/usr/bin/env node
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.argv.length !== 2) throw new Error('This installer supports macOS only.');
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repository, 'packages/local-control/dist/ui-cli.js');
if (!existsSync(entry)) throw new Error('Build the Console before installing its desktop entry.');
const destination = join(homedir(), 'Desktop', 'Codex Task Console.app');
const previous = `${destination}.previous`;
if (existsSync(destination) && existsSync(previous)) throw new Error('A previous desktop entry is already retained; inspect it before replacing.');
const logs = join(homedir(), 'Library', 'Logs', 'Codex Task Console');
mkdirSync(logs, { recursive: true, mode: 0o700 }); chmodSync(logs, 0o700);
const staging = mkdtempSync(join(tmpdir(), 'ctc-desktop-install-'));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
try {
  const app = join(staging, 'Codex Task Console.app');
  const log = join(logs, 'launcher.log');
  writeFileSync(log, '', { encoding: 'utf8', mode: 0o600, flag: 'a' }); chmodSync(log, 0o600);
  const searchPath = `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  const command = `cd ${quote(repository)} && /usr/bin/nohup /usr/bin/env PATH=${quote(searchPath)} ${quote(process.execPath)} ${quote(entry)} >>${quote(log)} 2>&1 </dev/null &`;
  const probe = `/usr/bin/head -c 1 ${quote(entry)} >/dev/null`;
  const source = join(staging, 'entry.applescript');
  // This app launches a local process only. It requires no browser automation permission.
  // Keep the responsible app alive, and request repository access before detaching
  // Node. Otherwise macOS can deny the orphaned interpreter without a consent UI.
  writeFileSync(source, `on openConsole()
  try
    do shell script ${JSON.stringify(probe)}
    do shell script ${JSON.stringify(command)}
  on error
    display dialog "Console 尚未启动。请允许它访问 Documents 中的项目文件；如果没有访问提示，请查看系统设置 → 隐私与安全性 → 文件与文件夹。任务记录没有改变。" buttons {"好"} default button "好" with title "Codex Task Console"
  end try
end openConsole
on run
  openConsole()
end run
on reopen
  openConsole()
end reopen
on idle
  return 60
end idle
`, 'utf8');
  execFileSync('/usr/bin/osacompile', ['-s', '-o', app, source], { stdio: 'pipe' });
  for (const setting of [
    'Add :LSUIElement bool true',
    'Add :CFBundleIdentifier string local.codex-task-console.launcher',
    'Add :NSDocumentsFolderUsageDescription string Console 需要读取并运行你在 Documents 中的项目代码。',
  ]) execFileSync('/usr/libexec/PlistBuddy', ['-c', setting, join(app, 'Contents/Info.plist')], { stdio: 'pipe' });
  // Sign only this locally built app after its metadata is final; no system policy changes.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'local.codex-task-console.launcher', app], { stdio: 'pipe' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe' });
  if (existsSync(destination)) renameSync(destination, previous);
  renameSync(app, destination);
  process.stdout.write('Desktop entry installed: Codex Task Console.app\n');
} finally { rmSync(staging, { recursive: true, force: true }); }
