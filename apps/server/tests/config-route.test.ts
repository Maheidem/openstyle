import { describe, expect, it } from "vitest";
import createApp from "../src/index.js";
import { jsonRequest } from "./helpers/http.js";

const app = createApp();

function putFlag(key: string, body: unknown) {
  return jsonRequest(app, "PUT", `/api/config/flags/${key}`, body);
}

describe("meetings flag default (#179)", () => {
  it("is on when unset and stays off after an explicit false", async () => {
    const before = (await (await app.request("/api/config")).json()) as {
      flags: Record<string, boolean>;
    };
    expect(before.flags.meetings).toBe(true);
    const flag = await app.request("/api/config/flags/meetings");
    expect(await flag.json()).toEqual({ key: "meetings", value: true });

    expect((await putFlag("meetings", { value: false })).status).toBe(200);
    const after = (await (await app.request("/api/config")).json()) as {
      flags: Record<string, boolean>;
    };
    expect(after.flags.meetings).toBe(false);
    const off = await app.request("/api/config/flags/meetings");
    expect(await off.json()).toEqual({ key: "meetings", value: false });
  });
});

describe("/api/config/flags/:key", () => {
  it("sets a boolean flag and reflects it in GET /api/config", async () => {
    const put = await putFlag("streaming_audio", { value: true });
    expect(put.status).toBe(200);

    const get = await app.request("/api/config");
    expect(get.status).toBe(200);
    const config = (await get.json()) as { flags: Record<string, boolean> };
    expect(config.flags.streaming_audio).toBe(true);
  });

  it("rejects a non-boolean value with 400", async () => {
    const res = await putFlag("streaming_audio", { value: "true" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing value with 400", async () => {
    const res = await putFlag("streaming_audio", {});
    expect(res.status).toBe(400);
  });
});
