function colorMix(a, b, t) {
    return [
        a[0] * (1 - t) + b[0] * t,
        a[1] * (1 - t) + b[1] * t,
        a[2] * (1 - t) + b[2] * t,
    ];
}

function bvColor(ci, mag, out) {
    const bv = Number.isFinite(ci) ? Math.max(-0.35, Math.min(2.0, ci)) : 0.65;
    const t = Math.max(0, Math.min(1, (bv + .35) / 2.35));
    let c;
    if (t < .34) c = colorMix([.58, .68, 1.0], [.93, .96, 1.0], t / .34);
    else if (t < .58) c = colorMix([.93, .96, 1.0], [1.0, .86, .58], (t - .34) / .24);
    else c = colorMix([1.0, .86, .58], [1.0, .42, .28], (t - .58) / .42);
    const gain = Math.max(.32, Math.min(1.55, 1.12 - ((Number.isFinite(mag) ? mag : 9) - 5) * .055));
    out[0] = Math.min(1, c[0] * gain);
    out[1] = Math.min(1, c[1] * gain);
    out[2] = Math.min(1, c[2] * gain);
}

self.onmessage = async e => {
    try {
        const { url, pcScene, suppress = [] } = e.data;
        const res = await fetch(url);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const binUrl = new URL(data.binary, new URL(url, self.location.href));
        const binRes = await fetch(binUrl);
        if (!binRes.ok) throw new Error("catalog binary HTTP " + binRes.status);
        const vals = new Float32Array(await binRes.arrayBuffer());
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
            pos[out * 3] = vals[j + iX] * pcScene;
            pos[out * 3 + 1] = vals[j + iZ] * pcScene;
            pos[out * 3 + 2] = -vals[j + iY] * pcScene;
            bvColor(vals[j + iBv], vals[j + iMag], c);
            col[out * 3] = c[0];
            col[out * 3 + 1] = c[1];
            col[out * 3 + 2] = c[2];
            const mass = iMass === null ? NaN : vals[j + iMass];
            const radius = iRadius === null ? NaN : vals[j + iRadius];
            const lum = iLum === null ? NaN : vals[j + iLum];
            const temp = iTemp === null ? NaN : vals[j + iTemp];
            if (mass > 0) { stats.massEstimated++; stats.massSolarSum += mass; }
            if (radius > 0) stats.radiusEstimated++;
            if (lum > 0) stats.lumEstimated++;
            if (temp > 0) stats.tempEstimated++;
            out++;
        }
        self.postMessage({
            ok: true,
            count: kept,
            sourceCount: count,
            stats,
            schema: data.schema || 1,
            meta: data,
            vals: vals.buffer,
            pos: pos.buffer,
            col: col.buffer,
        }, [pos.buffer, col.buffer, vals.buffer]);
    } catch (err) {
        self.postMessage({ ok: false, error: err?.message || String(err) });
    }
};
