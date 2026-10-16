import assert from "node:assert/strict";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

const tsx = new URL("../../../node_modules/.bin/tsx", import.meta.url);
const serverEntry = new URL("../src/server.ts", import.meta.url);

async function getAvailablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

test("SIGTERM closes the API workers and exits successfully", async () => {
  const port = await getAvailablePort();
  const child = spawn(
    process.execPath,
    [tsx.pathname, serverEntry.pathname],
    {
      env: {
        ...process.env,
        STELLAR_TESTNET_SECRET_KEY: Keypair.random().secret(),
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_PATH: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });

  const waitForListening = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15_000);
    const checkOutput = (chunk: string) => {
      if (chunk.includes("Server listening on")) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on("data", checkOutput);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`server exited before listening (code=${code}, signal=${signal}):\n${output}`));
    });
  });

  let stopTimeout: ReturnType<typeof setTimeout> | undefined;
  let delayedRequest: ReturnType<typeof request> | undefined;
  try {
    await waitForListening;

    // Keep a real request in the body parser while shutdown starts. The
    // server must stop accepting new requests but allow this request to drain.
    let resolveResponse!: (status: number) => void;
    let rejectResponse!: (error: Error) => void;
    const response = new Promise<number>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    delayedRequest = request(
      { host: "127.0.0.1", port, path: "/agents", method: "POST", headers: { "Content-Length": "2" } },
      (res) => {
        res.resume();
        res.once("end", () => resolveResponse(res.statusCode ?? 0));
      }
    );
    delayedRequest.once("error", rejectResponse);
    delayedRequest.write("{");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, "shutdown must wait for the active request");
    delayedRequest.end("}");
    assert.equal(await response, 400, "the active request should finish normally");

    const exitTimeout = new Promise<never>((_, reject) => {
      stopTimeout = setTimeout(() => reject(new Error(`server did not stop:\n${output}`)), 15_000);
    });
    const [code, signal] = await Promise.race([exit, exitTimeout]);

    assert.equal(signal, null);
    assert.equal(code, 0, output);
    assert.match(output, /\[4evergent\] SIGTERM received — shutting down/);
    assert.match(output, /\[scheduler\] stopped/);
    assert.match(output, /\[execution-queue\] stopped/);
    assert.match(output, /\[reconciler\] stopped/);
    assert.match(output, /\[4evergent\] Shutdown complete/);
  } finally {
    if (stopTimeout) clearTimeout(stopTimeout);
    delayedRequest?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
