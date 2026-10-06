// Diagnostic-only helpers. Installed only after all balanced timing windows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const sha = value => createHash('sha256').update(value).digest('hex');
export function installOverviewObservers() {
    Date.now = () => Date.UTC(2026, 9, 1, 12);
    localStorage.setItem('ap_introSeen', '1'); localStorage.setItem('ap_uiMode', 'observe'); localStorage.setItem('ap_perf', '0');
    window.__overviewAttribution = { enabled: false, callbacks: 0, callbackMs: 0, targetEntries: {}, rootWrites: [], rectReads: {}, droppedWrites: 0 };
    const NativeObserver = window.ResizeObserver;
    window.ResizeObserver = class extends NativeObserver {
        constructor(callback) {
            super((entries, observer) => {
                const d = window.__overviewAttribution, active = d.enabled, start = active ? performance.now() : 0;
                if (active) { d.callbacks++; for (const entry of entries) {
                    const key = entry.target.id || entry.target.tagName; d.targetEntries[key] = (d.targetEntries[key] || 0) + 1;
                } }
                try { callback.call(observer, entries, observer); } finally { if (active) d.callbackMs += performance.now() - start; }
            });
        }
    };
    const setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (...args) {
        const d = window.__overviewAttribution, active = d.enabled && this === document.documentElement.style;
        const before = active ? this.getPropertyValue(args[0]) : null;
        const result = setProperty.apply(this, args);
        if (active) {
            const record = { time: performance.now(), property: args[0], before, after: this.getPropertyValue(args[0]) };
            if (d.rootWrites.length < 1000) d.rootWrites.push(record); else d.droppedWrites++;
        }
        return result;
    };
    const rect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...args) {
        const d = window.__overviewAttribution;
        if (d.enabled && ['explorePanel', 'timeDock', 'exploreBar'].includes(this.id)) d.rectReads[this.id] = (d.rectReads[this.id] || 0) + 1;
        return rect.apply(this, args);
    };
}

// Install after warmup, only in the post-comparison attribution context.
export function installOverviewNativeAudit() {
    const { renderer, composer } = pairedQA.scene, gl = renderer.getContext();
    const ids = new WeakMap(); let nextId = 0;
    const id = object => object === null ? null : typeof object !== 'object' ? object :
        (ids.has(object) ? ids.get(object) : (ids.set(object, ++nextId), nextId));
    const audit = window.__overviewNativeAudit = { enabled: false, counts: {}, calls: [], dropped: 0, ids: id };
    const record = (name, args, extra = {}) => {
        if (!audit.enabled) return;
        audit.counts[name] = (audit.counts[name] || 0) + 1;
        if (audit.calls.length < 20000) audit.calls.push({ name, args: args.map(id), ...extra }); else audit.dropped++;
    };
    for (const name of ['clear', 'clearDepth', 'clearColor', 'clearStencil', 'blitFramebuffer', 'bindFramebuffer',
        'bindRenderbuffer', 'renderbufferStorage', 'renderbufferStorageMultisample', 'viewport', 'scissor', 'useProgram',
        'framebufferTexture2D', 'framebufferRenderbuffer', 'deleteFramebuffer', 'deleteRenderbuffer', 'deleteTexture']) {
        if (typeof gl[name] !== 'function') continue;
        const original = gl[name]; gl[name] = function (...args) { record('gl.'+name, args); return original.apply(this, args); };
    }
    for (const name of ['createFramebuffer', 'createRenderbuffer', 'createTexture', 'createProgram']) {
        const original = gl[name]; gl[name] = function (...args) { const value = original.apply(this, args); record('gl.'+name, args, { result: id(value) }); return value; };
    }
    for (const name of ['clear', 'clearDepth', 'setRenderTarget', 'render']) {
        const original = renderer[name]; renderer[name] = function (...args) {
            record('renderer.'+name, args, { autoClear: this.autoClear, autoClearColor: this.autoClearColor,
                autoClearDepth: this.autoClearDepth, autoClearStencil: this.autoClearStencil, outputColorSpace: this.outputColorSpace,
                target: id(this.getRenderTarget()) }); return original.apply(this, args);
        };
    }
    for (const [index, pass] of (composer?.passes || []).entries()) {
        const original = pass.render; pass.render = function (...args) {
            record('pass.'+index+'.'+this.constructor.name, args, { enabled: this.enabled, renderToScreen: this.renderToScreen,
                needsSwap: this.needsSwap }); return original.apply(this, args);
        };
    }
}

