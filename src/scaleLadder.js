import { AU_KM, LY_KM, PC_KM, MPC_KM, C_LIGHT } from "./constants.js";

const SEC_YEAR = 31557600;

function finiteNonNegative(value) {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function scaleRungLabel(camDistKm) {
    const d = finiteNonNegative(camDistKm);
    if (d < 0.1 * AU_KM) return "SUB-AU · " + d.toLocaleString("en-US", { maximumFractionDigits: 0 }) + " km";
    if (d < 0.5 * LY_KM) return "AU · " + (d / AU_KM).toFixed(2) + " AU";
    if (d < 500 * LY_KM) return "LIGHT-YEAR · " + (d / LY_KM).toFixed(2) + " ly";
    if (d < 3000 * PC_KM) return "PARSEC · " + (d / PC_KM).toFixed(1) + " pc";
    if (d < 1e6 * PC_KM) return "KILOPARSEC · " + (d / (1000 * PC_KM)).toFixed(2) + " kpc";
    return "MEGAPARSEC · " + (d / MPC_KM).toFixed(2) + " Mpc";
}

export function lightTravelLabel(distKm) {
    const d = finiteNonNegative(distKm);
    if (d <= 0) return "—";
    const ltSec = d / C_LIGHT;
    if (ltSec < 60) return ltSec.toFixed(1) + " s";
    if (ltSec < 3600) return (ltSec / 60).toFixed(1) + " min";
    if (ltSec < 86400) return (ltSec / 3600).toFixed(1) + " h";
    if (ltSec < SEC_YEAR) return (ltSec / 86400).toFixed(1) + " d";
    return (ltSec / SEC_YEAR).toFixed(2) + " yr";
}
