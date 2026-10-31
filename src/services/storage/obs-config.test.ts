import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_BASE = await mkdtemp(join(tmpdir(), "obs-config-test-"));
process.env.OBS_CONFIG_BASE = CONFIG_BASE;

// In-memory bucket behind a fake S3 client. Counts mutating calls so tests can
// assert exactly what a push sent.
const bucket = new Map<string, Uint8Array>();
const ops = { put: [] as string[], deleted: [] as string[], copy: [] as string[] };
let failPut: ((key: string) => boolean) | null = null;

const send = async (cmd: { constructor: { name: string }; input: any }) => {
  const input = cmd.input;
  switch (cmd.constructor.name) {
    case "ListObjectsV2Command": {
      const Contents = [...bucket.keys()]
        .filter((k) => k.startsWith(input.Prefix))
        .map((Key) => ({ Key, ETag: `"${Key}"`, Size: bucket.get(Key)!.byteLength }));
      return { Contents, IsTruncated: false };
    }
    case "GetObjectCommand": {
      const data = bucket.get(input.Key);
      if (!data) throw new Error("NoSuchKey");
      return { Body: { transformToWebStream: () => new Response(data).body } };
    }
    case "PutObjectCommand": {
      if (failPut?.(input.Key)) throw new Error("put failed");
      bucket.set(input.Key, new Uint8Array(input.Body));
      ops.put.push(input.Key);
      return {};
    }
    case "DeleteObjectsCommand": {
      for (const { Key } of input.Delete.Objects) {
        bucket.delete(Key);
        ops.deleted.push(Key);
      }
      return { Errors: [] };
    }
    case "CopyObjectCommand": {
      const from = decodeURIComponent(input.CopySource).slice("test-bucket/".length);
      const data = bucket.get(from);
      if (!data) throw new Error("NoSuchKey");
      bucket.set(input.Key, data);
      ops.copy.push(`${from}->${input.Key}`);
      return {};
    }
  }
  throw new Error(`unexpected command ${cmd.constructor.name}`);
};

mock.module("@/clients/s3", () => ({ s3: { send }, S3_BUCKET: "test-bucket" }));

const {
  pullObsConfig,
  pushObsConfig,
  pushObsMediaFile,
  moveObsMediaFile,
  deleteObsMediaFile,
  removeLocalConfig,
} = await import("./obs-config");

const USER = "user-1";
const ID = "inst-1";
const OVERLAY = `obs-configs/${USER}/${ID}/`;
const MEDIA = `obs-media/${USER}/${ID}/`;
const TEMPLATE = "obs-templates/default/";
const cfgDir = join(CONFIG_BASE, ID, "obs-studio");
const mediaDir = join(CONFIG_BASE, ID, "media");

const enc = (s: string) => new TextEncoder().encode(s);
const text = (k: string) => new TextDecoder().decode(bucket.get(k));

async function writeLocal(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
}

function resetOps() {
  ops.put.length = 0;
  ops.deleted.length = 0;
  ops.copy.length = 0;
}

beforeEach(async () => {
  bucket.clear();
  resetOps();
  failPut = null;
  await removeLocalConfig(ID);
});

afterAll(async () => {
  await rm(CONFIG_BASE, { recursive: true, force: true });
});

