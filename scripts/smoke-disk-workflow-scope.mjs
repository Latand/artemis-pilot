import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { diskInputs, diskMaximumTaskPolicy } from './disk-plane-source-contract.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => readFileSync(new URL('../' + path, import.meta.url));
const workflow = read('.github/workflows/disk-plane-validation.yml').toString();
const guard = "    if: github.event.pull_request.number == 59 && github.event.pull_request.base.sha == '6179f23661591bb4dee89a0bf8e686233e1ba280'\n";
function validateRouting(text) {
    const split = text.indexOf('  pixels:\n'); assert(split > 0);
    const historical = text.slice(split), current = text.slice(text.indexOf('jobs:\n'), split);
    assert.equal(historical.split(guard).length, 3, 'Both historical jobs have the exact PR/base guard');
    // This digest covers all old commands, pins, thresholds, timeout budgets,
    // uploads and matrix cells from main fd41a0c, with only our guards removed.
    assert.equal(sha(historical.replaceAll(guard, '')), '9708278d5a3202e7d82b3479510dfce9be0e00c5663bd67ef8333ed360f0dc11');
    assert(!/^    if:/m.test(current), 'Current-source jobs must not be skipped by the historical route');
    assert(!/continue-on-error|workflow_dispatch/.test(text), 'No blanket success bypass or ambiguous manual event refs');
    const block = text.match(/^on:\n  pull_request:\n    paths:\n((?:      - '[^']+'\n)+)permissions:/m);
    assert(block, 'Keep protected PR input triggers');
    const paths = new Set([...block[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
    for (const path of [...diskInputs.productionPaths.map(p => ['src', 'public'].includes(p) ? p + '/**' : p),
        'scripts/**', '.github/workflows/disk-plane-validation.yml']) assert(paths.has(path), `Missing trigger ${path}`);
    for (const command of ['smoke-disk-workflow-scope', 'smoke-disk-plane-support', 'smoke-disk-frustum-fast-path',
        'smoke-disk-fast-path-lifecycle', 'smoke-disk-program-precision', 'smoke-disk-static-programs',
        'smoke-native-disk-proof', 'smoke-disk-plane-qa', 'smoke-disk-pointer-fixture', 'smoke-disk-plane-finalize',
        'smoke-context-recovery-qa', 'smoke-hole-appearance', 'smoke-hole-precision', 'smoke-hole-emission',
        'probe-disk-continuity-current']) assert(current.includes(`node scripts/${command}.mjs`), `Required current regression ${command}`);
    assert(!current.includes('--verify-main-scope'));
    assert(!current.includes('smoke-disk-source-binding.mjs'));
    assert(!current.includes('smoke-disk-plane-cost-contract.mjs'));
    for (const token of ['  current-model:\n', '  current-pixels:\n', '    needs: current-model\n',
        '        device: [desktop, mobile]\n', '        bloom: [0, 1]\n', '          npm run build\n']) assert(current.includes(token));
}
validateRouting(workflow);
for (const mutate of [text => text.replace(guard, ''), text => text.replace('number == 59', 'number != 59'),
    text => text.replace("      - 'src/**'\n", ''), text => text.replace('  current-model:\n', '  current-model:\n    if: false\n'),
    text => text.replace('node scripts/probe-disk-continuity-current.mjs', 'true'),
    text => text.replace('        bloom: [0, 1]', '        bloom: [0]')]) assert.throws(() => validateRouting(mutate(workflow)));
// Preserve the release harness and threshold definitions without depending on
// an orphaned historical benchmark object in an ordinary checkout.
for (const [path, expected] of Object.entries({
    'scripts/probe-disk-plane.mjs': '1d4dcb546b354edb4c91aad108ef7e2cce8281de107b4843b70c235879c0cfd8',
    'scripts/disk-plane-source-contract.mjs': '93cb5fb5878110ca733261b86e35021e828463a9b45e96750a0002a439f90dda',
    'scripts/disk-plane-qa.mjs': '96171e517d8b3bc3a565077165e835bcc804d563b38e24190486cae0723c9f34',
    'scripts/disk-plane-finalize.mjs': 'dea0c1878e723106b483ebc103f05da8985517aaf2b2700cdca306f926075fba',
    'scripts/fixtures/disk-plane-inputs.json': '8808fe44eca9c77e8fc15439cd9ac02e97bf2a8f3267c94038d0d9a3c89b161f',
    'scripts/benchmark-disk-plane.mjs': '01cce86ae10eb05c7f4d6faa58c9023fa4eabe76df1015869acfed4765c54396',
    'scripts/smoke-disk-plane-cost-contract.mjs': 'bb6631cf571ba69d7da137962aaaff4c554e324791a2761af5e1cfa98d4a415f',
})) assert.equal(sha(read(path)), expected, `Historical bytes: ${path}`);
assert.equal(diskMaximumTaskPolicy.absoluteFloorMs, 220);
assert.equal(diskMaximumTaskPolicy.baselineMultiplier, 1.10);
console.log('Disk routing: exact historical jobs and harness bytes preserved; current model/pixel jobs mandatory; all protected triggers, four pixel cells and six routing negative controls pass. No historical pixel/cost acceptance claimed.');
