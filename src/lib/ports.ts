import type { AllocatedPorts, Node, UsedPorts } from "../types";

function findFreePort(start: number, end: number, used: number[]): number {
  const usedSet = new Set(used);
  for (let port = start; port <= end; port++) {
    if (!usedSet.has(port)) return port;
  }
  throw new Error(
    `No free port available in range ${start}-${end} (all ${end - start + 1} ports in use)`
  );
}

export function allocatePorts(node: Node, usedPorts: UsedPorts): AllocatedPorts {
  const vnc_port = findFreePort(node.vnc_port_start, node.vnc_port_end, usedPorts.vnc);
  const novnc_port = findFreePort(node.novnc_port_start, node.novnc_port_end, usedPorts.novnc);
  const obs_ws_port = findFreePort(node.obs_ws_port_start, node.obs_ws_port_end, usedPorts.obs_ws);
  return { vnc_port, novnc_port, obs_ws_port };
}
