import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN, harnessPaths, protectedPaths, runCaptureLifecycle, saveReport, verifyCaptureSource } from './capture-support.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'readme-capture-smoke-'));
let cases = 0;
async function test(label, run) { await run(); cases++; console.log(`PASS ${label}`); }
try {
    const fixture = join(temporary, 'source'); mkdirSync(fixture);
    const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
    const put = (p, data) => { mkdirSync(dirname(join(fixture,p)), {recursive:true}); writeFileSync(join(fixture,p),data); };
    const commit = () => git('-c','user.name=QA fixture','-c','user.email=fixture@example.invalid','commit','-qm','Synthetic input');
    git('init','-q'); put('.gitignore','*.local\n');
    const inputs = ['src/main.js','public/data.json','index.html','package.json','package-lock.json','bun.lock','vite.config.js',
        'scripts/galaxy-preview-plugin.mjs','scripts/verify-radiance-acceptance.mjs','scripts/fixtures/radiance-acceptance.json',
        'scripts/fixtures/radiance-acceptance-metadata.json', ...harnessPaths];
    for (const p of inputs) put(p,'accepted\n');
    git('add','.');commit(); const reference=git('rev-parse','HEAD');
    await test('clean immutable source and committed harness pass',()=>verifyCaptureSource(fixture,reference));
    for (const p of inputs.filter(p=>!harnessPaths.includes(p))) {
        await test(`dirty, staged-masked and committed-masked input rejected: ${p}`,()=>{
            put(p,'changed\n'); assert.throws(()=>verifyCaptureSource(fixture,reference),/worktree differs/);
            git('add',p);put(p,'accepted\n');assert.throws(()=>verifyCaptureSource(fixture,reference),/index differs/);
            put(p,'changed\n');commit();put(p,'accepted\n');assert.throws(()=>verifyCaptureSource(fixture,reference),/Committed acceptance inputs differ/);
            git('reset','--hard',reference);verifyCaptureSource(fixture,reference);
        });
    }
    for (const p of ['.env.local','.env.production','vite.config.ts','postcss.config.js','.postcssrc.json','tsconfig.json','jsconfig.json','npm-shrinkwrap.json','.npmrc']) {
        await test(`untracked/ignored and committed-masked implicit input rejected: ${p}`,()=>{
            put(p,'implicit\n');assert.throws(()=>verifyCaptureSource(fixture,reference),/Untracked acceptance input/);
            git('add','-f',p);commit();rmSync(join(fixture,p));assert.throws(()=>verifyCaptureSource(fixture,reference),/Committed acceptance inputs differ/);
            git('reset','--hard',reference);
        });
    }
    for (const p of harnessPaths) {
        await test(`dirty and staged-masked capture helper rejected: ${p}`,()=>{
            put(p,'changed\n');assert.throws(()=>verifyCaptureSource(fixture,reference),/worktree differs/);
            git('add',p);put(p,'accepted\n');assert.throws(()=>verifyCaptureSource(fixture,reference),/index differs/);
            git('reset','--hard',reference);
        });
    }
    const runMock=async(kind)=>{
        const report={}, saved=[], closed=[];
        const resource=name=>({close:async()=>{closed.push(name);if(kind==='late-page-error'&&name==='context')report.errors.push('Late page/WebGL error');if(kind===`${name}-close`)throw new Error(kind);if(kind===`${name}-hang`)await new Promise(()=>{});}});
        const save=async()=>{if(kind==='save-final'&&saved.length)throw new Error(kind);saved.push(structuredClone(report));};
        const capture=async r=>{
            if(kind==='create-server')throw new Error(kind);
            r.server=resource('server');if(kind==='listen'||kind==='launch')throw new Error(kind);
            r.browser=resource('browser');if(kind==='new-context')throw new Error(kind);
            r.context=resource('context');
            if(kind==='route')throw new Error(kind);
            if(kind==='capture-hang')await new Promise(()=>{});
            report.routeAssertionsPassed=true;
            if(['video-flush','video-path','video-stat'].includes(kind))throw new Error(kind);
            report.videoBytes=kind==='empty-video'?0:1024;report.videoFinalized=true;
        };
        const action=()=>runCaptureLifecycle({report,save,capture,timeoutMs:40,closeTimeoutMs:10});
        if(kind==='success') { await action();assert.equal(report.passed,true);assert.deepEqual(closed,['context','browser','server']); }
        else { await assert.rejects(action);assert.equal(report.passed,false);if(kind!=='create-server')assert(closed.includes('server')); }
        assert.equal(saved[0].passed,false);
        if(kind!=='save-final')assert.equal(saved.at(-1).passed,kind==='success');
        return {report,saved};
    };
    for(const kind of ['success','create-server','listen','launch','new-context','route','video-flush','video-path','video-stat','empty-video','late-page-error','context-close','browser-close','server-close','capture-hang','browser-hang','save-final'])
        await test(`lifecycle ${kind}`,()=>runMock(kind));
    await test('atomic report replacement is readable and leaves no temporary file',async()=>{
        const p=join(temporary,'report.json');await saveReport(p,{passed:false});await saveReport(p,{passed:true,videoBytes:12});
        assert.deepEqual(JSON.parse(readFileSync(p)),{passed:true,videoBytes:12});assert(!readdirSync(temporary).includes('report.json.tmp'));
    });
    await test('actual final diff runs its required suites while the recording stays isolated',()=>{
        const paths=execFileSync('git',['diff','--name-only',MAIN,'HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n');
        assert(paths.includes('scripts/smoke-science-copy.mjs'),'Final diff contains the corrected science-copy guard');
        const glob=p=>new RegExp('^'+p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*/g,'\0').replace(/\*/g,'[^/]*').replace(/\0/g,'.*')+'$');
        const workflows=readdirSync(join(root,'.github/workflows')).filter(n=>/\.ya?ml$/.test(n));
        function matches(event, branch, changedPaths = paths) {
            const matched=[];
            for(const file of workflows){
                const lines=readFileSync(join(root,'.github/workflows',file),'utf8').split('\n');
                const start=lines.findIndex(line=>line===`  ${event}:`);if(start<0)continue;
                let end=start+1;while(end<lines.length&&!/^(?:\S|  \S)/.test(lines[end]))end++;
                const block=lines.slice(start,end).join('\n')+'\n';
                const list=key=>{
                    const inline=new RegExp(String.raw`^    ${key}: \[([^\]]*)\]`, 'm').exec(block);
                    if(inline)return inline[1].split(',').map(x=>x.trim().replace(/^['"]|['"]$/g,''));
                    const rows=new RegExp(String.raw`^    ${key}:\s*\n((?:      - .+\n)+)`, 'm').exec(block)?.[1];
                    return rows?[...rows.matchAll(/      - ['"]([^'"]+)['"]/g)].map(m=>m[1]):[];
                };
                const branches=list('branches');if(branches.length&&!branches.some(p=>glob(p).test(branch)))continue;
                const patterns=list('paths');
                if(changedPaths.some(p=>!patterns.length||patterns.some(pattern=>glob(pattern).test(p))))matched.push(file);
            }
            return matched.sort();
        }
        assert.deepEqual(matches('push','diagnostic/readme-media-20261004',harnessPaths),['readme-media.yml']);
        assert.deepEqual(matches('push','docs/refresh-readme-media-20261004'),[]);
        const expected=['foreign-river-validation.yml','galaxy-rendering.yml','navigation-visuals.yml'];
        assert.deepEqual(matches('pull_request','docs/refresh-readme-media-20261004'),expected);
        console.log(`Enumerated ${workflows.length} workflows against ${paths.length} final changed paths: PR runs ${expected.join(', ')}; recording remains exact diagnostic push-only`);
        const source=readFileSync(join(root,'.github/workflows/readme-media.yml'),'utf8');
        assert(source.includes('npm install --ignore-scripts --no-package-lock'));
        assert(source.includes('timeout-minutes: 35'));assert(source.includes('timeout-minutes: 40'));
        const helper=readFileSync(join(root,'docs/media/capture-readme-media.mjs'),'utf8');assert(!helper.includes('page.screenshot('));
        assert(protectedPaths.includes('scripts/galaxy-preview-plugin.mjs'));assert(protectedPaths.includes('.env*'));
    });
} finally {rmSync(temporary,{recursive:true,force:true});}
console.log(`README capture smoke passed: ${cases} cases`);