// Called outside timed blocks. Observe native state, actual linked shader text,
// default framebuffer sample count and full framebuffer bytes without mutation.
export async function captureOverviewState(page, out, phase) {
    const raw = await page.evaluate(() => {
        const { scene: s } = pairedQA, r = s.renderer, gl = r.getContext();
        const context = gl.getContextAttributes(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
        const targets = [r.getRenderTarget(), s.composer?.renderTarget1, s.composer?.renderTarget2].map(t => !t ? null : ({
            width: t.width, height: t.height, samples: t.samples, type: t.texture.type, format: t.texture.format,
            colorSpace: t.texture.colorSpace, depthBuffer: t.depthBuffer, depthTexture: !!t.depthTexture }));
        gl.finish(); const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let nonZeroBytes = 0; for (const value of pixels) if (value) nonZeroBytes++;
        let binary = ''; for (let i = 0; i < pixels.length; i += 32768) binary += String.fromCharCode(...pixels.subarray(i, i + 32768));
        const rect = id => { const element = document.getElementById(id), box = element?.getBoundingClientRect();
            if (!element || !box) return null; const css = getComputedStyle(element);
            return { x: box.x, y: box.y, width: box.width, height: box.height, display: css.display, overflow: css.overflow,
                hidden: element.hidden, open: element.open ?? null }; };
        return { context, drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
            defaultFramebuffer: gl.getParameter(gl.FRAMEBUFFER_BINDING) === null, samples: gl.getParameter(gl.SAMPLES),
            sampleBuffers: gl.getParameter(gl.SAMPLE_BUFFERS), depthBits: gl.getParameter(gl.DEPTH_BITS),
            dpr: r.getPixelRatio(), quality: { ...s.renderQuality }, viewport: { ...s.viewportSize },
            renderer: { render: { ...r.info.render }, memory: { ...r.info.memory }, programCount: r.info.programs.length,
                autoClear: r.autoClear, autoClearColor: r.autoClearColor, autoClearDepth: r.autoClearDepth,
                autoClearStencil: r.autoClearStencil, outputColorSpace: r.outputColorSpace, toneMapping: r.toneMapping, toneMappingExposure: r.toneMappingExposure },
            targets, passes: s.composer?.passes.map(p => ({ type: p.constructor.name, enabled: p.enabled,
                needsSwap: p.needsSwap, renderToScreen: p.renderToScreen })) || [],
            programs: r.info.programs.map(p => ({ id: p.id, nativeAuditId: window.__overviewNativeAudit?.ids(p.program) ?? null, cacheKey: p.cacheKey, usedTimes: p.usedTimes,
                linked: gl.getProgramParameter(p.program, gl.LINK_STATUS), shaders: (gl.getAttachedShaders(p.program) || []).map(shader => ({
                    type: gl.getShaderParameter(shader, gl.SHADER_TYPE), compiled: gl.getShaderParameter(shader, gl.COMPILE_STATUS), source: gl.getShaderSource(shader) })) })),
            framebufferCapture: { nonZeroBytes, visualParityClaim: false,
                scope: 'Later-task default framebuffer read without redraw; preserveDrawingBuffer=false may yield cleared bytes. Hash is not visual-parity evidence.' },
            framebufferBase64: btoa(binary), contextLost: gl.isContextLost(), glError: gl.getError(),
            gpuTimer: { extensionAvailable: !!ext, measured: false,
                reason: 'No GPU query is inserted; finish/readback are synchronization latency, never labeled GPU execution time.' },
            dom: { portraitMedia: matchMedia('(max-width:760px) and (orientation:portrait)').matches,
                compact: document.body.classList.contains('compact-explorer'), focused: document.activeElement?.id,
                panel: rect('explorePanel'), dock: rect('timeDock'), graphics: rect('renderQualityControls'),
                rootStyle: document.documentElement.getAttribute('style') },
        };
    });
    assert.equal(raw.contextLost, false); assert.equal(raw.glError, 0); assert(raw.defaultFramebuffer);
    raw.framebufferSha256 = sha(Buffer.from(raw.framebufferBase64, 'base64')); delete raw.framebufferBase64;
    await mkdir(resolve(out, 'shaders'), { recursive: true });
    for (const program of raw.programs) for (const shader of program.shaders) {
        assert(shader.compiled && program.linked, 'Only actually compiled/linked programs');
        shader.sha256 = sha(shader.source); await writeFile(resolve(out, 'shaders', shader.sha256+'.glsl'), shader.source); delete shader.source;
    }
    await writeFile(resolve(out, `${phase}-state.json`), JSON.stringify(raw, null, 2)+'\n'); return raw;
}

export async function overviewAttribution({ browser, pages, servers, initializePage, query, viewport, fixture, frames, state, activate, out, report, save }) {
    // Close measured contexts first: fresh diagnostic contexts cannot alter
    // the already-recorded samples or leave extra pages competing for resources.
    for (const label of ['A', 'B']) await pages[label].context().close();
    const results = {}; report.overviewAttribution = results;
    report.attributionContextOrder = { creation: ['A', 'B'], lifetime: 'Fresh contexts are created, measured and closed sequentially; instrumented diagnostics are not acceptance timing.' };
    for (const [index, label] of ['A', 'B'].entries()) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: false, hasTouch: false });
        await context.addInitScript(installOverviewObservers);
        const page = await context.newPage(); page.setDefaultTimeout(120000);
        page.on('pageerror', error => report.errors.push({ phase: 'attribution', label, message: String(error) }));
        page.on('console', message => { if (message.type() === 'error' && /THREE|Shader|GL_INVALID|WebGL/i.test(message.text())) report.errors.push({ phase: 'attribution', label, message: message.text() }); });
        await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, body: '' }));
        await page.goto(`http://127.0.0.1:${servers[index].httpServer.address().port}/?${new URLSearchParams(query)}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__AP_READY && window.__pairedFrame); await initializePage(page);
        await activate(page);
        await page.evaluate(fixture => { const q = pairedQA; q.input.setFocus(fixture.focus); q.scene.cam.dist = fixture.distance;
            q.scene.cam.distTarget = null; q.scene.cam.yaw = fixture.yaw; q.scene.cam.pitch = fixture.pitch; }, fixture);
        const row = results[label] = { phase: 'Post-comparison fresh-context attribution only', warmup: await frames(page, 120) };
        await page.waitForFunction(() => { const q = pairedQA.surfaces.pairedSurfaceQueue(); return !q.pending && !q.inFlight; });
        row.warmup.push(...await frames(page, 4)); row.before = await state(page);
        await page.evaluate(installOverviewNativeAudit);
        row.nativeBefore = await captureOverviewState(page, out, `attribution-${label}-before`);
        const session = await context.newCDPSession(page);
        await session.send('Performance.enable'); await session.send('Profiler.enable');
        await session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
        row.metricsBefore = await session.send('Performance.getMetrics');
        await page.evaluate(() => { __overviewAttribution.enabled = true; __overviewNativeAudit.enabled = true; __PERF.setEnabled(true); __PERF.clear(); });
        row.samples = await frames(page, 20);
        // Let pending rendering observers deliver before capturing counts. This
        // is outside the frame samples and is disclosed as attribution overhead.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        row.observers = await page.evaluate(() => { __overviewAttribution.enabled = false; __overviewNativeAudit.enabled = false; __PERF.setEnabled(false);
            return { ...structuredClone(__overviewAttribution), stages: structuredClone(__PERF.samples) }; });
        row.nativeSubmissions = await page.evaluate(() => { const { ids, ...data } = __overviewNativeAudit; return data; });
        assert.equal(row.nativeSubmissions.dropped, 0, 'No native submission truncation');
        row.metricsAfter = await session.send('Performance.getMetrics');
        const coverage = await session.send('Profiler.takePreciseCoverage');
        row.functionCalls = coverage.result.filter(s => /\/src\/(compactExplorer|render\/qualityControls|timeDock|explorerUI)\.js(?:\?|$)/.test(s.url));
        await session.send('Profiler.stopPreciseCoverage'); await session.send('Profiler.disable'); await session.detach();
        row.after = await state(page); row.nativeAfter = await captureOverviewState(page, out, `attribution-${label}-after`);
        assert.equal(row.observers.droppedWrites, 0, 'Attribution must not silently truncate root writes');
        await save(); await context.close();
    }
}
