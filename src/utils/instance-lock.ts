// Per-instance mutex so start/stop/delete/auto-restart never run concurrently
// for the same instance. Without this, e.g. two overlapping /start calls (or
// a manual /start racing boot-time reconcile's auto-restart) can both reach
// createContainer for the same container name -- the loser's Docker
// name-collision failure then marks a genuinely running instance "error".
const locks = new Map<string, Promise<void>>();

export function withInstanceLock<T>(instanceId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(instanceId) ?? Promise.resolve();
  const result = previous.then(fn, fn);

  // Tail used only to chain the next waiter behind this one -- settles
  // regardless of fn's outcome so a failed run doesn't wedge the queue.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  locks.set(instanceId, tail);
  tail.finally(() => {
    if (locks.get(instanceId) === tail) locks.delete(instanceId);
  });

  return result;
}
