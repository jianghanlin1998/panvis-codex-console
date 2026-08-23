import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INSTALLER_WRAPPER = resolve("scripts/install-owned-codex-runtime.sh");
const RELEASE_VERSION = "0.148.0-alpha.9";

let fixtureRoot: string;
let fakeBin: string;
let fakeHome: string;
let fakeInstaller: string;
let installerCapture: string;
let installerTemporaryRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "ctc-runtime-installer-test-"));
  fakeBin = join(fixtureRoot, "fake-bin");
  fakeHome = join(fixtureRoot, "Home with spaces 雪");
  fakeInstaller = join(fixtureRoot, "official-install.sh");
  installerCapture = join(fixtureRoot, "installer-capture.txt");
  installerTemporaryRoot = join(fixtureRoot, "tmp");
  mkdirSync(fakeBin);
  mkdirSync(fakeHome);
  mkdirSync(installerTemporaryRoot);
  writeExecutable(join(fakeBin, "curl"), fakeCurlScript());
  writeExecutable(join(fakeBin, "uname"), fakeUnameScript());
  writeExecutable(fakeInstaller, completeInstallerScript());
});

afterEach(() => {
  rmSync(fixtureRoot, { force: true, recursive: true });
});

describe("owned Codex runtime installer wrapper", () => {
  it.each([
    { arguments_: [] as string[] },
    { arguments_: ["1.2.3;touch-owned"] },
    { arguments_: ["/absolute/codex"] },
  ])(
    "rejects a missing or hostile release without downloading: %j",
    ({ arguments_ }) => {
      const result = runInstaller(arguments_);
      expect(result.status).toBe(2);
      expect(existsSync(installerCapture)).toBe(false);
      expect(result.stderr).not.toContain(fakeHome);
    },
  );

  it("rejects unsupported platforms before downloading", () => {
    const result = runInstaller([RELEASE_VERSION], { FAKE_UNAME_S: "Linux" });
    expect(result.status).toBe(2);
    expect(existsSync(installerCapture)).toBe(false);
  });

  it("rejects a preexisting runtime-root symlink before downloading", () => {
    const runtimeRoot = ownedRuntimeRoot();
    const outsideRoot = join(fixtureRoot, "outside-runtime-root");
    mkdirSync(join(runtimeRoot, ".."), { recursive: true });
    mkdirSync(outsideRoot);
    symlinkSync(outsideRoot, runtimeRoot);

    const result = runInstaller([RELEASE_VERSION]);
    expect(result.status).not.toBe(0);
    expect(existsSync(installerCapture)).toBe(false);
    expect(readdirSync(outsideRoot)).toEqual([]);
  });

  it("fails closed on curl failure or an incomplete installer contract", () => {
    const curlFailure = runInstaller([RELEASE_VERSION], { FAKE_CURL_FAIL: "1" });
    expect(curlFailure.status).not.toBe(0);
    expect(existsSync(installerCapture)).toBe(false);

    writeExecutable(fakeInstaller, "exit 99");
    const incompleteInstaller = runInstaller([RELEASE_VERSION]);
    expect(incompleteInstaller.status).not.toBe(0);
    expect(existsSync(installerCapture)).toBe(false);
  });

  it("passes exact --release in isolated homes and leaves the candidate inactive", () => {
    const userProfile = join(fakeHome, ".zshrc");
    writeFileSync(userProfile, "preserve-user-profile\n", { encoding: "utf8" });
    const appBundleSentinel = join(
      fakeHome,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex",
    );
    mkdirSync(join(appBundleSentinel, ".."), { recursive: true });
    writeFileSync(appBundleSentinel, "ambient-app-binary\n", { encoding: "utf8" });

    const result = runInstaller([RELEASE_VERSION], {
      FAKE_PROFILE_MUTATION_ATTEMPT: "1",
    });

    expect(result.status).toBe(0);
    const runtimeRoot = ownedRuntimeRoot();
    const candidate = ownedCandidatePath();
    expect(readFileSync(installerCapture, "utf8")).toBe(
      [
        `argument=--release ${RELEASE_VERSION}`,
        `home=${join(runtimeRoot, "installer-home")}`,
        `codex_home=${join(runtimeRoot, "standalone-home")}`,
        `install_dir=${join(runtimeRoot, "installer-bin")}`,
        "non_interactive=1",
        "",
      ].join("\n"),
    );
    expect(readFileSync(userProfile, "utf8")).toBe("preserve-user-profile\n");
    expect(readFileSync(appBundleSentinel, "utf8")).toBe("ambient-app-binary\n");
    expect(existsSync(join(runtimeRoot, "active.json"))).toBe(false);
    expect(existsSync(candidate)).toBe(true);
    expect(readdirSync(installerTemporaryRoot)).toEqual([]);
  });

  it("propagates installer failure and cleans its temporary download", () => {
    const result = runInstaller([RELEASE_VERSION], { FAKE_INSTALLER_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(existsSync(ownedCandidatePath())).toBe(false);
    expect(readdirSync(installerTemporaryRoot)).toEqual([]);
  });

  it.each(["missing", "non-executable", "symlink", "wrong-version"])(
    "rejects a %s final versioned candidate",
    (behavior) => {
      const result = runInstaller([RELEASE_VERSION], {
        FAKE_CANDIDATE_BEHAVIOR: behavior,
      });
      expect(result.status).not.toBe(0);
      expect(existsSync(join(ownedRuntimeRoot(), "active.json"))).toBe(false);
      expect(result.stderr).not.toContain("private fixture output");
    },
  );

  it("rejects an installer that writes only the visible-command path", () => {
    const result = runInstaller([RELEASE_VERSION], {
      FAKE_CANDIDATE_BEHAVIOR: "wrong-path",
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(join(ownedRuntimeRoot(), "installer-bin", "codex"))).toBe(true);
    expect(existsSync(join(ownedRuntimeRoot(), "active.json"))).toBe(false);
  });
});

function runInstaller(
  arguments_: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync("/bin/sh", [INSTALLER_WRAPPER, ...arguments_], {
    encoding: "utf8",
    env: {
      FAKE_CANDIDATE_BEHAVIOR: "success",
      FAKE_CAPTURE_PATH: installerCapture,
      FAKE_INSTALLER_SOURCE: fakeInstaller,
      FAKE_UNAME_M: "arm64",
      FAKE_UNAME_S: "Darwin",
      HOME: fakeHome,
      PATH: `${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: installerTemporaryRoot,
      ...overrides,
    },
  });
}

function ownedRuntimeRoot(): string {
  return join(
    fakeHome,
    "Library",
    "Application Support",
    "Codex Task Console",
    "codex-runtime",
  );
}

function ownedCandidatePath(): string {
  return join(
    ownedRuntimeRoot(),
    "standalone-home",
    "packages",
    "standalone",
    "releases",
    `${RELEASE_VERSION}-aarch64-apple-darwin`,
    "bin",
    "codex",
  );
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, ["#!/bin/sh", body, ""].join("\n"), {
    encoding: "utf8",
    mode: 0o700,
  });
  chmodSync(path, 0o700);
}

function fakeCurlScript(): string {
  return [
    'if [ "${FAKE_CURL_FAIL:-0}" = "1" ]; then exit 22; fi',
    "output=",
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) output=$2; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    '/bin/cp "$FAKE_INSTALLER_SOURCE" "$output"',
  ].join("\n");
}

function fakeUnameScript(): string {
  return [
    'case "$1" in',
    '  -s) printf "%s\\n" "$FAKE_UNAME_S" ;;',
    '  -m) printf "%s\\n" "$FAKE_UNAME_M" ;;',
    "  *) exit 2 ;;",
    "esac",
  ].join("\n");
}

function completeInstallerScript(): string {
  return [
    "# Usage: install.sh [--release VERSION]",
    '# BIN_DIR="${CODEX_INSTALL_DIR:-$HOME/.local/bin}"',
    '# CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"',
    "# verify_archive_digest",
    "# codex-package_SHA256SUMS",
    'if [ "$#" -ne 2 ] || [ "$1" != "--release" ]; then exit 31; fi',
    'printf "argument=%s %s\\nhome=%s\\ncodex_home=%s\\ninstall_dir=%s\\nnon_interactive=%s\\n" "$1" "$2" "$HOME" "$CODEX_HOME" "$CODEX_INSTALL_DIR" "$CODEX_NON_INTERACTIVE" > "$FAKE_CAPTURE_PATH"',
    'if [ "${FAKE_INSTALLER_FAIL:-0}" = "1" ]; then exit 32; fi',
    'if [ "${FAKE_PROFILE_MUTATION_ATTEMPT:-0}" = "1" ]; then printf "isolated-profile-attempt\\n" > "$HOME/.zshrc"; fi',
    'candidate="$CODEX_HOME/packages/standalone/releases/$2-aarch64-apple-darwin/bin/codex"',
    'case "$FAKE_CANDIDATE_BEHAVIOR" in',
    "  missing) exit 0 ;;",
    '  wrong-path) candidate="$CODEX_INSTALL_DIR/codex" ;;',
    "esac",
    'mkdir -p "$(dirname "$candidate")"',
    'if [ "$FAKE_CANDIDATE_BEHAVIOR" = "symlink" ]; then',
    '  target="$CODEX_INSTALL_DIR/symlink-target"',
    `  printf '%s\\n' '#!/bin/sh' "printf '%s\\\\n' 'codex-cli $2'" > "$target"`,
    '  chmod 0700 "$target"',
    '  /bin/ln -s "$target" "$candidate"',
    "  exit 0",
    "fi",
    'case "$FAKE_CANDIDATE_BEHAVIOR" in',
    '  wrong-version) reported="codex-cli 0.148.0-alpha.8" ;;',
    '  *) reported="codex-cli $2" ;;',
    "esac",
    `printf '%s\\n' '#!/bin/sh' "printf '%s\\\\n' '$reported'" > "$candidate"`,
    'if [ "$FAKE_CANDIDATE_BEHAVIOR" = "non-executable" ]; then chmod 0600 "$candidate"; else chmod 0700 "$candidate"; fi',
  ].join("\n");
}
