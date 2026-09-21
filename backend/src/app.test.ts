import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import test from "node:test";

import { app } from "./app.js";

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

async function withServer<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("malformed JSON returns a structured 400 response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const body = (await response.json()) as ErrorResponse;

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "MALFORMED_JSON");
  });
});

test("request bodies over 16 KB return a structured 413 response", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "x".repeat(17_000) }),
    });
    const body = (await response.json()) as ErrorResponse;

    assert.equal(response.status, 413);
    assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  });
});

test("strict route validation rejects managed job fields", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "unsafe-job",
        workloadType: "SLEEP",
        cpuRequiredMillicores: 500,
        memoryRequiredMiB: 128,
        estimatedDurationSeconds: 1,
        priority: 5,
        command: "whoami",
      }),
    });
    const body = (await response.json()) as ErrorResponse;

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });
});
