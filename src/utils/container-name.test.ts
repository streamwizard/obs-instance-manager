import { test, expect } from "bun:test";
import { instanceIdFromContainerName, isInstanceContainer } from "./container-name";

const ID = "6953f34f-371a-4f0d-8377-f975c6f100a8";

test("reads the instance id from an instance container name, with or without the leading slash", () => {
  expect(instanceIdFromContainerName(`obs-instance-${ID}`)).toBe(ID);
  expect(instanceIdFromContainerName(`/obs-instance-${ID}`)).toBe(ID);
});

test("ignores the manager's own container and anything else", () => {
  for (const name of ["obs-instance-manager", "/obs-instance-manager", "gpu-xserver", "cadvisor", "obs-instance-", `obs-instance-${ID}-old`, `x-obs-instance-${ID}`]) {
    expect(instanceIdFromContainerName(name)).toBeNull();
  }
});

test("isInstanceContainer works on docker.listContainers() summaries", () => {
  expect(isInstanceContainer({ Names: [`/obs-instance-${ID}`] })).toBe(true);
  expect(isInstanceContainer({ Names: ["/obs-instance-manager"] })).toBe(false);
  expect(isInstanceContainer({})).toBe(false);
});
