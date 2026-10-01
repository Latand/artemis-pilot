import { PL } from "./constants.js";
import { G, BH, WORLD } from "./state.js";
import {
    snapshotEphem, IDX_MOON, IDX_SUN, IDX_PLANETS,
    bodyGravityAcceleration, earthGravityAcceleration, holeGravityAcceleration, gasSystemGravityAcceleration,
} from "./ephemeris.js";
import { shipGravityAt3 } from "./physics.js";
import { NEBULAE } from "./universe/nebulaeData.js";
import { gasWorldState } from "./universe/gasDynamics.js";

const LOCAL_NOTE = "Instantaneous local numerical gravity, using the live source set and force laws. Source positions are world km; acceleration is km/s². High-warp analytic handoffs are a separate approximation.";
function unsupported(name, note, position = null) {
    return { supported: false, name, position, contributions: [], net: null,
        frame: null, note, predictionSupported: false };
}

// This query never changes focus, camera, activation, simulation time, or state.
// Catalog stars and analytic moons do not have a local integrated force ledger.
export function getLocalGravityInspection(focus = G.focus) {
    const st = snapshotEphem();
    const rows = [], net = [0, 0, 0];
    const ex = st.earthX, ey = st.earthY;
    let name, position, frame = "Earth-relative", predictionSupported = true;
    let note = LOCAL_NOTE;
    if (focus === "ship") {
        name = "Ship";
        position = [ex + G.x, ey + G.y, G.z];
        shipGravityAt3(G.x, G.y, G.z, G.vx, G.vy, G.vz, net, 0, rows);
        note += " Includes J2 and Sun 1PN where active; excludes drag, thrust and landing constraints.";
        if (G.landed || G.dead) {
            predictionSupported = false;
            note += " The ship is not freely flying; this is the gravity field at its position.";
        }
    } else if (focus === "earth") {
        name = "Earth"; position = [ex, ey, 0]; frame = "World XY (Earth z pinned)";
        if (WORLD.earthDestroyed) return unsupported(name, "Earth is destroyed; no surviving body is integrated.", position);
        earthGravityAcceleration(st, net, rows);
        note += " Earth's world z is constrained to zero; the displayed constraint row removes the unapplied z acceleration.";
    } else if (focus === "moon" || focus === "sun" || (Number.isInteger(focus) && focus >= 0 && focus < PL.length)) {
        const i = focus === "moon" ? IDX_MOON : focus === "sun" ? IDX_SUN : IDX_PLANETS + focus;
        name = focus === "moon" ? "Moon" : focus === "sun" ? "Sun" : PL[focus].name;
        position = [ex + st.x[i], ey + st.y[i], st.z[i]];
        const destroyed = focus === "moon" ? WORLD.moonDestroyed : focus === "sun" ? WORLD.sunDestroyed : WORLD.plDestroyed[focus];
        if (destroyed) return unsupported(name, "This body is destroyed; no surviving body is integrated.", position);
        bodyGravityAcceleration(st, i, net, rows);
        note += " Self-pull is excluded. Earth-frame and Sun 1PN terms are listed separately.";
    } else if (typeof focus === "string" && /^bh:\d+$/.test(focus)) {
        const i = Number(focus.slice(3));
        name = (BH.kind[i] === 2 ? "Pulsar " : BH.kind[i] === 1 ? "Quasar " : "Black hole ") + (i + 1);
        if (i >= BH.n) return unsupported(name, "This placed source no longer exists.");
        position = [ex + BH.x[i], ey + BH.y[i], BH.z[i]];
        holeGravityAcceleration(st, i, net, rows);
        predictionSupported = false;
        note += " Uses live hole/body pair laws and excludes self-pull. A coupled placed-hole prediction is not available.";
    } else if (typeof focus === "string" && /^neb:\d+$/.test(focus)) {
        const index = Number(focus.slice(4)), record = NEBULAE[index];
        if (!record?.formation) return unsupported("Nebula " + (index + 1),
            record ? "This nebula is a visual source without a numerical gas/core solver." : "This nebula no longer exists.");
        const p = gasWorldState(record, st.t);
        name = "Gas + core system " + (index + 1); position = [p.x, p.y, p.z];
        if (!gasSystemGravityAcceleration(st, record, net, rows)) return unsupported(name,
            "This numerical gas/core system is not currently a present bound-mass source.", position);
        frame = "Local perturbation only"; predictionSupported = false;
        note = "Net local gravitational perturbation only, in world axes (km/s²). These are the exact Solar-System, placed-hole and other gas/core kicks used by the coupled local solver; self-pull is excluded. " +
            (p.galacticSupported ? "The prescribed Galactic guiding orbit and harmonic restoring response are excluded, so this is not the total motion acceleration. " :
                "There is no prescribed Galactic background outside the model domain. ") +
            "Weak local perturbations are omitted on the high-warp analytic bridge. A coupled gas/core close-encounter forecast is not available.";
    } else {
        return unsupported(typeof focus === "string" ? focus : "Selected object",
            "This target uses a catalog, analytic, or large-scale model rather than the local integrated body solver. No applied local-force breakdown is available.");
    }
    if (WORLD.earthDestroyed && focus !== "earth" && frame !== "Local perturbation only") {
        frame = "Coasting Earth-origin frame";
        note += " Earth is destroyed, so the Newtonian Earth-frame correction is zero; any retained legacy Sun 1PN frame term remains listed in the ledger.";
    }
    if (frame !== "Local perturbation only" && rows.some(row => row.kind === "gas")) note += " Each gas + core system contributes once, using its current bound mass and modeled finite extent. The coast preview freezes this inventory and extrapolates massive partners; it is not a coupled close-encounter forecast.";
    return { supported: true, name, position, contributions: rows, net, frame, note, predictionSupported };
}
