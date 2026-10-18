import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverCollectors, JsonFileCollector } from "../src/collectors/mock.js";
import { normalizeMatch } from "../src/services/normalize.js";
import { AppError } from "../src/errors.js";

const now = new Date("2026-10-17T13:30:00Z");
// Prépare les éléments nécessaires au test.
const context = () => ({ now, signal: new AbortController().signal });
const record = {
  sourceMatchId: "a-1", homeTeam: "PSG", awayTeam: "Marseille", competition: "Ligue 1",
  schedule: { dayOffset: 1, time: "18:00:00Z" }, odds: { "1": 1.8, X: 3.6, "2": 4.5 },
};

test("un troisième fichier suffit pour ajouter une source et les fichiers sont relus", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-mock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(["a", "b", "c"].map((name) => writeFile(join(directory, `${name}.json`), JSON.stringify([record]))));
  await writeFile(join(directory, "notes.txt"), "ignoré");
  const collectors = await discoverCollectors(directory);
  assert.deepEqual(collectors.map((collector) => collector.name), ["a", "b", "c"]);
  const first = normalizeMatch((await collectors[0]!.collect(context()))[0], "a", now);
  assert.equal(first.startsAt, "2026-10-18T18:00:00.000Z");
  const laterContext = { ...context(), now: new Date("2026-10-17T23:59:00Z") };
  assert.deepEqual(await collectors[0]!.collect(laterContext), await collectors[0]!.collect(context()));
  await writeFile(join(directory, "a.json"), JSON.stringify([{ ...record, odds: { "1": 2.1, X: 3.6, "2": 4.5 } }]));
  const updated = normalizeMatch((await collectors[0]!.collect(context()))[0], "a", now);
  assert.equal(updated.odds["1"], 2.1);
});

test("dates absolues conservées ; calendrier relatif correct en fin d'année", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-dates-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "source.json");
  const startsAt = "2028-02-29T21:00:00+03:00";
  await writeFile(file, JSON.stringify([{ ...record, startsAt }, record]));
  const collector = new JsonFileCollector("source", file);
  const rows = await collector.collect({ ...context(), now: new Date("2026-12-31T23:59:00Z") });
  assert.equal(normalizeMatch(rows[0], "source", now).startsAt, "2028-02-29T18:00:00.000Z");
  assert.equal(normalizeMatch(rows[1], "source", now).startsAt, "2027-01-01T18:00:00.000Z");
});

test("une ligne relative invalide n'empêche pas la lecture des autres lignes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-invalid-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "source.json");
  await writeFile(file, `\uFEFF${JSON.stringify([{ ...record, schedule: { dayOffset: 1, time: "25:00:00Z" } }, record])}`);
  const rows = await new JsonFileCollector("source", file).collect(context());
  assert.equal(rows.length, 2);
  assert.throws(() => normalizeMatch(rows[0], "source", now));
  assert.doesNotThrow(() => normalizeMatch(rows[1], "source", now));
});

test("source absente, mauvais JSON, racine non tableau et dossier vide sont signalés", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(discoverCollectors(directory), /Aucune source/);
  const file = join(directory, "source.json");
  await assert.rejects(new JsonFileCollector("source", file).collect(context()), /ENOENT/);
  await writeFile(file, "{broken");
  await assert.rejects(new JsonFileCollector("source", file).collect(context()), (error: unknown) => error instanceof AppError && error.code === "MOCK_JSON_INVALID");
  await writeFile(file, "{}");
  await assert.rejects(new JsonFileCollector("source", file).collect(context()), /tableau JSON/);
});

test("les erreurs de dossier distinguent fichier et dossier absent avec une explication exploitable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-folder-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(discoverCollectors(join(directory, "missing")), (error: unknown) =>
    error instanceof AppError && error.code === "MOCK_DIRECTORY_MISSING" && error.message.includes("MOCK_DATA_DIR"));
  const file = join(directory, "source.json");
  await writeFile(file, "[]");
  await assert.rejects(discoverCollectors(file), (error: unknown) => error instanceof AppError && error.code === "MOCK_DIRECTORY_TYPE");
  await assert.rejects(new JsonFileCollector("source", directory).collect(context()), (error: unknown) =>
    error instanceof AppError && ["MOCK_FILE_TYPE", "MOCK_FILE_ACCESS"].includes(error.code));
});

test("le contenu JSON invalide et la raison d’annulation ne sont jamais exposés", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odds-safe-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "source.json");
  await writeFile(file, "{ fake-private-content-secret");
  const collector = new JsonFileCollector("source", file);
  await assert.rejects(collector.collect(context()), (error: Error) =>
    /JSON invalide/.test(error.message) && !error.message.includes("fake-private-content-secret"));
  const controller = new AbortController();
  controller.abort(new Error("fake-private-abort-secret"));
  await assert.rejects(collector.collect({ now, signal: controller.signal }), (error: Error) =>
    error.name === "AbortError" && !error.message.includes("fake-private-abort-secret"));
});

test("noms, chemins et dates de lecture invalides échouent avant la lecture du fichier", async () => {
  assert.throws(() => new JsonFileCollector(" ", "source.json"), /nom/i);
  assert.throws(() => new JsonFileCollector("source", " "), /chemin/i);
  await assert.rejects(discoverCollectors(" "), /MOCK_DATA_DIR/);
  await assert.rejects(new JsonFileCollector("source", "missing.json").collect({ ...context(), now: new Date(NaN) }), /date/i);
});
