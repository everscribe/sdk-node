import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "event/index": "src/event/index.ts",
    "recorder/index": "src/recorder/index.ts",
    "minter/index": "src/minter/index.ts",
    express: "src/express.ts",
    fastify: "src/fastify.ts",
    hono: "src/hono.ts",
    grpc: "src/grpc.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  splitting: false,
  treeshake: true,
});
