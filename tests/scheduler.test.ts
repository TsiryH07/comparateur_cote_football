import assert from "node:assert/strict";
import test from "node:test";
import { runScheduler } from "../src/scheduler.js";

// Prépare les éléments nécessaires au test.
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

test("runs immediately and waits the configured interval before another cycle", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let cycles = 0;
  const running = runScheduler(
    async () => {
      cycles += 1;
      if (cycles === 2) controller.abort();
    },
    { intervalMs: 600_000, signal: controller.signal },
  );

  assert.equal(cycles, 1);
  await flushMicrotasks();
  context.mock.timers.tick(599_999);
  await flushMicrotasks();
  assert.equal(cycles, 1);

  context.mock.timers.tick(1);
  await running;
  assert.equal(cycles, 2);
});

test("waits for the active cycle before starting the interval", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let releaseCycle!: () => void;
  const firstCycle = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  let cycles = 0;
  const running = runScheduler(
    async () => {
      cycles += 1;
      if (cycles === 1) await firstCycle;
      else controller.abort();
    },
    { intervalMs: 10, signal: controller.signal },
  );

  context.mock.timers.tick(1_000);
  await flushMicrotasks();
  assert.equal(cycles, 1);

  releaseCycle();
  await flushMicrotasks();
  context.mock.timers.tick(9);
  await flushMicrotasks();
  assert.equal(cycles, 1);

  context.mock.timers.tick(1);
  await running;
  assert.equal(cycles, 2);
});

test("reports a failed cycle and continues on the next interval", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const failure = new Error("source unavailable");
  const errors: unknown[] = [];
  let cycles = 0;
  const running = runScheduler(
    async () => {
      cycles += 1;
      if (cycles === 1) throw failure;
      controller.abort();
    },
    {
      intervalMs: 10,
      signal: controller.signal,
      onError: (error) => errors.push(error),
    },
  );

  await flushMicrotasks();
  assert.deepEqual(errors, [failure]);
  context.mock.timers.tick(10);
  await running;
  assert.equal(cycles, 2);
});

test("aborting during a wait stops without starting another cycle", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  let cycles = 0;
  const running = runScheduler(
    async () => {
      cycles += 1;
    },
    { intervalMs: 600_000, signal: controller.signal },
  );

  await flushMicrotasks();
  controller.abort();
  await running;
  context.mock.timers.tick(600_000);
  await flushMicrotasks();
  assert.equal(cycles, 1);
});

test("aborting during a cycle waits for that cycle to finish", async () => {
  const controller = new AbortController();
  let releaseCycle!: () => void;
  const activeCycle = new Promise<void>((resolve) => {
    releaseCycle = resolve;
  });
  let finished = false;
  let cycles = 0;
  const running = runScheduler(
    async () => {
      cycles += 1;
      await activeCycle;
    },
    { intervalMs: 10, signal: controller.signal },
  ).then(() => {
    finished = true;
  });

  controller.abort();
  await flushMicrotasks();
  assert.equal(finished, false);

  releaseCycle();
  await running;
  assert.equal(finished, true);
  assert.equal(cycles, 1);
});

test("an already aborted signal prevents the first cycle", async () => {
  let cycles = 0;
  await runScheduler(
    async () => {
      cycles += 1;
    },
    { intervalMs: 10, signal: AbortSignal.abort() },
  );
  assert.equal(cycles, 0);
});

test("rejects intervals unsupported by Node timers", async () => {
  for (const intervalMs of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    await assert.rejects(
      runScheduler(async () => {}, { intervalMs, signal: AbortSignal.abort() }),
      RangeError,
    );
  }
});

test("a rejected error reporter does not prevent the next cycle", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const logs: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const controller = new AbortController();
  let cycles = 0;
  const running = runScheduler(async () => {
    cycles++;
    if (cycles === 1) throw new Error("source temporarily unavailable");
    controller.abort();
  }, {
    intervalMs: 10, signal: controller.signal,
    onError: async () => { throw new Error("reporter unavailable apiKey=fake-private-key"); },
  });
  await flushMicrotasks();
  context.mock.timers.tick(10);
  await running;
  assert.equal(cycles, 2);
  assert.equal(logs.length, 2);
  assert.equal(JSON.stringify(logs).includes("fake-private-key"), false);
});
