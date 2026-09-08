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
  const source = join(staging, 'entry.applescript');
  // This app launches a local process only. It requires no browser automation permission.
  writeFileSync(source, `on run\n  do shell script ${JSON.stringify(command)}\nend run\n`, 'utf8');
  execFileSync('/usr/bin/osacompile', ['-o', app, source], { stdio: 'pipe' });
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :LSUIElement bool true', join(app, 'Contents/Info.plist')], { stdio: 'pipe' });
  if (existsSync(destination)) renameSync(destination, previous);
  renameSync(app, destination);
  process.stdout.write('Desktop entry installed: Codex Task Console.app\n');
} finally { rmSync(staging, { recursive: true, force: true }); }
