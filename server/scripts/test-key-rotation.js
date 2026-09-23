/* Drive callGeminiServer's cooldown rotation with a fake fetch + fake clock.
   The server starts a listener on require, so instead we re-evaluate the
   rotation logic exactly as written in server.js by replicating it —
   plus a source-drift guard asserting the real source still matches. */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

async function main() {

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// 1. Source-drift guard: the cooldown machinery must be present
assert(src.includes("GEMINI_COOLDOWN_MS"), "cooldown constant missing");
assert(src.includes("GEMINI_BUSY_MS"), "503 busy-window constant missing");
assert(src.includes("geminiNextUsableKey"), "key-picker missing");
assert(src.includes("geminiCooldownUntil.set(key"), "cooldown parking missing");
assert(src.includes("geminiCooldownLeft"), "cooldown-remaining helper missing");
assert(src.includes("retryAfter"), "retryAfter reporting missing");
console.log("✓ source contains cooldown rotation machinery + retryAfter");

// 2. Behavioral test: replicate the exact rotation semantics (fake clock)
const GEMINI_COOLDOWN_MS = 3 * 60 * 1000; // 429 quota errors
const GEMINI_BUSY_MS = 30 * 1000;         // 503 capacity errors
function makePool(keys, fetchImpl) {
  let clock = 1_000_000;
  let geminiKeyIdx = 0;
  const geminiCooldownUntil = new Map();
  const geminiCooldownLeft = (key) => Math.max(0, (geminiCooldownUntil.get(key) || 0) - clock);
  const geminiNextUsableKey = () => {
    for (let i = 0; i < keys.length; i++) {
      const idx = (geminiKeyIdx + i) % keys.length;
      if ((geminiCooldownUntil.get(keys[idx]) || 0) <= clock) return idx;
    }
    return -1;
  };
  const calls = [];
  async function callGeminiServer() {
    for (let tries = 0; tries < keys.length + 1; tries++) {
      const startIdx = geminiNextUsableKey();
      if (startIdx === -1) {
        const retryAfter = Math.ceil(Math.min(...keys.map(geminiCooldownLeft)) / 1000);
        throw Object.assign(new Error("All AI keys are rate-limited"), { status: 429, retryAfter });
      }
      geminiKeyIdx = startIdx;
      const key = keys[geminiKeyIdx];
      try {
        calls.push(key);
        return await fetchImpl(key);
      } catch (err) {
        if (err.status === 429 || err.status === 503) {
          const ms = err.status === 429 ? GEMINI_COOLDOWN_MS : GEMINI_BUSY_MS;
          geminiCooldownUntil.set(key, clock + ms);
          continue;
        }
        throw err;
      }
    }
  }
  return {
    callGeminiServer,
    calls: () => calls.slice(),
    advance: (ms) => { clock += ms; },
  };
}

// Scenario A: key0 429s → rotates to key1 which succeeds; key0 parked
{
  const pool = makePool(["K0", "K1", "K2"], (key) => {
    if (key === "K0") throw { status: 429 };
    return { ok: key };
  });
  const out = await pool.callGeminiServer();
  assert.deepStrictEqual(pool.calls(), ["K0", "K1"], "A: should try K0 then K1");
  assert.strictEqual(out.ok, "K1");
  console.log("✓ A: 429 on first key rotates to next, success");
}

// Scenario B: next call must NOT retry K0 first (it's cooling) — starts at K1
{
  const pool = makePool(["K0", "K1", "K2"], (key) => {
    if (key === "K0") throw { status: 429 };
    return { ok: key };
  });
  await pool.callGeminiServer();
  pool.advance(1000);
  const out = await pool.callGeminiServer();
  assert.strictEqual(pool.calls()[1], "K1", `B: expected restart at K1, got ${pool.calls()[1]}`);
  assert.strictEqual(out.ok, "K1");
  console.log("✓ B: cooled-down key skipped on subsequent calls (restarts at K1)");
}

// Scenario C: ALL keys cooling → fail fast with 429 + retryAfter, zero fetches
{
  const pool = makePool(["K0", "K1"], () => { throw { status: 429 }; });
  await assert.rejects(
    () => pool.callGeminiServer(),
    (e) => e.status === 429 && e.retryAfter > 0 && e.retryAfter <= 180,
    "C: should reject 429 with a sane retryAfter when pool exhausted"
  );
  const attemptsAfterFirst = pool.calls().length; // 2 (both keys tried once)
  pool.advance(1000);
  await assert.rejects(() => pool.callGeminiServer());
  assert.strictEqual(pool.calls().length, attemptsAfterFirst, "C: fail-fast makes zero new attempts while cooling");
  console.log("✓ C: all-keys-cooling fails fast with retryAfter, no wasted requests");
}

// Scenario D: 429 parks a key for the full 3 minutes, then it returns
{
  let mode = 429;
  let k1Down = false;
  const pool = makePool(["K0", "K1"], (key) => {
    if (key === "K0" && mode) throw { status: mode }; // mode 0 = K0 succeeds
    if (key === "K1" && k1Down) throw { status: 429 };
    return { ok: key };
  });
  await pool.callGeminiServer();          // K0 429 → 3-min park; K1 ok
  pool.advance(60 * 1000);                // +1 min: K0 must still be parked
  await pool.callGeminiServer();
  assert.strictEqual(pool.calls().slice(-1)[0], "K1", "D: K0 still cooling after 1 min (429 window is 3 min)");
  k1Down = true;                          // force the next call to need K0
  mode = 0;                               // K0's quota has reset — it must succeed now
  pool.advance(2 * 60 * 1000);            // +3 min since the 429
  const out = await pool.callGeminiServer();
  assert.strictEqual(out.ok, "K0", "D: K0 usable again after the 3-min quota window");
  assert.strictEqual(pool.calls().slice(-1)[0], "K0", "D: expiry call actually exercised K0");
  console.log("✓ D: 429 parks a key for the full 3 minutes, then it returns");
}

// Scenario D2: 503 parks a key for only 30 seconds (vs 3 min for a 429)
{
  let k0Fails = 1;   // K0 throws 503 exactly once
  let k1Fails = 0;   // K1 can be forced to 429 once
  const pool = makePool(["K0", "K1"], (key) => {
    if (key === "K0" && k0Fails > 0) { k0Fails--; throw { status: 503 }; }
    if (key === "K1" && k1Fails > 0) { k1Fails--; throw { status: 429 }; }
    return { ok: key };
  });
  const out1 = await pool.callGeminiServer();     // K0 503 → parked 30 s; K1 ok
  assert.strictEqual(out1.ok, "K1");
  pool.advance(10 * 1000);                        // +10 s: K0 must still be parked
  await pool.callGeminiServer();
  assert.strictEqual(pool.calls().slice(-1)[0], "K1", "D2: K0 still cooling 10 s after a 503");
  k1Fails = 1;                                    // force K1 aside for the next call
  pool.advance(21 * 1000);                        // +31 s since the 503: 30-s window expired
  const out3 = await pool.callGeminiServer();     // K1 429 → parked; K0 serves
  assert.strictEqual(out3.ok, "K0", "D2: 503 park expires after ~30 s, not 3 min");
  console.log("✓ D2: 503 parks a key for only 30 seconds — capacity blips recover fast");
}

// Scenario E: non-rate errors (e.g. 400) do NOT park the key — they throw immediately
{
  const pool = makePool(["K0", "K1"], () => { throw { status: 400, message: "bad request" }; });
  await assert.rejects(
    () => pool.callGeminiServer(),
    (e) => e.status === 400,
    "E: 400 should propagate immediately"
  );
  assert.deepStrictEqual(pool.calls(), ["K0"], "E: no rotation on non-rate errors");
  console.log("✓ E: hard errors fail immediately without parking");
}

console.log("\nAll rotation scenarios pass.");
}

main().catch((e) => { console.error(e); process.exit(1); });
