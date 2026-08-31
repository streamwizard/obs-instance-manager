// Docker's NanoCpus cap is invisible from inside the container: sched_getaffinity
// still reports every host core, so nproc, Qt's idealThreadCount and Chromium's
// SysInfo::NumberOfProcessors all size their thread pools off the node's 16
// logical cores while the cgroup only ever grants cpu_quota (4) cores of CPU
// time. In practice that means obs-browser alone spawns ~80 ThreadPool threads
// per instance, all contending for a quarter of the machine -- which surfaces as
// cgroup throttle stalls and dropped frames rather than as visible CPU
// saturation. Pinning each container to exactly ceil(cpu_quota) cores makes
// affinity agree with the quota so every library sizes itself correctly.
export function parseCpuset(cpuset: string | undefined | null, total: number): number[] {
  if (!cpuset) return [];
  const cores: number[] = [];
  for (const part of cpuset.split(",")) {
    const range = part.trim();
    if (!range) continue;
    const [startStr, endStr] = range.split("-");
    // Number("") is 0, not NaN, so an empty bound has to be rejected by hand or
    // a malformed "-" would silently parse as core 0.
    if (!startStr || endStr === "") continue;
    const start = Number(startStr);
    const end = endStr === undefined ? start : Number(endStr);
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    for (let core = start; core <= end && core < total; core++) {
      if (core >= 0) cores.push(core);
    }
  }
  return cores;
}

// Windows deliberately overlap: max_instances * cpu_quota exceeds the node's
// logical core count (8 * 4 > 16 on obs-node-1), so disjoint pinning is
// impossible. Taking the least-subscribed cores just spreads instances as
// evenly as the node allows; NanoCpus stays the hard cap either way.
export function pickLeastUsedCores(usage: number[], want: number): number[] {
  return usage
    .map((count, core) => ({ count, core }))
    .sort((a, b) => a.count - b.count || a.core - b.core)
    .slice(0, want)
    .map((entry) => entry.core)
    .sort((a, b) => a - b);
}
