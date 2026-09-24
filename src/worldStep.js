// ONE per-frame world step, shared by every way the ship can be (flying,
// landed, dead/observer, riding a relativistic cruise).
//
// Before this existed main.js advanced time in four different places: the
// flight path ran the Sun's evolution and engulfment inside physics.advance(),
// while the landed/dead paths only moved the ephemeris -- a ship parked on
// Earth at max warp kept Earth alive through 9 Gyr until it lifted off -- and
// the dead path shared the flight path's broken post-engulfment integration.
// Here every path, in one place and one order:
//   1. opens the ephemeris frame context (per-frame integration budget),
//   2. updates the Sun's evolving state and applies engulfment at G.t,
//   3. applies the reverse-time guards (irreversible floor, matter in flight),
//   4. advances the world by the mode's own integrator, which reports the
//      time it actually DELIVERED (a budget-limited black-hole scene delivers
//      less than asked instead of integrating garbage),
//   5. re-syncs the ephemeris clock to the authoritative clock,
//   6. publishes delivered-vs-requested to timeCtl (Time Dock readout; the
//      jump runtime separately settles on the same delivered value).
import { G, WORLD, GS, BH, syncEphemClock } from "./state.js";
import { beginEphemFrame, endEphemFrame } from "./ephemeris.js";
import { advance, advanceBodiesOnly, clampReverseAdvance, updateSunEvolution } from "./physics.js";
import { REL, relCancel, relTravelStep } from "./relTravel.js";
import { noteFrameDelivery } from "./timeCtl.js";

export const WORLD_STEP = {
    requested: 0,
    delivered: 0,
    mode: "",
    limited: false,
    reason: "",
    activeStarsFresh: false,
    bodySteps: 0,
    analyticCalls: 0,
};

function shortfallReason(aMag) {
    if (BH.n > 0) return "black holes are integrated step by step";
    if (GS.length > 0) return "gravity ghosts force step-by-step physics";
    if (aMag > 0) return "engine firing: the burn is integrated step by step";
    return "integration budget reached";
}

// requested: simulated seconds this frame asks for (signed). Returns the
// simulated seconds actually delivered; details in WORLD_STEP.
export function stepWorld(requested, atx = 0, aty = 0, atz = 0, aMag = 0, toast = null) {
    const r = WORLD_STEP;
    r.requested = requested;
    r.delivered = 0;
    r.activeStarsFresh = false;
    const lostOrLanded = G.dead || !!G.landed;
    const frame = beginEphemFrame(Math.abs(G.warp));
    try {
        updateSunEvolution(G.t);
        if (REL.active && requested < 0) relCancel("reverse warp", toast);
        if (REL.active) {
            r.mode = "relativistic";
            WORLD.reverseBlocked = false;
            r.delivered = relTravelStep(requested);
        } else if (G.dead || G.landed) {
            r.mode = G.dead ? "dead" : "landed";
            WORLD.reverseBlocked = false;
            const dt = clampReverseAdvance(requested);
            r.delivered = dt !== 0 ? advanceBodiesOnly(dt) : 0;
        } else {
            r.mode = "flight";
            r.delivered = advance(requested, atx, aty, atz, aMag); // applies its own reverse guards
            r.activeStarsFresh = true;
        }
    } finally {
        r.bodySteps = frame.stepsUsed;
        r.analyticCalls = frame.analyticCalls;
        endEphemFrame();
        syncEphemClock();
    }
    // Not physics shortfalls: a reverse clamp at the irreversible floor (the
    // Time Dock reports it through WORLD.reverseBlocked), a cruise that just
    // arrived, and a ship that crashed or touched down mid-frame.
    const blocked = requested < 0 && WORLD.reverseBlocked;
    const ended = (r.mode === "relativistic" && !REL.active) || (G.dead || !!G.landed) !== lostOrLanded;
    const short = !blocked && !ended && Math.abs(r.delivered) < Math.abs(requested) * (1 - 1e-6);
    r.limited = short;
    r.reason = short ? shortfallReason(aMag) : "";
    noteFrameDelivery(short ? requested : r.delivered, r.delivered, r.reason);
    return r.delivered;
}
