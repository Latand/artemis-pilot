// The Galaxy's frame at sim time t, for everything tied to it rather than to
// the Sun: the Sun's own galactocentric position (the coords.js anchor that
// the renderers and the world<->galactic conversions read) and the curated
// galactic-centre black hole.
//
// Sgr A* is a STARS entry placed once from its RA/Dec at R0 (26,673 ly) -- a fixed
// point of the Sun-centred world frame. The Sun orbits the Galaxy
// (solarOrbit.js) and the drawn disc and its centre move through that frame
// accordingly, so the fixed entry drifted off the centre it marks: 247 pc
// after 1 Myr, 2.5 kpc after 10 Myr, ~16 kpc (the far side of the disc) after
// 100 Myr. It now moves rigidly with the galactic centre: its offset from the
// drawn centre is the same at every time, and nothing changes at t = 0.
import { STARS } from "../constants.js";
import { SUN_GAL, galDeltaToWorldKmInto, setSunGalAnchor } from "./coords.js";
import { solarGalacticStateAt } from "./solarOrbit.js";

const SUN_NOW = { x: SUN_GAL[0], y: SUN_GAL[1], z: SUN_GAL[2], vx: 0, vy: 0, vz: 0 };
const SGR = STARS.find(s => s.name === "SGR A*") || null;
const SGR_EPOCH = SGR ? [SGR.x, SGR.y, SGR.z] : null;
const _shift = [0, 0, 0];
let SYNC_T = 0;

// Moves the anchor and Sgr A* to sim time simT. Idempotent; cheap (one
// closed-form orbit evaluation).
export function syncGalacticFrame(simT) {
    const t = Number.isFinite(simT) ? simT : 0;
    solarGalacticStateAt(t, SUN_NOW);
    setSunGalAnchor(SUN_NOW.x, SUN_NOW.y, SUN_NOW.z);
    if (SGR) {
        // the centre moves through the Sun-centred frame opposite to the Sun's
        // own galactocentric displacement
        galDeltaToWorldKmInto(SUN_GAL[0] - SUN_NOW.x, SUN_GAL[1] - SUN_NOW.y, SUN_GAL[2] - SUN_NOW.z, _shift);
        SGR.x = SGR_EPOCH[0] + _shift[0];
        SGR.y = SGR_EPOCH[1] + _shift[1];
        SGR.z = SGR_EPOCH[2] + _shift[2];
    }
    SYNC_T = t;
    return SUN_NOW;
}

export function galacticFrameTime() { return SYNC_T; }
