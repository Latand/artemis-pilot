import assert from 'node:assert/strict';
import { writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { acceptance, verifyPinnedAcceptanceInputs, verifyCleanAcceptanceInputs } from '../../scripts/verify-radiance-acceptance.mjs';

export const MAIN = 'ab51029827cf9324eb737673e46c49ab74aa1718';
export const harnessPaths = [
    'docs/media/capture-readme-media.mjs', 'docs/media/capture-support.mjs',
    'docs/media/smoke-readme-capture.mjs', '.github/workflows/readme-media.yml',
];
// Reuse the reviewed inventory and guards, including Vite's implicit inputs.
export const protectedPaths = [...acceptance.productionPaths,
    'scripts/verify-radiance-acceptance.mjs',
    'scripts/fixtures/radiance-acceptance.json',
    'scripts/fixtures/radiance-acceptance-metadata.json',
];
export function verifyCaptureSource(root, reference = MAIN) {
    verifyPinnedAcceptanceInputs(root, reference, protectedPaths);
    verifyCleanAcceptanceInputs(root, harnessPaths);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    return { head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
        productionReference: reference, protectedPaths };
}
export async function saveReport(path, report) {
    await writeFile(path + '.tmp', JSON.stringify(report, null, 2) + '\n');
    await rename(path + '.tmp', path);
}
export async function bounded(action, timeoutMs, label) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}
// All startup, route, video-finalization and cleanup errors leave passed=false.
// The route cannot mark success. Only the lifecycle owner may do so after cleanup.
export async function runCaptureLifecycle({ report, save, capture, timeoutMs = 32 * 60_000, closeTimeoutMs = 15_000 }) {
    const resources = { server: null, browser: null, context: null };
    let failure;
    report.passed = false;
    report.errors ||= [];
    try {
        await save();
        await bounded(() => capture(resources), timeoutMs, 'Capture');
        assert.equal(report.routeAssertionsPassed, true, 'Completed route assertions required');
        assert.equal(report.videoFinalized, true, 'Finalized recording required');
        assert(report.videoBytes > 0, 'Nonempty finalized recording required');
    } catch (error) { failure = error; }
    finally {
        report.cleanupErrors = [];
        for (const name of ['context', 'browser', 'server']) {
            const resource = resources[name];
            if (!resource) continue;
            try { await bounded(() => resource.close(), closeTimeoutMs, `${name} cleanup`); }
            catch (error) { report.cleanupErrors.push(String(error.stack || error)); failure ||= error; }
        }
        if (report.errors.length) failure ||= new Error(`Capture logged ${report.errors.length} page/WebGL error(s), including finalization and cleanup`);
        report.passed = !failure;
        if (failure) report.failure = String(failure.stack || failure);
        report.finishedAt = new Date().toISOString();
        try { await save(); }
        catch (error) { report.passed = false; report.failure ||= String(error.stack || error); throw error; }
    }
    if (failure) throw failure;
    return report;
}
