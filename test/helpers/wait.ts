/** Small polling helpers for tests that watch real processes. */

import { readFileSync } from "node:fs";

/**
 * Matches the extension's notion of running: a signalled child that has not been reaped is a zombie,
 * not a live command. Reading /proc here is deliberately duplicated rather than imported, so a test
 * never trusts the code under test to say whether the process it is watching is alive.
 */
export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
