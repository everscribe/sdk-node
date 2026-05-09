import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface TestServer {
  url: string;
  requests: CapturedRequest[];
  /** Override the response for the next (and subsequent) requests. */
  setResponse(status: number, body?: string): void;
  close(): Promise<void>;
}

/** Starts a real HTTP server on 127.0.0.1 and an OS-assigned port. Captures
 *  every request for assertions and returns 202 Accepted by default. */
export async function startTestServer(): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  let nextStatus = 202;
  let nextBody = "";

  const server: Server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k] = v;
        else if (Array.isArray(v) && v.length > 0) headers[k] = v[0]!;
      }
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers,
        body,
      });
      res.statusCode = nextStatus;
      if (nextBody) res.write(nextBody);
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    requests,
    setResponse(status, body = "") {
      nextStatus = status;
      nextBody = body;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/** Discards SDK diagnostic logging so tests stay quiet. */
export const silentLogger = {
  warn() {
    /* no-op */
  },
  error() {
    /* no-op */
  },
};
