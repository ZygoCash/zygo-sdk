import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as webhooks from "../dist/webhooks.js";

const SECRET = "whsec_testsecret";
const BODY = JSON.stringify({ event_type: "escrow.released", order: "ord_1" });
const sign = (body, secret) =>
  "sha256=" + createHmac("sha256", secret).update(body, "utf8").digest("hex");

test("valid signature verifies and parses the event", () => {
  const res = webhooks.verify(BODY, sign(BODY, SECRET), SECRET);
  assert.ok(res.isOk());
  assert.equal(res.value.event_type, "escrow.released");
});

test("tampered body is rejected", () => {
  const res = webhooks.verify(BODY + " ", sign(BODY, SECRET), SECRET);
  assert.ok(res.isErr());
  assert.equal(res.error.code, "WEBHOOK_AUTH_FAILED");
});

test("wrong secret is rejected", () => {
  const res = webhooks.verify(BODY, sign(BODY, "whsec_other"), SECRET);
  assert.ok(res.isErr());
});

test("garbage signature does not throw", () => {
  assert.ok(webhooks.verify(BODY, "not-a-signature", SECRET).isErr());
  assert.ok(webhooks.verify(BODY, "", SECRET).isErr());
});

test("valid signature but invalid JSON body errors as BAD_PAYLOAD", () => {
  const res = webhooks.verify("{nope", sign("{nope", SECRET), SECRET);
  assert.ok(res.isErr());
  assert.equal(res.error.code, "BAD_PAYLOAD");
});
