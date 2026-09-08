import { devNull } from "node:os";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** OS file boundary for Node results on the supported macOS desktop. No ambient credentials or subprocess grants. */
export function previewProcessOptions(directory: string, worker: URL, isNodeApplication: boolean) {
  const workerPath = fileURLToPath(worker);
  const node = realpathSync(process.execPath);
  const permissions = [`--openssl-config=${devNull}`, "--permission", `--allow-fs-read=${directory}`, `--allow-fs-read=${workerPath}`, `--allow-fs-write=${directory}`];
  if (process.platform !== "darwin") {
    if (isNodeApplication) return null;
    return { execPath: node, execArgv: permissions };
  }
  const packageFiles: string[] = [];
  for (let parent = dirname(workerPath); ; parent = dirname(parent)) { packageFiles.push(join(parent, "package.json")); if (parent === dirname(parent)) break; }
  const literal = (path: string) => `(literal ${JSON.stringify(path)})`;
  const profile = `(version 1)
(deny default)
(allow process-exec ${literal(node)})
(allow signal (target self))
(allow sysctl-read)
(allow file-read-metadata)
; dyld/libignition opens the root directory and maps system libraries before Node starts.
(allow file-read* (literal "/"))
(allow file-map-executable (subpath "/System") (subpath "/usr/lib") (subpath "/opt/homebrew/Cellar") ${literal(node)})
(allow file-read* (subpath "/System") (subpath "/usr/lib") (subpath "/usr/share/icu") (subpath "/opt/homebrew/Cellar")
  ${literal(node)} ${literal(workerPath)} ${packageFiles.map(literal).join(" ")}
  (subpath ${JSON.stringify(directory)}) (literal "/dev/null")
  (literal "/private/etc/resolv.conf") (literal "/private/etc/hosts") (literal "/private/etc/services") (literal "/private/etc/localtime"))
(allow file-write* (subpath ${JSON.stringify(directory)}) (literal "/dev/null"))
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.dnssd.service"))
(allow network-outbound)
(allow network-inbound (local ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))`;
  return { execPath: "/usr/bin/sandbox-exec", execArgv: ["-p", profile, node, ...permissions] };
}
