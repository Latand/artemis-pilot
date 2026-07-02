// WP18: pure-Node smoke for the WebXR dynamic-resolution controller in
// src/render/xrPerf.js. Feeds synthetic frame-time series through
// feedFrameTime() — no renderer/DOM involved — and asserts:
//   - step-down under sustained overload
//   - step-up only after sustained headroom (hysteresis / no oscillation)
//   - floor (0.7) and ceiling (1.0) are respected
//   - a comfortable middle band (neither overloaded nor underloaded) never steps
globalThis.window = {};

const {
  createResController, feedFrameTime, targetMsFromSession,
  SCALE_FLOOR, SCALE_CEIL, STEP, WINDOW, DWELL_OVERLOAD_MS, DWELL_UNDERLOAD_MS,
} = await import("../src/render/xrPerf.js");

function assert(cond, msg) {
  if (!cond) throw new Error("smoke-xrperf FAILED: " + msg);
}

const HZ = 90;
const TARGET_MS = 1000 / HZ; // ~11.11ms

// targetMsFromSession: live frameRate wins, then supportedFrameRates, then fallback.
assert(Math.abs(targetMsFromSession({ frameRate: 120 }) - 1000 / 120) < 1e-9,
  "targetMsFromSession should use session.frameRate when present");
assert(Math.abs(targetMsFromSession({ supportedFrameRates: [72, 90, 120] }) - 1000 / 120) < 1e-9,
  "targetMsFromSession should use the highest supportedFrameRates entry as fallback");
assert(Math.abs(targetMsFromSession({}) - 1000 / 90) < 1e-9,
  "targetMsFromSession should fall back to 90 Hz with no session info");
assert(Math.abs(targetMsFromSession(null, 72) - 1000 / 72) < 1e-9,
  "targetMsFromSession should respect an explicit fallbackHz");

function feedFor(state, dtMs, ms, allowStep = true) {
  let t = 0, lastChanged = false;
  while (t < ms) {
    lastChanged = feedFrameTime(state, dtMs, TARGET_MS, allowStep) || lastChanged;
    t += dtMs;
  }
  return lastChanged;
}

// --- warm-up: must not step before the window holds WINDOW frames ----------
{
  const s = createResController();
  const overloadDt = TARGET_MS * 2; // way over budget
  // feed exactly WINDOW-1 overloaded frames — still warming, must not step
  for (let i = 0; i < WINDOW - 1; i++) feedFrameTime(s, overloadDt, TARGET_MS);
  assert(s.scale === SCALE_CEIL, "must not step down before the rolling window is full");
}

// --- step-down at sustained overload -----------------------------------
{
  const s = createResController();
  const overloadDt = TARGET_MS * 2; // p95 will sit well above target*1.15
  // fill the window first (does not count toward dwell once full)
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, overloadDt, TARGET_MS);
  const scaleAfterFill = s.scale;
  // sustain overload for the dwell period — must step down exactly once
  let steps = 0;
  let t = 0;
  const before = s.scale;
  while (t < DWELL_OVERLOAD_MS + 1) {
    if (feedFrameTime(s, overloadDt, TARGET_MS)) steps++;
    t += overloadDt;
  }
  assert(steps >= 1, "sustained overload past the dwell period must step the scale down at least once");
  assert(s.scale < before, "scale must have decreased under sustained overload");
  assert(Math.abs(before - s.scale - STEP) < 1e-9 || steps > 1,
    "a single dwell period should produce exactly one STEP decrement (unless multiple dwell periods elapsed)");
  assert(scaleAfterFill === SCALE_CEIL, "scale should still be at ceiling right after the window fills, before any dwell elapses");
}

// --- floor is respected under prolonged overload -----------------------
{
  const s = createResController();
  const overloadDt = TARGET_MS * 3;
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, overloadDt, TARGET_MS);
  // run long enough for many dwell periods — should clamp at SCALE_FLOOR, never below
  feedFor(s, overloadDt, DWELL_OVERLOAD_MS * 20);
  assert(s.scale === SCALE_FLOOR, `scale should clamp at the floor (${SCALE_FLOOR}) under prolonged overload, got ${s.scale}`);
  assert(s.scale >= SCALE_FLOOR - 1e-9, "scale must never go below the floor");
}

