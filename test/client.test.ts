import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client, create, createFromEnv } from "../src/client.js";
import { BufferedRecorder } from "../src/recorder/buffered.js";
import { Client as MinterClient } from "../src/minter/client.js";

describe("new Client", () => {
  it("trims and retains credentials", () => {
    const c = new Client("  proj_123  ", "  evs_secret  ");
    expect(c.projectId).toBe("proj_123");
  });

  it.each([
    ["empty projectId", "", "evs_secret", "projectId is empty"],
    ["whitespace projectId", "   ", "evs_secret", "projectId is empty"],
    ["empty apiKey", "proj_123", "", "apiKey is empty"],
    ["whitespace apiKey", "proj_123", "\t\n ", "apiKey is empty"],
    ["both empty", "", "", "projectId is empty"],
  ])("rejects %s", (_name, projectId, apiKey, message) => {
    expect(() => new Client(projectId, apiKey)).toThrow(message);
  });

  it("does not expose the apiKey via enumerable properties", () => {
    const c = new Client("proj_123", "evs_secret");
    const json = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    expect(json).not.toHaveProperty("apiKey");
    expect(JSON.stringify(c)).not.toContain("evs_secret");
  });
});

describe("create", () => {
  it("delegates to the Client constructor", () => {
    const c = create("proj_123", "evs_secret");
    expect(c).toBeInstanceOf(Client);
    expect(c.projectId).toBe("proj_123");
  });

  it("propagates validation errors", () => {
    expect(() => create("", "k")).toThrow("projectId is empty");
  });
});

describe("createFromEnv", () => {
  beforeEach(() => {
    delete process.env.EVERSCRIBE_PROJECT_ID;
    delete process.env.EVERSCRIBE_API_KEY;
  });

  afterEach(() => {
    delete process.env.EVERSCRIBE_PROJECT_ID;
    delete process.env.EVERSCRIBE_API_KEY;
  });

  it("constructs from env vars", () => {
    process.env.EVERSCRIBE_PROJECT_ID = "proj_env";
    process.env.EVERSCRIBE_API_KEY = "evs_env_secret";
    const c = createFromEnv();
    expect(c.projectId).toBe("proj_env");
  });

  it("trims env values", () => {
    process.env.EVERSCRIBE_PROJECT_ID = "  proj_env  ";
    process.env.EVERSCRIBE_API_KEY = "\tevs_env_secret\n";
    const c = createFromEnv();
    expect(c.projectId).toBe("proj_env");
  });

  it.each([
    ["missing projectId", undefined, "evs_secret", "EVERSCRIBE_PROJECT_ID"],
    ["whitespace projectId", "   ", "evs_secret", "EVERSCRIBE_PROJECT_ID"],
    ["missing apiKey", "proj_env", undefined, "EVERSCRIBE_API_KEY"],
    ["whitespace apiKey", "proj_env", "  ", "EVERSCRIBE_API_KEY"],
  ])("rejects %s", (_name, projectId, apiKey, missing) => {
    if (projectId !== undefined) process.env.EVERSCRIBE_PROJECT_ID = projectId;
    if (apiKey !== undefined) process.env.EVERSCRIBE_API_KEY = apiKey;
    expect(() => createFromEnv()).toThrow(missing);
  });
});

describe("Client.newRecorder", () => {
  it("returns a BufferedRecorder", async () => {
    const c = new Client("proj_123", "evs_secret");
    const rec = c.newRecorder({ flushInterval: 60 * 60 * 1000 });
    expect(rec).toBeInstanceOf(BufferedRecorder);
    await rec.close();
  });

  it("forwards options through to the recorder", async () => {
    const c = new Client("proj_123", "evs_secret");
    const rec = c.newRecorder({ bufferSize: 7, flushInterval: 60 * 60 * 1000 });
    expect(rec.stats().bufferSize).toBe(7);
    await rec.close();
  });
});

describe("Client.newMinter", () => {
  it("returns a minter Client", () => {
    const c = new Client("proj_123", "evs_secret");
    const m = c.newMinter();
    expect(m).toBeInstanceOf(MinterClient);
  });

  it("forwards baseUrl to the minter", () => {
    const c = new Client("proj_123", "evs_secret");
    const m = c.newMinter({ baseUrl: "https://staging.example.com/" });
    expect(m.baseUrl).toBe("https://staging.example.com");
  });
});
