import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename } from "node:path";
import { devNull } from "node:os";
import { TaskStorageError } from "@codex-task-console/storage";

export function folderDialogCommand(platform = process.platform): { executable: string; args: string[] } | null {
  if (platform === "darwin") return { executable: "/usr/bin/osascript", args: ["-e", 'try\nPOSIX path of (choose folder with prompt "选择项目文件夹")\non error number -128\nreturn ""\nend try'] };
  if (platform === "win32") return { executable: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = 'Choose project folder'; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Write($picker.SelectedPath) }; $picker.Dispose()"] };
  return null;
}
export async function chooseProjectFolder(): Promise<string | null> {
  const command = folderDialogCommand();
  if (!command) throw new TaskStorageError("INVALID_INPUT", "Folder picker unavailable on this system; enter a path.");
  return new Promise((resolve, reject) => execFile(command.executable, command.args, { encoding: "utf8", timeout: 120_000, maxBuffer: 16_000, windowsHide: false, shell: false }, (error, output) => {
    if (error) reject(new TaskStorageError("CONFLICT", "The folder dialog could not open. You can enter a path instead."));
    else resolve(output.trim() || null);
  }));
}
export async function inspectProjectFolder(path: string) {
  const selected = realpathSync(path);
  if (!lstatSync(selected).isDirectory()) throw new TaskStorageError("INVALID_INPUT", "Choose a project folder.");
  const git = (args: string[]) => new Promise<string>((resolve, reject) => execFile("git", ["-C", selected, "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${devNull}`, ...args], { encoding: "utf8", timeout: 5000, maxBuffer: 16000, windowsHide: true, shell: false, env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0" } }, (error, out) => error ? reject(new TaskStorageError("INVALID_INPUT", "This folder does not yet have a Git history. Initialize version control before adding it.")) : resolve(out.trim())));
  try {
    const repositoryPath = realpathSync(await git(["rev-parse", "--show-toplevel"]));
    const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).split("\n").filter(Boolean);
    const current = await git(["branch", "--show-current"]);
    const defaultBranch = current || (branches.includes("main") ? "main" : branches[0]);
    if (!defaultBranch) return { selected, repositoryPath, name: basename(repositoryPath), ready: false, message: "这个仓库还没有提交。先保存一次初始版本，再添加项目。" };
    const name = basename(repositoryPath);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
    return { selected, repositoryPath, name, slug, defaultBranch, branches, ready: true };
  } catch { return { selected, repositoryPath: selected, name: basename(selected), ready: false, message: "已选中文件夹。当前 Console 需要 Git 版本记录；这个文件夹尚未就绪。可选择已有仓库，或先为它建立初始版本。" }; }
}
