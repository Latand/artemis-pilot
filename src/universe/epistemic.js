export const EPISTEMIC_TIERS = Object.freeze({
    measured: Object.freeze({
        id: "measured",
        label: "MEASURED",
        description: "Real data: catalog stars, real exoplanets, planetary positions computed to today's date.",
    }),
    modeled: Object.freeze({
        id: "modeled",
        label: "MODELED",
        description: "A published physical model, simplified to run live. Right shape, approximate numbers.",
    }),
    metaphor: Object.freeze({
        id: "metaphor",
        label: "VISUAL METAPHOR",
        description: "An honest picture of something real that cannot be drawn literally at this scale.",
    }),
    hypothetical: Object.freeze({
        id: "hypo",
        label: "HYPOTHETICAL",
        description: "Mathematically consistent, never observed. You are looking at a conjecture.",
    }),
});

export const EPISTEMIC_ASSIGNMENTS = Object.freeze({
    measured: Object.freeze(["j2000-ephemeris", "athyg-tier1", "hyg-tier0", "nasa-exoplanets", "elp-moon"]),
    modeled: Object.freeze(["sun-evolution", "engulfment", "tde", "nfw-halo", "dark-energy", "mw-m31", "two-body-approach", "gw-loss", "procedural-stars", "compact-object-dynamics", "hawking-numbers"]),
    metaphor: Object.freeze(["river", "nebula", "pulsar-sweep", "black-hole-glow", "lensing", "quasar-visuals", "hawking-particles", "deep-field"]),
    hypothetical: Object.freeze(["white-hole"]),
});

const MODELED_NOTABLES = Object.freeze(new Set(["bh", "nebula", "pulsar", "quasar"]));

export function discoveryTier(entry = {}) {
    const kind = String(entry.kind || "").toLowerCase();
    const id = String(entry.id || "").toLowerCase();
    const label = String(entry.label || "");
    if (kind === "sysplanet" || kind === "sysmoon") {
        return id.includes(":catalog:") ? "measured" : "modeled";
    }
    if (kind === "star" && (/^MW-/i.test(label) || /^(?:proc:|mw-)/i.test(id))) return "modeled";
    if (kind === "notable" && MODELED_NOTABLES.has(id)) return "modeled";
    return "measured";
}

function signaturePart(value) {
    const text = String(value ?? "");
    return text.length + ":" + text;
}

function discoverySnapshot(entries, limit) {
    const source = Array.isArray(entries) ? entries : [];
    const start = Math.max(0, source.length - limit);
    let signature = String(source.length - start);
    for (let i = start; i < source.length; i++) {
        const entry = source[i] || {};
        signature += "|" + signaturePart(entry.kind) + signaturePart(entry.id) +
            signaturePart(entry.label) + signaturePart(entry.civil) + signaturePart(entry.met);
    }
    return { source, start, signature };
}

export function createDiscoveryRecentSync(limit = 12) {
    const maxRows = Math.max(0, Math.floor(limit));
    const result = { changed: false, rows: [] };
    let signature = null;
    return {
        update(entries) {
            const snapshot = discoverySnapshot(entries, maxRows);
            if (snapshot.signature === signature) {
                result.changed = false;
                return result;
            }
            signature = snapshot.signature;
            const rows = [];
            for (let i = snapshot.start; i < snapshot.source.length; i++) {
                const entry = snapshot.source[i] || {};
                const kind = String(entry.kind || "log");
                const id = String(entry.id || "");
                const met = Number(entry.met) || 0;
                rows.push({
                    id: "discovery:" + kind + ":" + id + ":" + met,
                    label: String(entry.label || ""),
                    date: String(entry.civil || ""),
                    tSimSec: met,
                    tier: discoveryTier(entry),
                    source: "discovery",
                    sequence: i,
                });
            }
            result.changed = true;
            result.rows = rows;
            return result;
        },
    };
}

export function mergeRecentRows(discoveryRows, eventRows, limit = 12) {
    const rows = [...(discoveryRows || []), ...(eventRows || [])];
    rows.sort((a, b) =>
        (Number(a.tSimSec) || 0) - (Number(b.tSimSec) || 0) ||
        (Number(a.sequence) || 0) - (Number(b.sequence) || 0) ||
        String(a.id).localeCompare(String(b.id)),
    );
    return rows.slice(Math.max(0, rows.length - Math.max(0, Math.floor(limit))));
}

function longestIncreasingPositions(values) {
    const tails = [];
    const tailPositions = [];
    const previous = new Int32Array(values.length);
    previous.fill(-1);
    for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value < 0) continue;
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tails[mid] < value) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) previous[i] = tailPositions[lo - 1];
        tails[lo] = value;
        tailPositions[lo] = i;
    }
    const positions = new Set();
    let cursor = tailPositions[tails.length - 1];
    while (cursor !== undefined && cursor >= 0) {
        positions.add(cursor);
        cursor = previous[cursor];
    }
    return positions;
}

export function reconcileKeyedRows(parent, orderedItems, views, createView, updateView) {
    const desired = new Set(orderedItems.map(item => item.id));
    let removed = 0;
    for (const [id, view] of views) {
        if (desired.has(id)) continue;
        view.node.remove();
        views.delete(id);
        removed++;
    }

    const oldPositions = new Map();
    let oldNode = parent.firstChild;
    let oldIndex = 0;
    while (oldNode) {
        oldPositions.set(oldNode, oldIndex++);
        oldNode = oldNode.nextSibling;
    }

    let created = 0;
    let moved = 0;
    const orderedViews = [];
    const retainedOrder = [];
    for (let i = 0; i < orderedItems.length; i++) {
        const item = orderedItems[i];
        let view = views.get(item.id);
        if (!view) {
            view = createView(item);
            views.set(item.id, view);
            created++;
        }
        updateView(view, item);
        orderedViews.push(view);
        retainedOrder.push(oldPositions.get(view.node) ?? -1);
    }

    const stationary = longestIncreasingPositions(retainedOrder);
    let anchor = null;
    for (let i = orderedViews.length - 1; i >= 0; i--) {
        const view = orderedViews[i];
        if (retainedOrder[i] >= 0 && stationary.has(i)) {
            anchor = view.node;
            continue;
        }
        const attached = view.node.parentNode === parent;
        parent.insertBefore(view.node, anchor);
        if (attached) moved++;
        anchor = view.node;
    }
    return { created, moved, removed };
}
