// Scoped debug logging, gated by the DEBUG env var (comma-separated scopes,
// or "*" for everything). Mirrors the ergonomics of the `debug` npm package
// without the dependency. No-op when DEBUG is unset, so this is safe to
// sprinkle liberally without polluting production logs.
const requestedScopes = (process.env.DEBUG ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allEnabled = requestedScopes.includes("*");

function isEnabled(scope: string): boolean {
  return allEnabled || requestedScopes.includes(scope);
}

export function debug(scope: string, message: string, data?: unknown): void {
  if (!isEnabled(scope)) return;
  const timestamp = new Date().toISOString();
  if (data !== undefined) {
    console.log(`${timestamp} [${scope}] ${message}`, data);
  } else {
    console.log(`${timestamp} [${scope}] ${message}`);
  }
}
