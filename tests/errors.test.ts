import assert from "node:assert/strict";
import test from "node:test";
import { AppError, redactSecrets, safeErrorMessage } from "../src/errors.js";

test("error output masks named credentials, authorization, URLs and terminal controls", () => {
  const message = redactSecrets("apiKey=private-value token='another-value' https://user:password@example.test/path?access_token=token-value&ok=1 Bearer bearer-value\n\x1b[31mnext line");
  for (const secret of ["private-value", "another-value", "user:password", "token-value", "bearer-value", "\x1b", "\n"]) {
    assert.equal(message.includes(secret), false);
  }
  assert.ok(message.includes("[masqué]"));
  assert.ok(message.includes("ok=1"));
});

test("known API key is masked even when not labelled or URL encoded", (context) => {
  const previous = process.env.ODDS_API_KEY;
  context.after(() => {
    if (previous === undefined) delete process.env.ODDS_API_KEY;
    else process.env.ODDS_API_KEY = previous;
  });
  const key = "fake/private+key-for-redaction";
  process.env.ODDS_API_KEY = key;
  const message = safeErrorMessage(new Error(`Failure ${key} ${encodeURIComponent(key)}`));
  assert.equal(message.includes(key), false);
  assert.equal(message.includes(encodeURIComponent(key)), false);
});

test("unknown thrown values have safe fallbacks without invoking arbitrary conversion", () => {
  const hostile = { toString() { throw new Error("must not be called"); } };
  for (const value of [null, undefined, hostile, { message: "private object details" }, 42]) {
    assert.equal(safeErrorMessage(value, "Action impossible."), "Action impossible.");
  }
  assert.equal(safeErrorMessage("Simple failure"), "Simple failure");
  assert.equal(safeErrorMessage(new Error(" "), "Action impossible."), "Action impossible.");
});

test("controlled errors retain their diagnostic cause while exposing a safe message and code", () => {
  const cause = new Error("internal transport details");
  const error = new AppError("SOURCE_FAILED", "Connexion impossible apiKey=fake-secret", { cause });
  assert.equal(error.code, "SOURCE_FAILED");
  assert.equal(error.cause, cause);
  assert.equal(error.message.includes("fake-secret"), false);
  assert.equal(error.message.includes("internal transport details"), false);
  assert.equal(new AppError("invalid code", "Message.").code, "INTERNAL_ERROR");
});
