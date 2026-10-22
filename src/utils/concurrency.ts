// Promise.all with at most `limit` fn calls in flight. S3 fan-outs used to be
// unbounded, so an instance with thousands of files (or autosave across every
// running instance) opened thousands of sockets and buffered every file at
// once. Results keep input order; the first rejection rejects the whole call,
// like Promise.all, but in-flight calls are left to settle on their own.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };

  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker);
  await Promise.all(workers);
  return results;
}
