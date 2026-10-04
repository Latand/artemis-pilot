// Read-only QA inspector. Serializable into both production revisions; accepts
// their actual Three scene/buffers rather than requiring one render hierarchy.
export function inspectExploredHostPoint({ scene, camera, host, group, activeStars, K, catalog }) {
    const hostWorld = camera.position.clone().set(host.x * K, (host.z || 0) * K, -host.y * K);
    const inScene = object => { for (let p = object; p; p = p.parent) if (p === scene) return true; return false; };
    const visible = object => { for (let p = object; p; p = p.parent) if (!p.visible) return false; return true; };
    const slotMatches = (mesh, i) => {
        mesh.updateWorldMatrix(true, false);
        const expected = mesh.worldToLocal(hostWorld.clone()), a = mesh.geometry.attributes;
        const actual = expected.clone().fromBufferAttribute(a.position, i);
        const tolerance = Math.max(1e-5, hostWorld.length() * Number.EPSILON * 4, expected.length() * 2 ** -22);
        return { index: i, error: actual.distanceTo(expected), tolerance,
            position: actual.distanceTo(expected) <= tolerance,
            photometry: a.radiusKm?.array[i] === Math.fround(host.R || 0) &&
                a.teffK?.array[i] === Math.fround(host.tempK || 5800) &&
                a.absMag?.array[i] === Math.fround(host.absMag),
        };
    };
    const drawnSlots = mesh => {
        const a = mesh.geometry.attributes.position, range = mesh.geometry.drawRange;
        const start = Math.max(0, range.start), end = Math.min(a.count, start + range.count);
        const matches = [];
        for (let i = start; i < end; i++) { const slot = slotMatches(mesh, i); if (slot.position) matches.push(slot); }
        return { start, count: end - start, matches, drawable: inScene(mesh) && visible(mesh) && mesh.material?.visible !== false };
    };
    const legacy = (group?.children || []).filter(child => child.isPoints).map(drawnSlots);
    const pool = scene.getObjectByName('active procedural stars');
    const pooled = pool?.isPoints ? drawnSlots(pool) : null;
    const expected = [...activeStars];
    if (host.activeCatalog && !expected.some(s => s.id === host.id)) expected.push(host);
    const expectedPoints = expected.filter(s => (s.procedural || s.activeCatalog) && !s.bh);
    const hostIndices = expectedPoints.flatMap((s, i) => s.id === host.id ? [i] : []);
    const legacyMatches = legacy.flatMap(row => row.matches), poolMatches = pooled?.matches || [];
    const matches = [...legacyMatches, ...poolMatches];
    const legacyValid = legacyMatches.length === 1 && legacy.some(row => row.drawable && row.count === 1 && row.matches.length === 1);
    const poolValid = hostIndices.length === 1 && pooled?.drawable && pooled.count === expectedPoints.length &&
        poolMatches.length === 1 && poolMatches[0].index === hostIndices[0];
    const backgroundSuppressed = catalog?.loaded === true && catalog.held === true && catalog.hidden === 1;
    return { pass: matches.length === 1 && matches[0].photometry && (legacyValid || poolValid) && backgroundSuppressed,
        mode: legacyMatches.length ? 'individual' : 'pooled', matchingHostPoints: matches.length,
        expectedPoolSlots: expectedPoints.length, expectedHostSlot: hostIndices, pooled, legacy, background: catalog };
}
