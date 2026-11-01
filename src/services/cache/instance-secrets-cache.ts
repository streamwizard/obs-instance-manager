import { apiGetInstanceSecrets, type InstanceSecrets } from "@/clients/streamwizard-api/secrets";

// Per-instance passwords, held in memory only: never written to disk, never
// logged. Every start, OBS command batch and scene-listener reconnect needs
// them, and a reconnect loop shouldn't turn into a rest-api call per attempt.
//
// The passwords never change after create (rest-api only ever fills in a
// missing VNC password, once), so the TTL just bounds how long a deleted
// instance's passwords stay in memory if the delete didn't go through this
// process. A delete through clients/streamwizard-api/instances clears the
// entry right away. Failures are not cached: the next call retries.

const TTL_MS = Number(process.env.INSTANCE_SECRETS_CACHE_TTL_MS) || 5 * 60_000;

const cache = new Map<string, { secrets: InstanceSecrets; expiresAt: number }>();
const inFlight = new Map<string, Promise<InstanceSecrets>>();

export async function getInstanceSecrets(instanceId: string): Promise<InstanceSecrets> {
  const hit = cache.get(instanceId);
  if (hit && hit.expiresAt > Date.now()) return hit.secrets;
  if (hit) cache.delete(instanceId);

  // Concurrent callers for the same instance share one request.
  const pending = inFlight.get(instanceId);
  if (pending) return pending;

  const request: Promise<InstanceSecrets> = apiGetInstanceSecrets(instanceId)
    .then((secrets) => {
      // Skip the store if the instance was forgotten (deleted) mid-request.
      if (inFlight.get(instanceId) === request) {
        cache.set(instanceId, { secrets, expiresAt: Date.now() + TTL_MS });
      }
      return secrets;
    })
    .finally(() => {
      if (inFlight.get(instanceId) === request) inFlight.delete(instanceId);
    });
  inFlight.set(instanceId, request);
  return request;
}

/** Drops one instance's passwords, e.g. after it's deleted. */
export function forgetInstanceSecrets(instanceId: string): void {
  cache.delete(instanceId);
  inFlight.delete(instanceId);
}

/** Test helper. */
export function clearInstanceSecretsCache(): void {
  cache.clear();
  inFlight.clear();
}
