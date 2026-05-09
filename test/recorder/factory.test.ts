import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Event } from "../../src/event/event.js";
import { create } from "../../src/recorder/factory.js";

import { silentLogger, startTestServer, type TestServer } from "./_server.js";

const PROJECT_ID = "proj_123";

let srv: TestServer;

beforeEach(async () => {
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
});

describe("recorder.create", () => {
  it("posts via the inner HttpRecorder using the configured base URL", async () => {
    const rec = create(PROJECT_ID, "k", {
      baseUrl: srv.url,
      flushInterval: 60 * 60 * 1000,
      logger: silentLogger,
    });
    await rec.record(new Event("user.login"));
    await rec.flush();
    expect(srv.requests).toHaveLength(1);
    expect(srv.requests[0]!.path).toBe(`/v1/projects/${PROJECT_ID}/events/batch`);
    await rec.close();
  });

  it("applies bufferSize from the unified options object", async () => {
    const rec = create(PROJECT_ID, "k", {
      baseUrl: srv.url,
      bufferSize: 7,
      flushInterval: 60 * 60 * 1000,
      logger: silentLogger,
    });
    expect(rec.stats().bufferSize).toBe(7);
    await rec.close();
  });

  it("collects multiple records into a single batch on flush", async () => {
    const rec = create(PROJECT_ID, "k", {
      baseUrl: srv.url,
      flushInterval: 60 * 60 * 1000,
      logger: silentLogger,
    });
    await rec.record(new Event("a.one"));
    await rec.record(new Event("a.two"));
    await rec.flush();
    expect(srv.requests).toHaveLength(1);
    const body = JSON.parse(srv.requests[0]!.body) as { events: Array<{ action: string }> };
    expect(body.events.map((e) => e.action)).toEqual(["a.one", "a.two"]);
    await rec.close();
  });
});
