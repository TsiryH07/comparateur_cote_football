import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

/** Small DOM surface for testing network outcomes without a framework or a browser. */
class NodeStub {
  textContent = "";
  value = "";
  valueAsNumber = 10;
  checked = true;
  hidden = true;
  disabled = false;
  title = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  parentElement: NodeStub | null = null;
  listeners = new Map<string, (...args: any[]) => unknown>();
  classes = new Set<string>();
  classList = {
    add: (value: string) => { this.classes.add(value); },
    remove: (value: string) => { this.classes.delete(value); },
    toggle: (value: string, on: boolean) => { if (on) this.classes.add(value); else this.classes.delete(value); },
  };
  append(..._children: unknown[]) {}
  prepend(..._children: unknown[]) {}
  replaceChildren(..._children: unknown[]) {}
  setAttribute(_key: string, _value: string) {}
  removeAttribute(_key: string) {}
  // Simule une partie de la page.
  querySelector(_selector: string): NodeStub | null { return null; }
  // Simule une partie de la page.
  closest(_selector: string): NodeStub | null { return null; }
  // Prépare un exemple de match pour les tests.
  addEventListener(event: string, listener: (...args: any[]) => unknown) { this.listeners.set(event, listener); }
  focus() {}
}

// Prépare les éléments nécessaires au test.
const dashboardState = (latestCycle: unknown = null) => ({
  dataSource: "mock", settings: { threshold: { mode: "percentage", value: 10 }, automatic: false, intervalMinutes: 10 },
  sources: ["test-source"], latestCycle, collecting: false, nextRunAt: null, lastError: null,
});
// Prépare un exemple de collecte.
const cycle = (count: number, errors: unknown[]) => ({
  startedAt: "2026-10-17T12:00:00.000Z", finishedAt: "2026-10-17T12:00:01.000Z",
  collectedCount: count, rejectedCount: 0, skippedCount: 0, errors, alerts: [],
  events: count === 0 ? [] : [{
    id: "test-event", homeTeam: "A", awayTeam: "B", competition: "Test", startsAt: "2026-10-18T12:00:00.000Z",
    quotes: [{ sourceMatchId: "test-match", source: "test-source", homeTeam: "A", awayTeam: "B", competition: "Test",
      startsAt: "2026-10-18T12:00:00.000Z", collectedAt: "2026-10-17T12:00:00.000Z", odds: { "1": 2, X: 3, "2": 4 } }],
  }],
});

type Reply = { status?: number; payload?: unknown; text?: string } | Error;
// Prépare un historique pour les tests.
async function browser(replies: Reply[]) {
  const nodes = new Map<string, NodeStub>();
  const node = (id: string) => {
    let value = nodes.get(id);
    if (!value) { value = new NodeStub(); nodes.set(id, value); }
    return value;
  };
  node("history-limit").value = "50";
  const intervals: (() => unknown)[] = [];
  const events = new Map<string, () => unknown>();
  runInNewContext(script, {
    document: { readyState: "complete", hidden: false, getElementById: node, querySelectorAll: () => [],
      createElement: () => new NodeStub(), createDocumentFragment: () => new NodeStub(),
      createTextNode: (text: string) => text, addEventListener: () => {} },
    window: { addEventListener: (name: string, listener: () => unknown) => events.set(name, listener) },
    navigator: { onLine: true }, Intl, Date, Map, Set, Error, TypeError, AbortController,
    Option: class extends NodeStub { constructor(label: string, value: string) { super(); this.textContent = label; this.value = value; } },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: (listener: () => unknown) => intervals.push(listener),
    fetch: async () => {
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected test request");
      if (reply instanceof Error) throw reply;
      const status = reply.status ?? 200;
      return { ok: status >= 200 && status < 300, status, text: async () => reply.text ?? JSON.stringify(reply.payload) };
    },
  });
  const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve)); };
  await settle();
  const click = async (id: string) => { await node(id).listeners.get("click")?.(); await settle(); };
  const poll = async () => { intervals[0]?.(); await settle(); };
  return { node, click, poll, events, replies, settle };
}

