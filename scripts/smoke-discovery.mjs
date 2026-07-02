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

const savesSrc = readFileSync(new URL("../src/saves.js", import.meta.url), "utf8");
assert.match(savesSrc, /v:\s*10/, "saveState should write v10");
assert.match(savesSrc, /data\.v\s*>\s*10/, "loadState guard should accept v10");
assert.match(savesSrc, /log:\s*serializeLog\(\)/, "saveState should include discovery log");
assert.match(savesSrc, /data\.v\s*>=\s*10\s*&&\s*data\.log\)\s*restoreLog\(data\.log\)/, "v10 load should restore discovery log");
assert.match(savesSrc, /else\s+restoreLog\(null\)/, "v9 load should migrate to empty log");

console.log("smoke-discovery ok");
