// Compares epoch captures (scripts/capture-galaxy-epochs.mjs) of one or two
// revisions: how much each view at each epoch differs from the same view at
// t = 0, from the same epoch of the other revision, and how continuously the
// dense series evolves. A rigidly rotating drawing is frozen in the views that
// co-rotate with the spiral pattern (correlation 1 with t = 0 at every epoch).
//
//   node scripts/analyze-galaxy-epochs.mjs <dir> [<other dir>] [> table.md]
import { readFile } from "node:fs/promises";

const dirs = process.argv.slice(2);
const reports = await Promise.all(dirs.map(async d => JSON.parse(await readFile(`${d}/report.json`, "utf8"))));
const names = dirs.map(d => d.split("/").filter(Boolean).pop());

// Pearson correlation of the high-pass luminance (thumb minus its 5x5 box
// blur): structure, not the overall disk profile.
function highPass(t) {
    const N = Math.round(Math.sqrt(t.length)), out = new Float64Array(t.length);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let s = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
            s += t[yy * N + xx]; n++;
        }
        out[y * N + x] = t[y * N + x] - s / n;
    }
    return out;
}
function corr(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 1;
}
const frameOf = (r, view, t) => r.frames.find(f => f.view === view && f.tMyr === t && !f.name.startsWith("series"));
const fmt = v => (v === null || v === undefined) ? "-" : v.toFixed(3);

const views = [...new Set(reports[0].frames.filter(f => !f.name.startsWith("series")).map(f => f.view))];
const epochs = [...new Set(reports[0].frames.filter(f => !f.name.startsWith("series")).map(f => f.tMyr))].sort((a, b) => a - b);
console.log(`Structure correlation with t = 0 (high-pass luminance, ${names.join(" / ")}):\n`);
console.log(`| view | ${epochs.map(t => `${t} Myr`).join(" | ")} |`);
console.log(`| --- | ${epochs.map(() => "---:").join(" | ")} |`);
for (const view of views) {
    const cells = epochs.map(t => reports.map(r => {
        const f = frameOf(r, view, t), z = frameOf(r, view, 0);
        return f && z ? fmt(corr(highPass(f.thumb), highPass(z.thumb))) : "-";
    }).join(" / "));
    console.log(`| ${view} | ${cells.join(" | ")} |`);
}
console.log(`\nMean luminance (0..255, ${names.join(" / ")}):\n`);
console.log(`| view | ${epochs.map(t => `${t} Myr`).join(" | ")} |`);
console.log(`| --- | ${epochs.map(() => "---:").join(" | ")} |`);
for (const view of views) {
    const cells = epochs.map(t => reports.map(r => { const f = frameOf(r, view, t); return f ? f.mean.toFixed(1) : "-"; }).join(" / "));
    console.log(`| ${view} | ${cells.join(" | ")} |`);
}
for (const [i, r] of reports.entries()) {
    const s = r.frames.filter(f => f.name.startsWith("series")).sort((a, b) => a.tMyr - b.tMyr);
    if (s.length < 3) continue;
    const hp = s.map(f => highPass(f.thumb));
    const step = [], toZero = [];
    for (let k = 1; k < s.length; k++) step.push(corr(hp[k - 1], hp[k]));
    for (let k = 0; k < s.length; k++) toZero.push(corr(hp[0], hp[k]));
    const dt = s[1].tMyr - s[0].tMyr;
    console.log(`\nSeries ${names[i]} (${s[0].view}, ${s[0].tMyr}-${s[s.length - 1].tMyr} Myr every ${dt} Myr): frame-to-frame correlation min ${Math.min(...step).toFixed(3)} median ${step.sort((a, b) => a - b)[step.length >> 1].toFixed(3)}; correlation with the first frame min ${Math.min(...toZero).toFixed(3)}, at the end ${toZero[toZero.length - 1].toFixed(3)}`);
}
