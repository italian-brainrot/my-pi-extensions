/** Small polling helpers for tests that watch real processes. */

export function isAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
