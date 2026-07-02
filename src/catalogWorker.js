import { bvToTeff, teffToRGB, absMagFromApparent } from "./render/viewBrightness.js";

// True Teff-based hue (no apparent-magnitude gain baked in — WP16 a1/b: color
// is intrinsic to the star, brightness comes from observer-relative
// photometry evaluated per-frame in the point shader instead).
function starColor(tempK, bv, out) {
    const teff = tempK > 0 ? tempK : bvToTeff(bv);
    return teffToRGB(teff, out);
}

// Absolute magnitude (and from it, solar luminosity) for a catalog row: prefer
self.onmessage = async e => {
    try {
        const { url, meta, vals: inputVals, pcScene, suppress = [] } = e.data;
        let data = meta || null;
        let vals = inputVals ? new Float32Array(inputVals) : null;
        let fetched = false;
        if (!data || !vals) {
            const res = await fetch(url);
            if (!res.ok) throw new Error("HTTP " + res.status);
            data = await res.json();
            const binUrl = new URL(data.binary, new URL(url, self.location.href));
            const binRes = await fetch(binUrl);
            if (!binRes.ok) throw new Error("catalog binary HTTP " + binRes.status);
            vals = new Float32Array(await binRes.arrayBuffer());
            fetched = true;
        }
        const fields = data.fields || [];
        const field = name => {
            const i = fields.indexOf(name);
            return i >= 0 ? i : null;
        };
        const stride = data.stride || fields.length || 5;
        const iX = field("xPc") ?? 0;
        const iY = field("yPc") ?? 1;
        const iZ = field("zPc") ?? 2;
        const iBv = field("bv") ?? 3;
        const iMag = field("mag") ?? 4;
        const iMass = field("massSolar");
        const iRadius = field("radiusSolar");
        const iLum = field("lumSolar");
        const iTemp = field("tempK");
        const iAbsMag = field("absMag");
        const count = Math.floor(vals.length / stride);
        const keep = new Uint8Array(count);
        let kept = 0;
        const suppressR2 = 0.18 * 0.18;
        for (let i = 0, j = 0; i < count; i++, j += stride) {
            let suppressed = false;
            for (let k = 0; k < suppress.length; k += 3) {
                const dx = vals[j + iX] - suppress[k], dy = vals[j + iY] - suppress[k + 1], dz = vals[j + iZ] - suppress[k + 2];
                if (dx * dx + dy * dy + dz * dz <= suppressR2) { suppressed = true; break; }
            }
            if (!suppressed) { keep[i] = 1; kept++; }
        }
        const pos = new Float32Array(kept * 3);
        const col = new Float32Array(kept * 3);
        // Per-star absolute magnitude — the observer-relative photometric
        // truth source. The shader turns this + camera distance into apparent
        // brightness every frame, so it replaces the old "bake distance-from-
        // Sol into the color gain" scheme (that's the root cause of the
        // near-Sun brightness bubble at galaxy zoom: WP16 a1).
        const absMag = new Float32Array(kept);
        const c = [1, 1, 1];
        const stats = {
            sourceCount: count,
            massEstimated: 0,
            radiusEstimated: 0,
            lumEstimated: 0,
            tempEstimated: 0,
            massSolarSum: 0,
        };
        let out = 0;
        for (let i = 0, j = 0; i < count; i++, j += stride) {
            if (!keep[i]) continue;
            const xPc = vals[j + iX], yPc = vals[j + iY], zPc = vals[j + iZ];
            pos[out * 3] = xPc * pcScene;
            pos[out * 3 + 1] = zPc * pcScene;
            pos[out * 3 + 2] = -yPc * pcScene;
            const mass = iMass === null ? NaN : vals[j + iMass];
            const radius = iRadius === null ? NaN : vals[j + iRadius];
            const lum = iLum === null ? NaN : vals[j + iLum];
            const temp = iTemp === null ? NaN : vals[j + iTemp];
            const absMagField = iAbsMag === null ? NaN : vals[j + iAbsMag];
            const mag = vals[j + iMag];
            const distPc = Math.sqrt(xPc * xPc + yPc * yPc + zPc * zPc);
            absMag[out] = lum > 0
                ? -2.5 * Math.log10(lum) + 4.74
                : Number.isFinite(absMagField)
                    ? absMagField
                    : absMagFromApparent(mag, distPc);
            starColor(temp, vals[j + iBv], c);
            col[out * 3] = c[0];
            col[out * 3 + 1] = c[1];
            col[out * 3 + 2] = c[2];
            if (mass > 0) { stats.massEstimated++; stats.massSolarSum += mass; }
            if (radius > 0) stats.radiusEstimated++;
            if (lum > 0) stats.lumEstimated++;
            if (temp > 0) stats.tempEstimated++;
            out++;
        }
        const msg = {
            ok: true,
            count: kept,
            sourceCount: count,
            stats,
            schema: data.schema || 1,
            meta: data,
            pos: pos.buffer,
            col: col.buffer,
            absMag: absMag.buffer,
        };
        const transfer = [pos.buffer, col.buffer, absMag.buffer];
        if (fetched) {
            msg.vals = vals.buffer;
            transfer.push(vals.buffer);
        }
        self.postMessage(msg, transfer);
    } catch (err) {
        self.postMessage({ ok: false, error: err?.message || String(err) });
    }
};
