import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { Keypair } from "@stellar/stellar-sdk";

const tsx = new URL("../../../node_modules/.bin/tsx", import.meta.url);
const serverEntry = new URL("../src/server.ts", import.meta.url);

test("SIGTERM closes the API workers and exits successfully", async () => {
  const child = spawn(
    process.execPath,
    [tsx.pathname, serverEntry.pathname],
    {
      env: {
        ...process.env,
        STELLAR_TESTNET_SECRET_KEY: Keypair.random().secret(),
        HOST: "127.0.0.1",
        PORT: "0",
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
  try {
    await waitForListening;
    child.kill("SIGTERM");
    const exit = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
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
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
