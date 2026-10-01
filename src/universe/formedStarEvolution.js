// A reduced stellar track begins only after the numerical sink has assembled.
// This reuses the population model; it is not a stellar-interior/fusion solver.
import { synthStar, deriveStar, tempToColor } from './stellar.js';
import { tMSGyr } from './astroConstants.js';
import { makeRNG } from './prng.js';
import { SEC_YEAR, R_SUN } from '../constants.js';

export const GAS_MASS_MIN = .1, GAS_MASS_MAX = 30;
export function validGasMass(mass) {
    return Number.isFinite(mass) && mass >= GAS_MASS_MIN && mass <= GAS_MASS_MAX;
}
const phaseName = { MS:'Main sequence', giant:'Giant', WD:'White dwarf', NS:'Neutron star', BH:'Black hole' };

export function formedStarEvolution(massSolar, ageSec, seed = 0, assembled = true) {
    if (!(massSolar > 0)) return null;
    const age = Math.max(0, ageSec || 0);
    // A coarse pre-main-sequence timescale, not a prediction from the SPH gas.
    const contractionSec = 30e6 * SEC_YEAR * Math.pow(Math.max(.08, massSolar), -2);
    const mainSequenceSec = tMSGyr(Math.max(.08, massSolar)) * 1e9 * SEC_YEAR;
    const stageAge = assembled ? age : 0;
    let model, phase;
    if (massSolar < .08) {
        const R = .1, Teff = 2400 * Math.pow(1 + stageAge / (1e8 * SEC_YEAR), -.18);
        model = { kind:'BD', mass:massSolar, R, Teff, L:R*R*(Teff/5772)**4, color:tempToColor(Teff), cls:'BD' };
        phase = 'Substellar core';
    } else if (!assembled || stageAge < contractionSec) {
        const ms = deriveStar(massSolar), u = Math.min(1, stageAge / contractionSec);
        const R = ms.R * (1 + 3 * (1-u)), Teff = ms.Teff * (.72 + .28*u);
        model = { ...ms, kind:'protostar', R, Teff, L:R*R*(Teff/5772)**4, color:tempToColor(Teff) };
        phase = assembled ? 'Protostar' : 'Accreting protostar';
    } else {
        model = synthStar(makeRNG(seed >>> 0), massSolar, (stageAge-contractionSec)/(1e9*SEC_YEAR));
        if(model.kind==='giant') {
            // synthStar's giant branch is a red-clump population proxy. A
            // massive star must not abruptly become a 100 Lsun clump star.
            // Use its temperature as the end-state and retain the progenitor's
            // luminosity scale; the interpolation is explicitly a reduced track.
            const ms=deriveStar(massSolar);
            const u=Math.min(1,(stageAge-contractionSec-mainSequenceSec)/(.1*mainSequenceSec));
            const L=ms.L+(Math.max(model.L,ms.L*1.5)-ms.L)*u;
            const Teff=ms.Teff+(model.Teff-ms.Teff)*u;
            model={...model,L,Teff,R:Math.sqrt(L)*(5772/Teff)**2,color:tempToColor(Teff)};
        }
        // The population IFMR is calibrated to intermediate masses. Never
        // manufacture a remnant heavier than a low-mass parent.
        model.mass = Math.min(massSolar, model.mass);
        phase = phaseName[model.kind] || model.kind;
    }
    const nextAgeSec = model.kind === 'protostar' ? contractionSec : model.kind === 'MS'
        ? contractionSec+mainSequenceSec : model.kind === 'giant' ? contractionSec+1.1*mainSequenceSec : null;
    return { ...model, phase, ageSec:stageAge, assembled, initialMassSolar:massSolar,
        massSolar:model.mass, radiusKm:model.R*R_SUN, luminositySolar:model.L, temperatureK:model.Teff,
        ejectedMassSolar:Math.max(0,massSolar-model.mass), contractionSec, mainSequenceSec, nextAgeSec,
        model:'reduced stellar track' };
}
