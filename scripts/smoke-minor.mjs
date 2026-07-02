import assert from "node:assert/strict";
import { AU_KM } from "../src/constants.js";
import { generateSwarms, KIRKWOOD_GAPS_AU, MINOR_STRIDE, OORT_AU_MAX, OORT_AU_MIN, propagateInto } from "../src/universe/minorBodies.js";

function bytesOf(arr) {
    return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

const a = generateSwarms(0x9e3779b9);
const b = generateSwarms(0x9e3779b9);

for (const key of ["belt", "kuiper", "oort", "curated"]) {
    assert.equal(Buffer.compare(bytesOf(a[key]), bytesOf(b[key])), 0, `${key} deterministic bytes`);
}

function checkFinite(name, swarm) {
    for (let i = 0; i < swarm.length; i += MINOR_STRIDE) {
        const aa = swarm[i], e = swarm[i + 1];
        assert.ok(Number.isFinite(aa) && aa > 0, `${name} a finite`);
        assert.ok(Number.isFinite(e) && e >= 0 && e < 1, `${name} e finite`);
        for (let j = 2; j < MINOR_STRIDE; j++) assert.ok(Number.isFinite(swarm[i + j]), `${name} element finite`);
    }
}

checkFinite("belt", a.belt);
checkFinite("kuiper", a.kuiper);
checkFinite("oort", a.oort);
checkFinite("curated", a.curated);

function countBin(swarm, centerAu, halfWidthAu) {
    let n = 0;
    for (let i = 0; i < swarm.length; i += MINOR_STRIDE) {
        const au = swarm[i] / AU_KM;
        if (Math.abs(au - centerAu) <= halfWidthAu) n++;
    }
    return n;
}

for (const gap of KIRKWOOD_GAPS_AU) {
    const center = countBin(a.belt, gap, 0.005);
    const left = countBin(a.belt, gap - 0.02, 0.005);
    const right = countBin(a.belt, gap + 0.02, 0.005);
    const neighbors = (left + right) / 2;
    assert.ok(center < neighbors * 0.3, `Kirkwood gap ${gap} AU: ${center} < 30% of ${neighbors}`);
}

const oneYear = 365.25 * 86400;
const world0 = new Float64Array(a.belt.length / MINOR_STRIDE * 3);
const world1 = new Float64Array(world0.length);
propagateInto(a.belt, 0, world0, [1000, -2000, 3000], 0, 512);
propagateInto(a.belt, oneYear, world1, [1000, -2000, 3000], 0, 512);
let moved = false;
for (let i = 0; i < 512 * 3; i++) {
    assert.ok(Number.isFinite(world0[i]) && Number.isFinite(world1[i]), "propagated position finite");
    if (world0[i] !== world1[i]) moved = true;
}
assert.ok(moved, "belt bodies move over one year");

for (let i = 0; i < a.oort.length; i += MINOR_STRIDE) {
    const au = a.oort[i] / AU_KM;
    assert.ok(au >= OORT_AU_MIN && au <= OORT_AU_MAX, `Oort radius ${au} AU in range`);
}

console.log("smoke-minor: ok");
