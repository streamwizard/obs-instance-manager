// Instance containers are named `obs-instance-<instance uuid>` (see
// services/instances/create-instance.ts). Matching the bare "obs-instance-"
// prefix is not enough: this manager's own container is `obs-instance-manager`
// (docker-compose.yml), and Docker's name filter is a substring match.

const INSTANCE_CONTAINER_NAME =
  /^\/?obs-instance-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The instance id for an instance container's name (with or without Docker's
 *  leading "/"), or null for any other container. */
export function instanceIdFromContainerName(name: string): string | null {
  return INSTANCE_CONTAINER_NAME.exec(name)?.[1] ?? null;
}

/** The container name for an instance id, or null when the id is not a UUID
 *  (so a request path can never steer the name). */
export function containerNameForInstance(instanceId: string): string | null {
  const name = `obs-instance-${instanceId}`;
  return instanceIdFromContainerName(name) === null ? null : name;
}

/** For docker.listContainers() results, whose Names carry a leading "/". */
export function isInstanceContainer(container: { Names?: string[] }): boolean {
  return (container.Names ?? []).some((n) => instanceIdFromContainerName(n) !== null);
}
