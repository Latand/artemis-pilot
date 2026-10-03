// Catalog aliases describe identity, never motion or the current position.
// Keep them separate from stableStarKey: adding a catalog alias must not reseed
// an already explored curated system or change its persisted child focus IDs.
const aliases = new Map([
    ['SIRIUS','SIRIUS A'], ['PROCYON','PROCYON A'],
    ['RIGIL KENTAURUS','ALPHA CEN A'], ['TOLIMAN','ALPHA CEN B'],
    ['PROXIMA CENTAURI','PROXIMA'], ['RAN','EPSILON ERIDANI'],
    ["BARNARD'S STAR",'BARNARD'], ['BARNARDS STAR','BARNARD'],
    ["VAN MAANEN'S STAR",'VAN MAANEN'], ['VAN MAANENS STAR','VAN MAANEN'],
]);
export function canonicalDestinationName(value) {
    const name = String(value || '').toUpperCase().replace(/[’`]/g,"'").replace(/\s+/g,' ').trim();
    return aliases.get(name) || name;
}
export function catalogIdentityKeys(star) {
    const keys = [];
    for (const field of ['hip','hd','hr']) if (Number(star?.[field]) > 0) keys.push(field + ':' + Number(star[field]));
    const name = canonicalDestinationName(star?.name);
    if (name) keys.push('name:' + name);
    return keys;
}
