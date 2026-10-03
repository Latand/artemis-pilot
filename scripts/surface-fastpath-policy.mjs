const exposureDefine = 'SURFACE_ROTATION_EXPOSURE,1,';
export function coldExactPrograms(material) {
    const programs = material.cachedPrograms || [];
    return !material.variant && programs.length > 0 &&
        new Set(programs.map(p => p.id)).size === programs.length &&
        programs.every(p => !p.key.includes(exposureDefine)) &&
        programs.some(p => p.id === material.programId && p.key === material.programCacheKey);
}
export function oneActiveExposureProgram(before, after) {
    if (!coldExactPrograms(before) || !after.variant) return false;
    const programs = after.cachedPrograms || [], baseline = before.cachedPrograms;
    const added = programs.filter(p => !baseline.some(old => old.id === p.id));
    return programs.length === baseline.length + 1 && added.length === 1 &&
        added[0].id === after.programId && added[0].key === after.programCacheKey &&
        after.programCacheKey.split(exposureDefine).length === 2 &&
        after.programCacheKey.replace(exposureDefine, '') === before.programCacheKey &&
        baseline.every(old => programs.some(p => p.id === old.id && p.key === old.key));
}
