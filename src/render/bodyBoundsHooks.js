import { Material } from 'three';

// Only audited position/depth-preserving wrappers register their exact hook
// identity. A later replacement, or a wrapper around an unknown prior hook,
// remains unsafe. No userData boolean can silently bless arbitrary shader code.
const trusted = new WeakMap();
export function isBodyBoundsHookSafe(material, hook) {
    return typeof material[hook] === 'function' &&
        (material[hook] === Material.prototype[hook] || trusted.get(material)?.[hook] === material[hook]);
}
export function registerBodyBoundsHook(material, hook) {
    if (hook !== 'onBeforeCompile' && hook !== 'onBeforeRender') throw new Error('Unsupported body-bounds hook');
    let hooks = trusted.get(material);
    if (!hooks) { hooks = { onBeforeCompile: null, onBeforeRender: null }; trusted.set(material, hooks); }
    hooks[hook] = material[hook];
}
export function bodyBoundsHooksSafe(material) {
    return isBodyBoundsHookSafe(material, 'onBeforeCompile') && isBodyBoundsHookSafe(material, 'onBeforeRender');
}
