import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createZygo } from "../dist/index.js";

// The http layer uses global fetch; stub it per test.
const realFetch = globalThis.fetch;
let calls;
let queue;

beforeEach(() => {
  calls = [];
  queue = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = queue.length ? queue.shift() : { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers ?? {},
    });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const zygo = () =>
  createZygo({ apiKey: "zygo_c_test:zygo_s_test", baseUrl: "http://localhost:1" });

test("sends X-Api-Key and parses the response", async () => {
  queue.push({ status: 200, body: [{ asset_id: "a1", symbol: "USDC" }] });
  const res = await zygo().quotes.listAssets();
  assert.ok(res.isOk());
  assert.equal(res.value[0].symbol, "USDC");
  assert.equal(calls[0].opts.headers["X-Api-Key"], "zygo_c_test:zygo_s_test");
});

test("mutations carry an Idempotency-Key", async () => {
  queue.push({ status: 200, body: { order_id: "o1", current_state: "quoted" } });
  await zygo().orders.create({ quoteId: "q1" });
  assert.ok(calls[0].opts.headers["Idempotency-Key"]);
});

test("retries on 429 and honors Retry-After", async () => {
  queue.push({ status: 429, body: { message: "slow down", code: "RATE_LIMITED" }, headers: { "Retry-After": "0" } });
  queue.push({ status: 200, body: { order_id: "o1" } });
  const res = await zygo().orders.get("o1");
  assert.ok(res.isOk());
  assert.equal(calls.length, 2);
});

test("does not retry 4xx errors", async () => {
  queue.push({ status: 403, body: { message: "nope", code: "INSUFFICIENT_SCOPE" } });
  const res = await zygo().orders.get("o1");
  assert.ok(res.isErr());
  assert.equal(res.error.code, "INSUFFICIENT_SCOPE");
  assert.equal(res.error.httpStatus, 403);
  assert.equal(res.error.retryable, false);
  assert.equal(calls.length, 1);
});

test("gives up after max attempts on persistent 500", async () => {
  const res = await zygo().orders.get("o1"); // queue empty → 500 default? no: default 200. push 500s
  assert.ok(res.isOk()); // default 200 sanity
  queue.push(
    { status: 500, body: {} },
    { status: 500, body: {} },
    { status: 500, body: {} },
    { status: 500, body: {} },
    { status: 500, body: {} }
  );
  const res2 = await zygo().orders.get("o1");
  assert.ok(res2.isErr());
  assert.equal(res2.error.httpStatus, 500);
  assert.equal(calls.length, 5); // 1 from sanity call + 4 attempts
});

test("createZygo rejects malformed keys", () => {
  assert.throws(() => createZygo({ apiKey: "no-colon" }), /client_id:secret/);
});
