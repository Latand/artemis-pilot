import { readFileSync } from "node:fs";
import {
    RELATIVISTIC_VIEW_GLSL,
    relAberrateCos,
    relDopplerFactor,
} from "../src/render/viewBrightness.js";
const starPointSrc = readFileSync(new URL("../src/render/starPointMaterial.js", import.meta.url), "utf8");

let pass = 0, fail = 0;
const ok = (cond, label, detail = "") => {
    if (cond) { pass++; console.log(`  PASS  ${label}${detail ? "   " + detail : ""}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? "   " + detail : ""}`); }
};
const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol;

for (let i = 0; i <= 40; i++) {
    const mu = -1 + i / 20;
    ok(relAberrateCos(mu, 0) === mu, `identity aberration mu=${mu.toFixed(2)}`);
    ok(relDopplerFactor(mu, 0) === 1, `identity Doppler mu=${mu.toFixed(2)}`);
}

{
    const beta = 0.6;
    ok(relAberrateCos(0, beta) > 0, "side star aberrates forward");
    ok(relAberrateCos(1, beta) === 1, "forward pole stays fixed");
    ok(relAberrateCos(-1, beta) === -1, "astern pole stays fixed");
    let monotoneForward = true;
    for (let i = 0; i <= 100; i++) {
        const mu = -1 + i / 50;
        if (relAberrateCos(mu, beta) + 1e-15 < mu) monotoneForward = false;
    }
    ok(monotoneForward, "aberration shifts every sampled mu forward");
}

{
    const beta = 0.6;
    const gamma = 1 / Math.sqrt(1 - beta * beta);
    ok(close(relDopplerFactor(1, beta), Math.sqrt((1 + beta) / (1 - beta))), "Doppler ahead blueshift");
    ok(close(relDopplerFactor(-1, beta), Math.sqrt((1 - beta) / (1 + beta))), "Doppler astern redshift");
    ok(close(relDopplerFactor(0, beta), 1 / gamma), "Doppler transverse redshift");
    ok(relDopplerFactor(1, beta) ** 2 > 1, "D^2 beams ahead");
    ok(relDopplerFactor(1, 0.8) ** 2 > relDopplerFactor(1, beta) ** 2, "D^2 grows with beta");
}

// Point-source beaming for a moving observer: bolometric intensity goes as
// D^4 (I_nu/nu^3 invariant) while aberration shrinks the source's solid angle
// by D^-2, so the received flux goes as D^2. Check the solid-angle half
// numerically with the same aberration formula the shaders use.
for (const [mu0, beta] of [[1, 0.6], [-1, 0.6], [1, 0.95]]) {
    const th = 1e-4;
    const edge = Math.cos(Math.acos(mu0) + (mu0 > 0 ? th : -th));
    const omega = 2 * Math.PI * Math.abs(mu0 - edge);
    const omegaObs = 2 * Math.PI * Math.abs(relAberrateCos(mu0, beta) - relAberrateCos(edge, beta));
    const D = relDopplerFactor(mu0, beta);
    const fluxRatio = D ** 4 * omegaObs / omega;
    ok(Math.abs(fluxRatio / D ** 2 - 1) < 1e-3, `point-source flux scales as D^2 (mu=${mu0}, beta=${beta})`, `F'/F=${fluxRatio.toFixed(4)} D^2=${(D * D).toFixed(4)}`);
}

{
    const beta = 0.72;
    let roundTrips = true;
    for (let i = 0; i <= 100; i++) {
        const mu = -1 + i / 50;
        const boosted = relAberrateCos(mu, beta);
        const restored = relAberrateCos(boosted, -beta);
        if (!close(restored, mu, 1e-9)) roundTrips = false;
    }
    ok(roundTrips, "aberration round-trips with reversed beta");
}

ok(RELATIVISTIC_VIEW_GLSL.includes("(mu + beta) / (1.0 + beta * mu)"), "GLSL aberration formula parity guard");
ok(RELATIVISTIC_VIEW_GLSL.includes("1.0 / (gamma * (1.0 - beta * mu))"), "GLSL Doppler formula parity guard");
ok(/obmHdrIntensity\(mag, uMagLimit\) \* dopplerD \* dopplerD/.test(starPointSrc), "shared star material beams point sources by D^2");

console.log(`\nrelview smoke: ${pass} PASS, ${fail} FAIL`);
if (fail) process.exit(1);
