import { STAR_CATALOG_META } from "../constants.js";

let metaPromise = null;
let dataPromise = null;
let cachedMeta = null;
let cachedVals = null;
let cachedMetaUrl = "";

function baseHref() {
    if (typeof location !== "undefined") return location.href;
    return import.meta.url;
}

function absoluteUrl(url, base = baseHref()) {
    return new URL(url, base).href;
}

export function hygCatalogMetaUrl() {
    return absoluteUrl(STAR_CATALOG_META.hygUrl);
}

export function hygCatalogBinaryUrl(meta, metaUrl = cachedMetaUrl || hygCatalogMetaUrl()) {
    return absoluteUrl(meta.binary, metaUrl);
}

export function cachedHygCatalogData() {
    return cachedMeta && cachedVals ? { meta: cachedMeta, vals: cachedVals, metaUrl: cachedMetaUrl } : null;
}

export function rememberHygCatalogData(meta, values, metaUrl = hygCatalogMetaUrl()) {
    if (!meta || !values) return null;
    cachedMeta = meta;
    cachedVals = values instanceof Float32Array ? values : new Float32Array(values);
    cachedMetaUrl = absoluteUrl(metaUrl);
    metaPromise = Promise.resolve(cachedMeta);
    dataPromise = Promise.resolve({ meta: cachedMeta, vals: cachedVals, metaUrl: cachedMetaUrl });
    return cachedHygCatalogData();
}

export async function loadHygCatalogMeta() {
    if (cachedMeta) return cachedMeta;
    if (!metaPromise) {
        const metaUrl = hygCatalogMetaUrl();
        metaPromise = fetch(metaUrl)
            .then(res => {
                if (!res.ok) throw new Error("catalog metadata HTTP " + res.status);
                cachedMetaUrl = metaUrl;
                return res.json();
            })
            .then(meta => {
                cachedMeta = meta;
                return meta;
            });
    }
    return metaPromise;
}

export async function loadHygCatalogData() {
    const cached = cachedHygCatalogData();
    if (cached) return cached;
    if (!dataPromise) {
        dataPromise = (async () => {
            const meta = await loadHygCatalogMeta();
            const binUrl = hygCatalogBinaryUrl(meta);
            const res = await fetch(binUrl);
            if (!res.ok) throw new Error("catalog binary HTTP " + res.status);
            const vals = new Float32Array(await res.arrayBuffer());
            return rememberHygCatalogData(meta, vals, cachedMetaUrl);
        })();
    }
    return dataPromise;
}
