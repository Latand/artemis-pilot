// Current functional runs of preserved, immutable river harnesses. No archived
// source identity, cross-root equality or paired timing acceptance is claimed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const currentRiverHarnesses = Object.freeze({
  foreign: { file: 'verify-foreign-river.mjs', sha256: 'b11e93503d617315dc672e75739986a2abd0519ed819abde49e4307980b217a0' },
  radiance: { file: 'verify-river-radiance.mjs', sha256: 'ff04a01ab81395bcfbc083174987c457c1a948e022d8adfb956f365d853684c6' },
});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function currentRiverProfile(kind, { device = 'desktop', suite = 'transient' } = {}) {
  assert(Object.hasOwn(currentRiverHarnesses, kind), 'Known current river suite');
  assert(['desktop', 'mobile'].includes(device), 'Known device');
  assert(['transient', 'lifecycle'].includes(suite), 'Known radiance suite');
  const cadence = kind === 'radiance' && device === 'mobile' && suite === 'lifecycle';
  return { device, suite, qualityMode: cadence ? 'low' : 'high', particleWidth: cadence ? 96 : null,
    expectedComputeEvery: cadence ? 2 : null };
}
export function adaptCurrentRiver(kind, source, options = {}) {
  assert(Object.hasOwn(currentRiverHarnesses, kind), 'Known current river suite');
  assert.equal(sha(source), currentRiverHarnesses[kind].sha256, 'Exact immutable functional harness required');
  const profile = currentRiverProfile(kind, options), substitutions = [];
  function once(before, after, reason) {
    assert.equal(source.split(before).length, 2, `Current river adapter seam: ${reason}`);
    source = source.replace(before, after); substitutions.push({ before, after, reason });
  }
  once('const report = { ', `const report = { historicalAttestation: false, pairedSourceAcceptance: false, performanceAcceptance: false, qualityMode: ${JSON.stringify(profile.qualityMode)}, particleWidthOverride: ${profile.particleWidth}, `, 'explicit current-only provenance');
  const query = `/?quality=${profile.qualityMode}&${profile.particleWidth ? `np=${profile.particleWidth}&` : ''}`;
  once('/?'+(kind === 'foreign' ? 'tier1=0' : 'focus=sun'), query+(kind === 'foreign' ? 'tier1=0' : 'focus=sun'), 'explicit fixture mode and particle capacity');
  if (kind === 'radiance') {
    if (profile.qualityMode === 'low') {
      once('Production device quality at DPR1 and full texture counts;', 'Current mobile Low cadence at DPR1 with np=96 (9,216 texels);', 'accurate Low lifecycle scope');
      once(': full production device quality`,', ': full particle capacity and DPR1`,', 'accurate capacity assertion label');
    }
    once('process.argv.slice(2, 4)', 'process.argv.slice(2, 3)', 'one current production root');
    once("assert.equal(roots.length, 2, 'Pass baseline and candidate roots');", "assert.equal(roots.length, 1, 'Pass one current production root');", 'single-root invocation');
    once('process.argv[4]', 'process.argv[3]', 'current output argument');
    once("const name = `${ri ? 'candidate' : 'baseline'}", 'const name = `current', 'honest current image labels');
    once("'Owner-radiance paired transient; 20 frames per view; no equilibrium or performance claim'", "'Current-source owner-radiance transient; 20 frames per view; no equilibrium or performance claim'", 'honest functional scope');
    once('if (ri) check(`${name} frame ${i}: gain follows rendered owner snapshot`', 'check(`${name} frame ${i}: gain follows rendered owner snapshot`', 'current root must pass all candidate gain controls');
    once("roots[1] + '/'", "roots[0] + '/'", 'current sparse-identity function');
    const start = source.indexOf('    for (const spec of cases) {\n      const rows = report.cases.filter');
    const end = source.indexOf("    check('No browser/shader errors'", start);
    assert(start > 0 && end > start, 'Exact historical paired-only comparison block');
    const pair = source.slice(start, end);
    assert.equal(sha(pair), '09b8e8cf6d4020bd944a3a5e38ceccfe59cdb66c8be530c276ec0af8a71f7005');
    once(pair, '    // Current-only run: no historical cross-root field or shader equality claim.\n', 'omit only paired-source comparison');
  }
  return { source, substitutions, profile };
}
// Materialization changes module resolution only. The harness's fixture URLs
// still resolve relative to its preserved original file, never a temp copy.
export function materializeCurrentRiver(source, originalURL) {
  return source.replace(/^import (.+?) from (['"])([^'"]+)\2;/gm,
    (_, clause, quote, specifier) => `import ${clause} from ${JSON.stringify(import.meta.resolve(specifier))};`)
    .replaceAll('import.meta.url', JSON.stringify(originalURL));
}
function bindSource(root) {
  const { productionPaths } = JSON.parse(readFileSync(new URL('./fixtures/travel-radiance-inputs.json', import.meta.url)));
  // Include ignored served/config inputs such as .env.local as actual bytes.
  const paths = [...new Set(execFileSync('git', ['ls-files', '-co', '-z', '--',
    ...productionPaths, 'scripts', '.github/workflows/river-current-validation.yml'],
    { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  return { revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    files: Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(root, path)))])) };
}
async function main() {
  const [kind, rootArg = '.', outArg = 'evidence/river-current', ...options] = process.argv.slice(2);
  assert(Object.hasOwn(currentRiverHarnesses, kind)); assert(options.every(option => option === '--validate'));
  const root = resolve(rootArg), out = resolve(outArg), validate = options.includes('--validate');
  const originalURL = new URL(currentRiverHarnesses[kind].file, import.meta.url).href;
  const original = readFileSync(fileURLToPath(originalURL), 'utf8'), adapted = adaptCurrentRiver(kind, original, { device: process.env.DEVICE || 'desktop',
    suite: kind === 'radiance' ? process.env.RADIANCE_SUITE || 'transient' : 'transient' });
  const effective = materializeCurrentRiver(adapted.source, originalURL);
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: effective });
  mkdirSync(out, { recursive: true });
  const provenance = { kind, profile: adapted.profile, mode: validate ? 'validate' : 'run', passed: false, historicalAttestation: false,
    pairedSourceAcceptance: false, performanceAcceptance: false, sourceBefore: bindSource(root), sourceAfter: null,
    originalHarnessSha256: sha(original), effectiveHarnessSha256: sha(effective),
    adaptations: adapted.substitutions.map(({ reason }) => reason), errors: [] };
  if (process.env.EXPECTED_CANDIDATE_REVISION) assert.equal(provenance.sourceBefore.revision, process.env.EXPECTED_CANDIDATE_REVISION);
  const path = join(out, 'current-source.json');
  writeFileSync(path, JSON.stringify(provenance, null, 2)+'\n', { flag: 'wx' });
  writeFileSync(join(out, 'effective-harness.mjs'), effective);
  const temporary = mkdtempSync(join(tmpdir(), 'current-river-'));
  try {
    const entry = join(temporary, 'harness.mjs'); writeFileSync(entry, effective);
    const child = spawnSync(process.execPath, [entry, root, out, ...options], { cwd: root, stdio: 'inherit' });
    assert.equal(child.status, 0, `Current ${kind} functional harness failed; raw evidence retained`);
    provenance.passed = true;
  } catch (error) { provenance.errors.push(error.stack || String(error)); process.exitCode = 1; }
  finally {
    try { provenance.sourceAfter = bindSource(root); assert.deepEqual(provenance.sourceAfter, provenance.sourceBefore); }
    catch (error) { provenance.passed = false; provenance.errors.push(error.stack || String(error)); process.exitCode = 1; }
    writeFileSync(path + '.tmp', JSON.stringify(provenance, null, 2)+'\n');
    const { renameSync } = await import('node:fs'); renameSync(path + '.tmp', path);
    rmSync(temporary, { recursive: true, force: true });
  }
  assert(provenance.passed, `Current ${kind} source/runtime checks did not pass`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
