import assert from "node:assert/strict";

const { bearerToken, parseCodexUsage, parseKimiUsage, usageColor } = await import(
  "./extensions/usage-status.ts"
);

// API-key auth wins; headers-only OAuth (kimi-coding) falls back to Bearer.
assert.equal(bearerToken({ apiKey: "key" }), "key");
assert.equal(bearerToken({ headers: { Authorization: "Bearer oauth-token" } }), "oauth-token");
assert.equal(bearerToken({ headers: { Authorization: "Basic xyz" } }), undefined);
assert.equal(bearerToken(undefined), undefined);

const now = 1_786_000_000_000;

// Standard Codex plan: 5h primary + weekly secondary.
assert.deepEqual(parseCodexUsage({
  rate_limit: {
    primary_window: { used_percent: 23, reset_after_seconds: 7200 },
    secondary_window: { used_percent: 61, reset_after_seconds: 400000 },
  },
}, now), {
  session: { percent: 23, resetsAtMs: now + 7_200_000 },
  sessionLabel: "5h",
  weekly: { percent: 61, resetsAtMs: now + 400_000_000 },
});

// Pro Lite exposes the weekly window as the only primary window.
assert.deepEqual(parseCodexUsage({
  rate_limit: {
    primary_window: { used_percent: 71, reset_after_seconds: 511632, limit_window_seconds: 604800 },
    secondary_window: null,
  },
}, now), {
  session: { percent: 71, resetsAtMs: now + 511_632_000 },
  sessionLabel: "7d",
});

// Kimi returns rolling windows in no guaranteed order; root usage is account-wide.
assert.deepEqual(parseKimiUsage({
  usage: { limit: "100", used: "14.15", resetTime: "2026-08-29T00:00:00.000Z" },
  limits: [
    { window: { duration: 10080, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "67.46", resetTime: "2026-08-05T14:12:00.000Z" } },
    { window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "0.22", resetTime: "2026-07-31T11:12:00.000Z" } },
  ],
}, now), {
  session: { percent: 0.22, resetsAtMs: Date.parse("2026-07-31T11:12:00.000Z") },
  sessionLabel: "5h",
  weekly: { percent: 67.46, resetsAtMs: Date.parse("2026-08-05T14:12:00.000Z") },
});

assert.throws(() => parseKimiUsage({}), /unrecognized response shape/);

assert.equal(usageColor(0), "success");
assert.equal(usageColor(50), "success");
assert.equal(usageColor(51), "warning");
assert.equal(usageColor(75), "warning");
assert.equal(usageColor(76), "error");

console.log("usage-status tests passed");
