import { afterAll, beforeEach, describe, expect, test } from "bun:test";

// Stub rest-api: hands out a distinct temporary key per scope and counts calls.
const credentialCalls: string[] = [];
const api = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    credentialCalls.push(path);
    const m = /^\/api\/obs-nodes\/instances\/([^/]+)\/storage-credentials$/.exec(path);
    const scope = m ? `inst-${m[1]!.slice(0, 8)}` : path === "/api/obs-nodes/storage-credentials" ? "shared" : null;
    if (!scope) return new Response("not found", { status: 404 });
    return Response.json({
      access_key_id: `TEMP${scope.toUpperCase()}`,
      secret_access_key: "temp-secret",
      session_token: `session-${scope}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  },
});

// Stub S3: records which access key signed each request and its session token.
const s3Requests: { method: string; path: string; accessKey: string | null; token: string | null }[] = [];
const s3 = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization") ?? "";
    s3Requests.push({
      method: req.method,
      path: url.pathname + url.search,
      accessKey: /Credential=([^/]+)\//.exec(auth)?.[1] ?? null,
      token: req.headers.get("x-amz-security-token"),
    });
    if (req.method === "POST" && url.searchParams.has("delete")) {
      return new Response(`<?xml version="1.0"?><DeleteResult></DeleteResult>`, { headers: { "content-type": "application/xml" } });
    }
    return new Response(
      `<?xml version="1.0"?><ListBucketResult><Name>b</Name><IsTruncated>false</IsTruncated></ListBucketResult>`,
      { headers: { "content-type": "application/xml" } },
    );
  },
});

process.env.REST_API_URL = `http://127.0.0.1:${api.port}`;
process.env.NODE_API_KEY ??= "test";
process.env.S3_ENDPOINT = `http://127.0.0.1:${s3.port}`;
process.env.S3_BUCKET = "b";
process.env.S3_REGION = "us-east-1";

const { scopeForKey, cachedCredentials, forgetInstanceStorage } = await import("./s3");
const { listObjects, deleteKeys } = await import("@/services/storage/s3-objects");

const USER = "0e0e0000-0000-4000-8000-000000000001";
const INST_A = "aaaaaaaa-0000-4000-8000-000000000001";
const INST_B = "bbbbbbbb-0000-4000-8000-000000000002";

afterAll(() => {
  api.stop(true);
  s3.stop(true);
});

beforeEach(() => {
  credentialCalls.length = 0;
  s3Requests.length = 0;
  forgetInstanceStorage(INST_A);
  forgetInstanceStorage(INST_B);
});

describe("scopeForKey", () => {
  test("instance folders need that instance's credentials", () => {
    expect(scopeForKey(`obs-configs/${USER}/${INST_A}/basic/scenes/Main.json`)).toEqual({ kind: "instance", instanceId: INST_A });
    expect(scopeForKey(`obs-media/${USER}/${INST_A}/`)).toEqual({ kind: "instance", instanceId: INST_A });
  });

  test("everything else uses the shared read-only credentials", () => {
    expect(scopeForKey("obs-templates/default/basic/profiles/")).toEqual({ kind: "shared" });
    expect(scopeForKey("plugins/obs-shaderfilter.so")).toEqual({ kind: "shared" });
    expect(scopeForKey(`obs-configs/${USER}`)).toEqual({ kind: "shared" });
  });
});

describe("cachedCredentials", () => {
  test("reuses credentials until 5 minutes before expiry, and shares one fetch", async () => {
    let now = 0;
    let fetches = 0;
    const provider = cachedCredentials(async () => {
      fetches++;
      await Promise.resolve();
      return {
        access_key_id: `k${fetches}`,
        secret_access_key: "s",
        session_token: "t",
        expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
      };
    }, () => now);

    const [a, b] = await Promise.all([provider(), provider()]);
    expect(a.accessKeyId).toBe("k1");
    expect(b.accessKeyId).toBe("k1");
    now += 54 * 60 * 1000;
    expect((await provider()).accessKeyId).toBe("k1");
    now += 2 * 60 * 1000; // 4 minutes left
    expect((await provider()).accessKeyId).toBe("k2");
    expect(fetches).toBe(2);
  });
});

describe("requests sign with the credentials for their key", () => {
  test("an instance list uses that instance's key, a template list the shared one", async () => {
    await listObjects(`obs-configs/${USER}/${INST_A}/`);
    await listObjects("obs-templates/default/");
    expect(s3Requests.map((r) => [r.accessKey, r.token])).toEqual([
      ["TEMPINST-AAAAAAAA", "session-inst-aaaaaaaa"],
      ["TEMPSHARED", "session-shared"],
    ]);
  });

  test("credentials are fetched once per scope, not per request", async () => {
    await listObjects(`obs-configs/${USER}/${INST_A}/`);
    await listObjects(`obs-media/${USER}/${INST_A}/`);
    expect(credentialCalls.filter((p) => p.includes(INST_A))).toHaveLength(1);
  });

  test("a mixed delete is split per instance", async () => {
    const keys = [
      `obs-configs/${USER}/${INST_A}/a.json`,
      `obs-configs/${USER}/${INST_B}/b.json`,
      `obs-media/${USER}/${INST_A}/c.png`,
    ];
    expect((await deleteKeys(keys)).sort()).toEqual([...keys].sort());
    const deletes = s3Requests.filter((r) => r.method === "POST");
    expect(deletes.map((r) => r.accessKey).sort()).toEqual(["TEMPINST-AAAAAAAA", "TEMPINST-BBBBBBBB"]);
  });
});
