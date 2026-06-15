const INDEX_CELL_PC = 8;
const MIN_ACTIVE_RADIUS_SOLAR = 0.01;

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function isEvolvedSpectralClass(spect) {
    const s = String(spect || "").toUpperCase().replace(/IV/g, "");
    return /(^|[^A-Z])(I|II|III)(A|B|AB)?([^A-Z]|$)/.test(s);
}

function isLowMassMDwarf(mass, spect) {
    return mass > 0 && mass <= .25 && /(^|[^A-Z])D?M|^M|\bM\d/i.test(String(spect || ""));
}

function catalogRuntimeRadiusSolar(mass, radius, spect = "") {
    const m = Number(mass), r = Number(radius);
    if (r >= MIN_ACTIVE_RADIUS_SOLAR) return r;
    if (isLowMassMDwarf(m, spect)) return clamp(m * 1.05, .08, .28);
    return r;
}

function catalogPhysicsUsable(mass, radius, lum, spect = "") {
    const m = Number(mass), r = Number(radius), l = Number.isFinite(Number(lum)) ? Number(lum) : 0;
    const activeRadius = catalogRuntimeRadiusSolar(m, r, spect);
    if (!(m > 0) || !(activeRadius >= MIN_ACTIVE_RADIUS_SOLAR)) return false;
    if (m > 4 && r < 1 && l < 100) return false;
    if (m > 8 && l < 100) return false;
    if (isEvolvedSpectralClass(spect) && r < 1 && l < 1) return false;
    return true;
}

function indexKey(ci, cj, ck) {
    return ci + "," + cj + "," + ck;
}

function field(fields, name, fallback) {
    const i = fields.indexOf(name);
    return i >= 0 ? i : fallback;
}

function catalogSignature(meta, vals) {
    return [
        meta.schema || 1,
        meta.count || Math.floor(vals.length / (meta.stride || 10)),
        meta.stride || 10,
        vals.length,
        meta.binary || "",
        meta.source || "",
    ].join(":");
}

self.onmessage = async e => {
    try {
        const { url, signature } = e.data || {};
        if (!url) throw new Error("missing catalog url");
        const res = await fetch(url);
        if (!res.ok) throw new Error("catalog metadata HTTP " + res.status);
        const meta = await res.json();
        const binUrl = new URL(meta.binary, new URL(url, self.location.href));
        const binRes = await fetch(binUrl);
        if (!binRes.ok) throw new Error("catalog binary HTTP " + binRes.status);
        const vals = new Float32Array(await binRes.arrayBuffer());
        const sig = catalogSignature(meta, vals);
        if (signature && signature !== sig) throw new Error("catalog signature changed");

        const fields = meta.fields || [];
        const stride = meta.stride || fields.length || 10;
        const count = Math.min(meta.count || Math.floor(vals.length / stride), Math.floor(vals.length / stride));
        const fieldMap = {
            x: field(fields, "xPc", 0),
            y: field(fields, "yPc", 1),
            z: field(fields, "zPc", 2),
            lum: field(fields, "lumSolar", 6),
            mass: field(fields, "massSolar", 8),
            radius: field(fields, "radiusSolar", 9),
        };
        const labels = new Map((meta.labels || []).map(row => [row[0], row]));
        const buckets = new Map();
        let indexCount = 0;
        for (let i = 0, base = 0; i < count; i++, base += stride) {
            const mass = vals[base + fieldMap.mass];
            const radius = vals[base + fieldMap.radius];
            const lum = vals[base + fieldMap.lum];
            if (!catalogPhysicsUsable(mass, radius, lum, labels.get(i)?.[5])) continue;
            const ci = Math.floor(vals[base + fieldMap.x] / INDEX_CELL_PC);
            const cj = Math.floor(vals[base + fieldMap.y] / INDEX_CELL_PC);
            const ck = Math.floor(vals[base + fieldMap.z] / INDEX_CELL_PC);
            const key = indexKey(ci, cj, ck);
            let bucket = buckets.get(key);
            if (!bucket) buckets.set(key, bucket = []);
            bucket.push(i);
            indexCount++;
        }

        const cells = buckets.size;
        const coords = new Int32Array(cells * 3);
        const offsets = new Uint32Array(cells + 1);
        const indices = new Int32Array(indexCount);
        let cell = 0, out = 0;
        for (const [key, bucket] of buckets) {
            const parts = key.split(",");
            coords[cell * 3] = Number(parts[0]);
            coords[cell * 3 + 1] = Number(parts[1]);
            coords[cell * 3 + 2] = Number(parts[2]);
            offsets[cell] = out;
            indices.set(bucket, out);
            out += bucket.length;
            cell++;
        }
        offsets[cell] = out;
        self.postMessage({
            ok: true,
            signature: sig,
            cells,
            indexCount,
            coords: coords.buffer,
            offsets: offsets.buffer,
            indices: indices.buffer,
        }, [coords.buffer, offsets.buffer, indices.buffer]);
    } catch (err) {
        self.postMessage({ ok: false, error: err?.message || String(err) });
    }
};
