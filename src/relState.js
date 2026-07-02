export const REL = {
    active: false, phase: "off",
    plan: null, target: null,
    coordElapsed: 0,
    beta: 0, gamma: 1,
    boostX: 1, boostY: 0, boostZ: 0,
    originX: 0, originY: 0, originZ: 0,
    dirX: 1, dirY: 0, dirZ: 0,
    startTauSec: 0, startCoordT: 0,
};

export function relResetState() {
    REL.active = false;
    REL.phase = "off";
    REL.plan = null;
    REL.target = null;
    REL.coordElapsed = 0;
    REL.beta = 0;
    REL.gamma = 1;
    REL.boostX = 1;
    REL.boostY = 0;
    REL.boostZ = 0;
    REL.originX = 0;
    REL.originY = 0;
    REL.originZ = 0;
    REL.dirX = 1;
    REL.dirY = 0;
    REL.dirZ = 0;
    REL.startTauSec = 0;
    REL.startCoordT = 0;
}