describe("pushObsConfig", () => {
  test("uploads only synced paths, and nothing the second time", async () => {
    await writeLocal(join(cfgDir, "basic/scenes/Main.json"), "{}");
    await writeLocal(join(cfgDir, "global.ini"), "[General]");
    await writeLocal(join(cfgDir, "logs/2026.txt"), "log");
    await writeLocal(join(cfgDir, "plugin_config/obs-browser/Cache/Cache_Data/index"), "x");
    await writeLocal(join(cfgDir, "plugin_config/obs-websocket/config.json"), '{"server_password":"pw"}');
    await writeLocal(join(cfgDir, "basic/profiles/StreamWizard/service.json"), '{"key":"live_x"}');
    await writeLocal(join(mediaDir, "intro.mp4"), "video");
    await writeLocal(join(mediaDir, ".upload-abc.tmp"), "partial");

    await pushObsConfig(USER, ID);
    expect(ops.put.sort()).toEqual([`${OVERLAY}basic/scenes/Main.json`, `${OVERLAY}global.ini`, `${MEDIA}intro.mp4`]);

    resetOps();
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([]);
    expect(ops.deleted).toEqual([]);
  });

  test("a new mtime with identical content is not re-uploaded; changed content is", async () => {
    const scene = join(cfgDir, "basic/scenes/Main.json");
    await writeLocal(scene, '{"a":1}');
    await pushObsConfig(USER, ID);
    resetOps();

    const later = new Date(Date.now() + 60_000);
    await utimes(scene, later, later);
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([]);

    await writeLocal(scene, '{"a":2}');
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([`${OVERLAY}basic/scenes/Main.json`]);
    expect(text(`${OVERLAY}basic/scenes/Main.json`)).toBe('{"a":2}');
  });

  test("mirrors local deletes, except when deletes are off", async () => {
    const scene = join(cfgDir, "basic/scenes/Old.json");
    await writeLocal(scene, "{}");
    await pushObsConfig(USER, ID);
    await rm(scene);
    resetOps();

    await pushObsConfig(USER, ID, { deletes: false });
    expect(ops.deleted).toEqual([]);

    await pushObsConfig(USER, ID);
    expect(ops.deleted).toEqual([`${OVERLAY}basic/scenes/Old.json`]);
    expect(bucket.has(`${OVERLAY}basic/scenes/Old.json`)).toBe(false);
  });

  test("a failed upload throws and is retried by the next push", async () => {
    await writeLocal(join(cfgDir, "global.ini"), "a");
    await writeLocal(join(cfgDir, "user.ini"), "b");
    failPut = (key) => key.endsWith("user.ini");

    await expect(pushObsConfig(USER, ID)).rejects.toThrow("1 file(s) failed");
    expect(ops.put).toEqual([`${OVERLAY}global.ini`]);

    failPut = null;
    resetOps();
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([`${OVERLAY}user.ini`]);
  });

  test("does nothing when the local dir is gone", async () => {
    bucket.set(`${OVERLAY}global.ini`, enc("keep"));
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([]);
    expect(ops.deleted).toEqual([]);
    expect(bucket.has(`${OVERLAY}global.ini`)).toBe(true);
  });
});