test("the dashboard shows a persistent server outage and its retry recovers the controls", async () => {
  const app = await browser([new TypeError("fetch failed"), { payload: dashboardState() }]);
  assert.equal(app.node("service-notice").hidden, false);
  assert.match(app.node("service-message").textContent, /Impossible de joindre le service/);
  assert.equal(app.node("collect-button").disabled, true);
  assert.equal(app.node("service-retry").disabled, false);
  await app.click("service-retry");
  assert.equal(app.node("service-notice").hidden, true);
  assert.equal(app.node("collect-button").disabled, false);
  assert.equal(app.node("connection-label").textContent, "Connecté");
});

test("invalid JSON and malformed successful payloads preserve old data with an explicit stale notice", async () => {
  const old = dashboardState(cycle(1, []));
  const app = await browser([{ payload: old }, { text: "<html>proxy down</html>" }, { payload: { latestCycle: {} } }, { payload: old }]);
  assert.equal(app.node("stats-matches").textContent, "1");
  await app.poll();
  assert.match(app.node("service-message").textContent, /réponse illisible/);
  assert.match(app.node("last-updated").textContent, /Données non actualisées/);
  assert.equal(app.node("stats-matches").textContent, "1");
  await app.poll();
  assert.match(app.node("service-message").textContent, /données incomplètes/);
  assert.equal(app.node("overview-view").dataset.stale, "true");
  await app.poll();
  assert.equal(app.node("service-notice").hidden, true);
  assert.equal(app.node("overview-view").dataset.stale, "false");
});

test("complete and partial collector failures never produce an unqualified success toast", async () => {
  for (const count of [0, 1]) {
    const app = await browser([{ payload: dashboardState() },
      { payload: dashboardState(cycle(count, [{ source: "test-source", message: "Source indisponible." }])) },
      { payload: { history: [] } }]);
    await app.click("collect-button");
    assert.equal(app.node("toast").classes.has("error"), true);
    assert.match(app.node("toast").textContent, count === 0 ? /collecte a échoué/ : /Collecte partielle/);
    assert.equal(app.node("service-notice").hidden, false);
    assert.equal(app.node("collect-button").disabled, false);
    assert.equal(app.node("service-retry").disabled, false);
  }
});

test("a server-reported failed save stays visible after successful polling and can be retried", async () => {
  const state = dashboardState(cycle(1, []));
  const failedState = { ...state, lastError: { code: "DATABASE_FULL", message: "Le disque est plein." } };
  const app = await browser([{ payload: state }, { payload: failedState }, { payload: state }, { payload: { history: [] } }]);
  await app.poll();
  assert.match(app.node("service-message").textContent, /Le disque est plein/);
  assert.match(app.node("last-updated").textContent, /tentative en échec/);
  assert.equal(app.node("service-retry").textContent, "Relancer une collecte");
  await app.click("service-retry");
  assert.equal(app.node("service-notice").hidden, true);
  assert.equal(app.node("collect-button").disabled, false);
});

test("an aborted request restores loading controls and explains that collection can continue", async () => {
  const timeout = new Error("aborted");
  timeout.name = "AbortError";
  const app = await browser([{ payload: dashboardState() }, timeout]);
  await app.click("collect-button");
  assert.match(app.node("service-message").textContent, /collecte peut continuer/);
  assert.equal(app.node("collect-button").disabled, false);
  assert.equal(app.node("service-retry").disabled, false);
  assert.equal(app.node("collect-button").classes.has("is-loading"), false);
});

test("malformed history stays flagged until a successful history retry", async () => {
  const app = await browser([{ payload: dashboardState() }, { payload: { history: [{}] } },
    { payload: dashboardState() }, { payload: { history: [] } }]);
  await app.click("history-refresh");
  assert.equal(app.node("history-refresh").disabled, false);
  assert.equal(app.node("history-view").dataset.stale, "true");
  assert.equal(app.node("service-notice").hidden, false);
  await app.click("service-retry");
  assert.equal(app.node("history-view").dataset.stale, "false");
  assert.equal(app.node("service-notice").hidden, true);
});

test("an offline event exposes a persistent notice and reconnecting fetches fresh state", async () => {
  const app = await browser([{ payload: dashboardState() }, { payload: dashboardState() }]);
  app.events.get("offline")?.();
  assert.equal(app.node("service-notice").hidden, false);
  assert.match(app.node("service-message").textContent, /hors ligne/);
  assert.equal(app.node("connection-label").textContent, "Connexion interrompue");
  app.events.get("online")?.();
  await app.settle();
  assert.equal(app.node("service-notice").hidden, true);
  assert.equal(app.node("connection-label").textContent, "Connecté");
});
