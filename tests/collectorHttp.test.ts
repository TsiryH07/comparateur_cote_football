import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { AppError } from "../src/errors.js";
import { requestGet } from "../src/collectors/http.js";

const url = new URL("https://provider.example/odds?apiKey=fake-test-secret");
const messages = { network: "Connexion au fournisseur impossible après deux essais.", cancelled: "Collecte annulée." };

// Simule la réponse d’un site.
function fetcher(handler: (init: RequestInit | undefined) => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (_input: string | URL | Request, init?: RequestInit) => handler(init)) as typeof globalThis.fetch;
}

test("GET retries transient HTTP failures once, releases the first body, and preserves request options", async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const signal = new AbortController().signal;
    let calls = 0;
    let cancellations = 0;
    const response = await requestGet(fetcher((init) => {
      assert.equal(init?.method, "GET");
      assert.equal(init?.signal, signal);
      assert.equal(init?.redirect, "error");
      if (++calls === 1) return new Response(new ReadableStream({ cancel() { cancellations++; } }), { status });
      return Response.json(["recovered"]);
    }), url, { signal, redirect: "error" }, messages);
    assert.deepEqual(await response.json(), ["recovered"]);
    assert.equal(calls, 2);
    assert.equal(cancellations, 1);
  }
});

test("GET never retries authentication, quota, client or unsupported server errors", async () => {
  for (const status of [200, 400, 401, 403, 404, 429, 501]) {
    let calls = 0;
    const response = await requestGet(fetcher(() => {
      calls++;
      return new Response("ignored", { status });
    }), url, { signal: new AbortController().signal }, messages);
    assert.equal(response.status, status);
    assert.equal(calls, 1);
    await response.body?.cancel();
  }
});

test("a temporary network failure recovers, persistent failure stops after two safe attempts", async () => {
  for (const recovers of [true, false]) {
    let calls = 0;
    const pending = requestGet(fetcher(() => {
      calls++;
      if (recovers && calls === 2) return Response.json([]);
      throw new Error(`private transport details ${url.href}`);
    }), url, { signal: new AbortController().signal }, messages);
    if (recovers) assert.deepEqual(await (await pending).json(), []);
    else await assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "SOURCE_NETWORK");
      assert.equal(error.message, messages.network);
      assert.equal(inspect(error).includes("fake-test-secret"), false);
      assert.equal(inspect(error).includes("provider.example"), false);
      return true;
    });
    assert.equal(calls, 2);
  }
});

test("aborting retry backoff prevents a second request and never exposes the abort reason", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = requestGet(fetcher(() => {
      calls++;
      timer = setTimeout(() => controller.abort(new Error("fake-test-secret")), 20);
      throw new Error("temporary transport failure");
    }), url, { signal: controller.signal }, messages);
    await assert.rejects(pending, (error: Error) => error.name === "AbortError" && !inspect(error).includes("fake-test-secret"));
    assert.equal(calls, 1);
  } finally { clearTimeout(timer); }
});

test("an already cancelled GET never fetches", async () => {
  const controller = new AbortController();
  controller.abort(new Error("fake-test-secret"));
  let calls = 0;
  await assert.rejects(requestGet(fetcher(() => {
    calls++; return Response.json([]);
  }), url, { signal: controller.signal }, messages), (error: Error) => error.name === "AbortError" && !inspect(error).includes("fake-test-secret"));
  assert.equal(calls, 0);
});