// --- step-up only after sustained headroom (hysteresis), not immediately ---
{
  const s = createResController(SCALE_FLOOR); // start at floor as if recovering from prior overload
  const lightDt = TARGET_MS * 0.5; // comfortably under target*0.85
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, lightDt, TARGET_MS);
  assert(s.scale === SCALE_FLOOR, "must not step up before the underload dwell period elapses");
  // now sustain headroom for the dwell period
  let stepped = false;
  let t = 0;
  while (t < DWELL_UNDERLOAD_MS + 1) {
    if (feedFrameTime(s, lightDt, TARGET_MS)) stepped = true;
    t += lightDt;
  }
  assert(stepped, "sustained headroom past the underload dwell must step the scale up");
  assert(s.scale > SCALE_FLOOR, "scale must have increased under sustained headroom");
}

// --- ceiling is respected under prolonged headroom ----------------------
{
  const s = createResController(SCALE_FLOOR);
  const lightDt = TARGET_MS * 0.3;
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, lightDt, TARGET_MS);
  feedFor(s, lightDt, DWELL_UNDERLOAD_MS * 20);
  assert(s.scale === SCALE_CEIL, `scale should clamp at the ceiling (${SCALE_CEIL}) under prolonged headroom, got ${s.scale}`);
  assert(s.scale <= SCALE_CEIL + 1e-9, "scale must never exceed the ceiling");
}

// --- comfortable middle band never steps (no oscillation) ---------------
{
  const s = createResController();
  // dt right at target — neither overloaded (>1.15x) nor underloaded (<0.85x)
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, TARGET_MS, TARGET_MS);
  const before = s.scale;
  const changed = feedFor(s, TARGET_MS, DWELL_OVERLOAD_MS + DWELL_UNDERLOAD_MS + 1000);
  assert(!changed, "frame times sitting in the comfortable middle band must never trigger a step");
  assert(s.scale === before, "scale must stay put in the comfortable middle band");
}

// --- steps are spaced at least one full dwell period apart (no double-step /
// rapid oscillation the instant a step fires) ----------------------------
{
  const s = createResController();
  const overloadDt = TARGET_MS * 2;
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, overloadDt, TARGET_MS);
  s.overloadMs = 0; // the window-fill loop's final call already ticks the dwell counter once; start the gap timer clean
  let t = 0, sinceLastStep = 0;
  const gaps = [];
  while (t < DWELL_OVERLOAD_MS * 6 && s.scale > SCALE_FLOOR) {
    const stepped = feedFrameTime(s, overloadDt, TARGET_MS);
    sinceLastStep += overloadDt;
    if (stepped) { gaps.push(sinceLastStep); sinceLastStep = 0; }
    t += overloadDt;
  }
  assert(gaps.length >= 2, "test setup: expected multiple down-steps to compare gaps");
  for (const gap of gaps) {
    assert(gap >= DWELL_OVERLOAD_MS - 1e-6, `consecutive steps must be at least one dwell period (${DWELL_OVERLOAD_MS}ms) apart, got ${gap}ms`);
  }
}

// --- a brief overload blip below the dwell period must not step ---------
{
  const s = createResController();
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, TARGET_MS, TARGET_MS);
  const overloadDt = TARGET_MS * 2;
  let t = 0, changed = false;
  while (t < DWELL_OVERLOAD_MS * 0.5) {
    changed = feedFrameTime(s, overloadDt, TARGET_MS) || changed;
    t += overloadDt;
  }
  assert(!changed, "an overload blip shorter than the dwell period must not step the scale down");
}

// --- allowStep=false tracks p95 (for the bloom gate) but never steps -----
{
  const s = createResController();
  const overloadDt = TARGET_MS * 3;
  for (let i = 0; i < WINDOW; i++) feedFrameTime(s, overloadDt, TARGET_MS, false);
  feedFor(s, overloadDt, DWELL_OVERLOAD_MS * 10, false);
  assert(s.scale === SCALE_CEIL, "allowStep=false must never change the scale regardless of overload");
  assert(s.p95 > TARGET_MS * 1.15, "allowStep=false must still track p95 so the bloom gate stays accurate");
}

console.log("smoke-xrperf: all assertions passed");
