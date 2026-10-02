// One explicit exploration context, independent of the ship's neighbourhood.
// It owns no meshes, textures or unbounded registry. Existing generation and
// the single system renderer remain the only owners of body detail.
import { STARS } from '../constants.js';
import { getSeed } from './galaxy.js';
import { activeStarFocusValue, activeStarForFocus, getFocusedSystem, getCachedFocusedSystem } from './activeStars.js';
import { stableStarKey, parseSystemFocus, planetFocusValue, planetMoonFocusValue } from './planetarySystem.js';

let explored = null;
function starFocus(star) {
    const i = STARS.indexOf(star);
    return i >= 0 ? 'star:' + i : activeStarFocusValue(star);
}
function starForFocus(focus) {
    const m = /^star:(\d+)$/.exec(String(focus));
    return m ? STARS[Number(m[1])] || null : activeStarForFocus(focus);
}
function hostForId(starId, hostFocus = '') {
    // Stable identity wins over a saved array index (promoted catalogs may
    // re-enter STARS in a different order after loading).
    const known = STARS.find(star => stableStarKey(star) === starId);
    if (known) return known;
    const focus = starId.startsWith('proc:') ? starId : starId.startsWith('cat:hyg:') ? starId.slice(4) : hostFocus;
    const star = focus ? starForFocus(focus) : null;
    return star && stableStarKey(star) === starId ? star : null;
}
function remember(star) {
    if (!star || star.formedStar) return null;
    explored = { starId: stableStarKey(star), hostFocus: starFocus(star), galaxySeed: getSeed() };
    return star;
}
function retainedHost() {
    if (!explored || explored.galaxySeed !== getSeed()) return null;
    return hostForId(explored.starId, explored.hostFocus);
}
export function serializeExploredSystem() { return explored && explored.galaxySeed === getSeed() ? { ...explored } : null; }

export function getExploredSystem(focus, fallbackStar = null, simT = 0) {
    const child = parseSystemFocus(focus);
    let star;
    if (child) {
        // Never guess a child host from ship proximity. An unqualified live
        // target can only use an already established exploration context.
        const id = child.starId || explored?.starId;
        star = id ? hostForId(id, child.hostFocus || (explored?.starId === id ? explored.hostFocus : '')) : null;
        if (star) remember(star);
        if (!star) return null;
    } else {
        star = starForFocus(focus);
        if (star) remember(star);
        else star = retainedHost() || fallbackStar;
    }
    const system = star ? getFocusedSystem(star, simT) : null;
    if (child && (!system?.planets[child.planetIndex] || (child.moonIndex !== null && !system.planets[child.planetIndex].moons?.[child.moonIndex]))) return null;
    return system;
}

export function qualifySystemFocus(focus) {
    const child = parseSystemFocus(focus);
    if (!child) return typeof focus === 'string' && /^(system:|planet:)/.test(focus) ? 'earth' : focus;
    if (child.starId) return focus;
    const host = retainedHost();
    if (!host) return 'earth';
    const system = { starId: explored.starId, hostStar: host };
    return child.moonIndex === null ? planetFocusValue(child.planetIndex, system) : planetMoonFocusValue(child.planetIndex, child.moonIndex, system);
}

// Consumers must not interpret a stale flight target against a newly selected
// system's same-numbered slot. Reading a target does not change selection.
export function getSystemForTarget(focus) {
    const child = parseSystemFocus(focus), system = getCachedFocusedSystem();
    return child?.starId && system?.starId === child.starId ? system : null;
}

export function restoreExploredSystem(record, focus) {
    explored = null;
    // Camera preferences do not restore an entire universe. A saved child
    // from another seed must not silently become that slot's different body.
    if (record && record.galaxySeed !== getSeed() && parseSystemFocus(focus)) {
        getFocusedSystem(null);
        return 'earth';
    }
    if (record && typeof record.starId === 'string' && record.galaxySeed === getSeed()) {
        const star = hostForId(record.starId, record.hostFocus);
        if (star) remember(star);
    }
    const child = parseSystemFocus(focus);
    if (child) {
        // Old saves have no evidence of which host planet:0 meant. Return
        // home instead of silently inventing ownership from the ship.
        const qualified = qualifySystemFocus(focus);
        return getExploredSystem(qualified) ? qualified : 'earth';
    }
    if (typeof focus === 'string' && /^(system:|planet:)/.test(focus)) return 'earth';
    getFocusedSystem(retainedHost());
    return focus;
}
