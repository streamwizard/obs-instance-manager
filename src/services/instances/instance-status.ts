import { getContainerStatus } from "@/clients/docker";
import type { Instance } from "@/types";

// Attaches the live Docker state to a DB row. The row's `status` is what the
// manager last wrote; docker_status is what the container is doing right now.
export async function withDockerStatus(instance: Instance) {
  const docker_status = instance.container_id
    ? await getContainerStatus(instance.container_id)
    : "not_found";
  return { ...instance, docker_status };
}
