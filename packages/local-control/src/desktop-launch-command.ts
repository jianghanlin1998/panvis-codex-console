/** macOS applet command: detach the entire shell group, not only the Node child. */
export function desktopLaunchCommand(input: {
  repository: string;
  runtime: string;
  entry: string;
  log: string;
  searchPath: string;
}): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // AppleScript waits for EOF on both captured pipes. Redirecting only Node
  // leaves the asynchronous `cd && ...` shell holding those pipes until shutdown.
  return `(cd ${quote(input.repository)} && exec /usr/bin/nohup /usr/bin/env PATH=${quote(input.searchPath)} ${quote(input.runtime)} ${quote(input.entry)}) >>${quote(input.log)} 2>&1 </dev/null &`;
}
