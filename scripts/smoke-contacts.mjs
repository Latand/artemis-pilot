import assert from "node:assert/strict";
import { classifyContact } from "../src/universe/contactMath.js";

const body = overrides => ({
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    R: 5, mu: 100, rho: 1, rocheMax: 1e9,
    ...overrides,
});

function legacyPlanarKind(a, b) {
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const rel = Math.hypot(a.vx - b.vx, a.vy - b.vy);
    const sumR = a.R + b.R;
    const big = a.mu >= b.mu ? a : b;
    const small = big === a ? b : a;
    if (d <= sumR) {
        const esc = Math.sqrt(2 * (a.mu + b.mu) / Math.max(1, sumR));
        return small.mu / big.mu > .2 || rel > esc ? "impact-both" : "impact";
    }
    const roche = Math.min(
        big.rocheMax,
        2.44 * big.R * Math.cbrt(big.rho / Math.max(1e-12, small.rho)),
    );
    return d < roche ? "roche" : "none";
}

{
    const supplied = { kind: "stale", dKm: -1, relKmS: -1, rocheKm: -1, escKmS: -1 };
    const a = body({ mu: 10000 });
    const b = body({ x: 3, z: 4, vx: 3, vy: 4, vz: 12 });
    const result = classifyContact(a, b, supplied);
    assert.equal(result, supplied, "a supplied result record must be returned by identity");
    assert.deepEqual(result, {
        kind: "impact",
        dKm: 5,
        relKmS: 13,
        rocheKm: 12.2,
        escKmS: Math.sqrt(2020),
    }, "a supplied result record must receive every classification field");
}

{
    const first = classifyContact(body({ R: 10, mu: 1000, rho: 8 }), body({ x: 60, R: 2, mu: 10, rho: 1 }));
    const firstSnapshot = { ...first };
    const second = classifyContact(body({ mu: 10000 }), body({ x: 3, z: 4, vx: 3, vy: 4, vz: 12 }));
    assert.notEqual(first, second, "default classification calls must return independent records");
    assert.deepEqual(first, firstSnapshot, "a later default call must leave earlier results unchanged");
}

{
    const a = body({});
    const b = body({ x: 6, y: 8, z: 31 });
    const result = classifyContact(a, b);
    assert.equal(result.kind, "none", "3-D separation must reject a projected x/y overlap");
    assert.equal(result.dKm, Math.hypot(6, 8, 31), "reported separation must use the 3-D norm");
}

{
    const a = body({ mu: 10000 });
    const b = body({ x: 3, z: 4, vx: 3, vy: 4, vz: 12 });
    const result = classifyContact(a, b);
    assert.equal(result.kind, "impact", "a true 3-D overlap must classify as an impact");
    assert.equal(result.dKm, 5, "a true 3-D overlap must report its 3-D separation");
    assert.equal(result.relKmS, 13, "impact speed must use the 3-D relative-velocity norm");
    assert.equal(result.escKmS, Math.sqrt(2020), "escape speed must use both masses at sumR");
}

{
    const primary = body({ R: 10, mu: 1000, rho: 8 });
    const inside = body({ x: 10, z: 30, R: 2, mu: 10, rho: 1 });
    const outside = body({ x: 10, z: 50, R: 2, mu: 10, rho: 1 });
    const insideResult = classifyContact(primary, inside);
    const outsideResult = classifyContact(primary, outside);
    assert.equal(insideResult.rocheKm, 48.8, "Roche distance must retain the rigid-body coefficient 2.44");
    assert.equal(insideResult.kind, "roche", "a z-offset pair inside the 3-D Roche distance must disrupt");
    assert.equal(outsideResult.kind, "none", "a z-offset pair beyond the 3-D Roche distance must stay clear");
}

{
    const primary = body({ R: 10, mu: 1000, rho: 8, rocheMax: 20 });
    const inside = body({ x: 19, R: 2, mu: 10, rho: 1 });
    const atLimit = body({ x: 20, R: 2, mu: 10, rho: 1 });
    const insideResult = classifyContact(primary, inside);
    assert.equal(insideResult.rocheKm, 20, "rocheMax must cap the rigid-body Roche distance");
    assert.equal(insideResult.kind, "roche", "a pair inside the capped Roche distance must disrupt");
    assert.equal(classifyContact(primary, atLimit).kind, "none", "the Roche-distance boundary must stay strict");
}

{
    const thresholdEsc = Math.sqrt(24);
    const planarCases = [
        ["clear", body({ R: 10, mu: 1000, rho: 8 }), body({ x: 60, R: 2, mu: 10, rho: 1 })],
        ["Roche", body({ R: 10, mu: 1000, rho: 8 }), body({ x: 30, R: 2, mu: 10, rho: 1 })],
        ["one-body impact", body({ R: 5, mu: 100 }), body({ x: 9, R: 5, mu: 10 })],
        ["ratio mutual impact", body({ R: 5, mu: 100 }), body({ x: 9, R: 5, mu: 21 })],
        ["speed mutual impact", body({ R: 5, mu: 10000 }), body({ x: 9, vx: 50, R: 5, mu: 100 })],
        ["strict thresholds", body({ R: 5, mu: 100 }), body({ x: 10, vx: thresholdEsc, R: 5, mu: 20 })],
    ];
    for (const [label, a, b] of planarCases) {
        const expected = legacyPlanarKind(a, b);
        const result = classifyContact(a, b);
        assert.equal(result.kind, expected, `${label} must preserve the planar classification`);
        assert.equal(result.dKm, Math.hypot(a.x - b.x, a.y - b.y), `${label} must preserve planar separation`);
        assert.equal(result.relKmS, Math.hypot(a.vx - b.vx, a.vy - b.vy), `${label} must preserve planar relative speed`);
        assert.equal(result.escKmS, Math.sqrt(2 * (a.mu + b.mu) / Math.max(1, a.R + b.R)), `${label} must preserve escape speed`);
        assert.equal(classifyContact(b, a).kind, legacyPlanarKind(b, a), `${label} must preserve classification with reversed arguments`);
    }
}

console.log("smoke-contacts OK");
