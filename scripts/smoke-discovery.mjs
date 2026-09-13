import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const toasts = [];
globalThis.window = {};
globalThis.document = {
  getElementById(id) {
    if (id === "toasts") return {
      children: [],
      appendChild(node) { this.children.push(node); },
      firstChild: null,
    };
    if (id === "objList") return { innerHTML: "", appendChild() {} };
    return null;
  },
  createElement() {
    return {
      className: "",
      textContent: "",
      style: {},
      children: [],
      append(...nodes) { this.children.push(...nodes); },
      remove() {},
    };
  },
};
globalThis.setTimeout = fn => { toasts.push("timer"); return 0; };

const log = await import("../src/discoveryLog.js");
const { G } = await import("../src/state.js");

function resetG() {
  G.t = 0; G.maxRE = 0; G.dvUsed = 0;
  G.x = 7000; G.y = 0; G.z = 0; G.vx = 0; G.vy = 0; G.vz = 0;
}

resetG();
log.clearLog();
log.noteBody("planet", 4, "MARS");
log.noteBody("planet", 4, "MARS");
assert.equal(log.getEntries().length, 1, "duplicate body visits should dedup");
assert.deepEqual(log.serializeLog().seen.bodies, ["planet:4"]);

G.t = 12345;
G.maxRE = 2.5 * 9.4607304725808e12;
G.dvUsed = 2500;
log.updateRecords();
log.noteStar("sol", "THE SUN");
log.noteNotable("pulsar", "CRAB PULSAR");
const snapshot = log.serializeLog();
log.restoreLog(JSON.parse(JSON.stringify(snapshot)));
assert.deepEqual(log.serializeLog(), snapshot, "log should round-trip through JSON");

log.restoreLog(null);
assert.deepEqual(log.serializeLog(), {
  seen: { bodies: [], stars: [], notables: [] },
  entries: [],
  records: { maxDistLy: 0, minClockRate: 1, maxDvUsed: 0 },
}, "v9 log absence should restore as empty");

const v10 = { v: 10, log: snapshot };
log.restoreLog(JSON.parse(JSON.stringify(v10)).log);
assert.deepEqual(log.serializeLog(), snapshot, "v10 save-style blob should carry log data");

// The save format is versioned, so this asserts the contract rather than one
// frozen number: whatever version saveState writes, loadState must accept it,
// and the discovery log must still restore from LOG_FLOOR upwards. Pinning a
// literal here is what went stale when the format moved from v10 to v11.
const LOG_FLOOR = 10; // version at which the discovery log entered the format
const savesSrc = readFileSync(new URL("../src/saves.js", import.meta.url), "utf8");

const written = savesSrc.match(/\bv:\s*(\d+)\b/);
assert.ok(written, "saveState should write a numeric format version");
const CURRENT = Number(written[1]);
assert.ok(CURRENT >= LOG_FLOOR, `save version ${CURRENT} should not predate the discovery log`);

const guard = savesSrc.match(/data\.v\s*>\s*(\d+)/);
assert.ok(guard, "loadState should reject versions newer than it understands");
assert.equal(Number(guard[1]), CURRENT,
  `loadState guard accepts up to v${guard[1]} but saveState writes v${CURRENT}`);

const floor = savesSrc.match(/data\.v\s*>=\s*(\d+)\s*&&\s*data\.log\)\s*restoreLog\(data\.log\)/);
assert.ok(floor, "loadState should restore the discovery log from versioned saves");
assert.equal(Number(floor[1]), LOG_FLOOR,
  `discovery-log restore floor moved to v${floor?.[1]}, expected v${LOG_FLOOR}`);

assert.match(savesSrc, /log:\s*serializeLog\(\)/, "saveState should include discovery log");
assert.match(savesSrc, /else\s+restoreLog\(null\)/, "pre-log saves should migrate to an empty log");

// A blob at the version saveState actually writes must round-trip the log.
log.restoreLog(JSON.parse(JSON.stringify({ v: CURRENT, log: snapshot })).log);
assert.deepEqual(log.serializeLog(), snapshot, `v${CURRENT} save-style blob should carry log data`);

console.log("smoke-discovery ok");