describe("pullObsConfig", () => {
  test("seeds the manifest so the first push uploads nothing", async () => {
    bucket.set(`${TEMPLATE}basic/scenes/Default.json`, enc("{}"));
    bucket.set(`${TEMPLATE}basic/profiles/StreamWizard/basic.ini`, enc("[Video]"));
    bucket.set(`${OVERLAY}basic/scenes/Main.json`, enc('{"user":1}'));
    bucket.set(`${MEDIA}intro.mp4`, enc("video"));

    await pullObsConfig(USER, ID);
    expect(await Bun.file(join(cfgDir, "basic/profiles/StreamWizard/basic.ini")).text()).toBe("[Video]");
    expect(await Bun.file(join(mediaDir, "intro.mp4")).text()).toBe("video");

    resetOps();
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([]);
    expect(ops.deleted).toEqual([]);
  });

  test("template files go to the overlay only once changed, and are never deleted from it", async () => {
    bucket.set(`${TEMPLATE}basic/scenes/Default.json`, enc("{}"));
    await pullObsConfig(USER, ID);
    resetOps();

    await writeLocal(join(cfgDir, "basic/scenes/Default.json"), '{"edited":true}');
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([`${OVERLAY}basic/scenes/Default.json`]);

    await removeLocalConfig(ID);
    bucket.delete(`${OVERLAY}basic/scenes/Default.json`);
    await pullObsConfig(USER, ID);
    await rm(join(cfgDir, "basic/scenes/Default.json"));
    resetOps();
    await pushObsConfig(USER, ID);
    expect(ops.deleted).toEqual([]);
  });

  test("prunes keys the policy no longer keeps instead of downloading them", async () => {
    bucket.set(`${OVERLAY}basic/scenes/Main.json`, enc("{}"));
    bucket.set(`${OVERLAY}logs/old.txt`, enc("log"));
    bucket.set(`${OVERLAY}plugin_config/obs-browser/GPUCache/data_0`, enc("x"));
    bucket.set(`${OVERLAY}basic/profiles/StreamWizard/service.json`, enc("{}"));
    bucket.set(`${MEDIA}.upload-x.tmp`, enc("partial"));

    await pullObsConfig(USER, ID);
    expect(ops.deleted.sort()).toEqual(
      [
        `${MEDIA}.upload-x.tmp`,
        `${OVERLAY}basic/profiles/StreamWizard/service.json`,
        `${OVERLAY}logs/old.txt`,
        `${OVERLAY}plugin_config/obs-browser/GPUCache/data_0`,
      ].sort(),
    );
    expect(await Bun.file(join(cfgDir, "logs/old.txt")).exists()).toBe(false);
    expect([...bucket.keys()]).toEqual([`${OVERLAY}basic/scenes/Main.json`]);
  });

  test("pushes a leftover local dir before pulling over it", async () => {
    bucket.set(`${OVERLAY}basic/scenes/Main.json`, enc("old"));
    await writeLocal(join(cfgDir, "basic/scenes/Main.json"), "newer");

    await pullObsConfig(USER, ID);
    expect(text(`${OVERLAY}basic/scenes/Main.json`)).toBe("newer");
    expect(await Bun.file(join(cfgDir, "basic/scenes/Main.json")).text()).toBe("newer");
  });

  test("keeps a leftover dir it can't push, but still re-applies the template profile", async () => {
    bucket.set(`${TEMPLATE}basic/profiles/StreamWizard/basic.ini`, enc("[Video] plan"));
    bucket.set(`${OVERLAY}basic/scenes/Main.json`, enc("old"));
    await writeLocal(join(cfgDir, "basic/scenes/Main.json"), "newer");
    await writeLocal(join(cfgDir, "basic/profiles/StreamWizard/basic.ini"), "[Video] edited");
    await writeLocal(join(cfgDir, "basic/profiles/Other/basic.ini"), "[Video] extra");
    failPut = () => true;

    await pullObsConfig(USER, ID);
    expect(await Bun.file(join(cfgDir, "basic/scenes/Main.json")).text()).toBe("newer");
    expect(await Bun.file(join(cfgDir, "basic/profiles/StreamWizard/basic.ini")).text()).toBe("[Video] plan");
    expect(await Bun.file(join(cfgDir, "basic/profiles/Other/basic.ini")).exists()).toBe(false);
  });
});

describe("single media files", () => {
  test("upload, rename and delete touch only their own keys", async () => {
    await pullObsConfig(USER, ID);
    await writeLocal(join(mediaDir, "a.mp4"), "aaa");
    await writeLocal(join(mediaDir, "big.mp4"), "bbb");
    await pushObsConfig(USER, ID);
    resetOps();

    await writeLocal(join(mediaDir, "c.mp4"), "ccc");
    await pushObsMediaFile(USER, ID, "c.mp4");
    expect(ops.put).toEqual([`${MEDIA}c.mp4`]);

    resetOps();
    await rm(join(mediaDir, "a.mp4"));
    await writeLocal(join(mediaDir, "renamed.mp4"), "aaa");
    await moveObsMediaFile(USER, ID, "a.mp4", "renamed.mp4");
    expect(ops.put).toEqual([]);
    expect(ops.copy).toEqual([`${MEDIA}a.mp4->${MEDIA}renamed.mp4`]);
    expect(ops.deleted).toEqual([`${MEDIA}a.mp4`]);

    resetOps();
    await rm(join(mediaDir, "big.mp4"));
    await deleteObsMediaFile(USER, ID, "big.mp4");
    expect(ops.deleted).toEqual([`${MEDIA}big.mp4`]);

    // The manifest followed every op, so a full push has nothing left to do.
    resetOps();
    await pushObsConfig(USER, ID);
    expect(ops.put).toEqual([]);
    expect(ops.deleted).toEqual([]);
  });
});
