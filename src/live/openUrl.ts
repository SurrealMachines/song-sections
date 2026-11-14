import { spawn } from "node:child_process";

/**
 * Opens `url` in the system's default browser (the About panel's links): `open` on macOS, `explorer.exe` on Windows.
 * Resolves true once the opener has started, false when it cannot be started (for example when the host's sandbox
 * allows no child processes): the panel then says to copy the link instead. Callers pass only the fixed About links.
 */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const [cmd, args] = platform === "win32" ? ["explorer.exe", [url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false); // ERR_ACCESS_DENIED under a sandbox without --allow-child-process
    }
  });
}
