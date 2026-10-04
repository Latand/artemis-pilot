import assert from 'node:assert/strict';

// Test-only completion telemetry. Count only the end of the real, non-XR
// render path; an early cadence/context return must never count as a draw.
export function instrumentAppMotionCompletion(source) {
    const seam = '    sampleMemory();\n}';
    assert.equal(source.split(seam).length, 2, 'One completed renderFrame seam');
    return source.replace(seam, `    sampleMemory();
    if (!renderContext.isLost()) window.__appMotionCompleted = (window.__appMotionCompleted || 0) + 1;
}`) + '\nwindow.__captureAppFrameState=()=>({completed:window.__appMotionCompleted||0,frame:frameNo});\n';
}

// Serialized by page.evaluate, whose returned Promise is awaited. Unlike an
// async waitForFunction predicate, this loop cannot pass on Promise truthiness.
export async function captureCompletedAppMotionFrame({ distance, settled = false, width = 640, height = 400, dpr = 1, timeoutMs = 120000 }) {
    const { s, v, ship } = window.appTest;
    const controls = () => ({ time: window.__G.t, paused: window.__G.paused, focus: window.__G.focus,
        ship: [window.__G.x, window.__G.y, window.__G.z, window.__G.vx, window.__G.vy, window.__G.vz],
        camera: { distance: s.cam.dist, goal: s.cam.distTarget, target: s.cam.tgt.toArray(), yaw: s.cam.yaw, pitch: s.cam.pitch, fov: s.camera.fov } });
    const requested = controls(), requestedJSON = JSON.stringify(requested);
    if (requested.time !== 0 || !requested.paused || requested.focus !== 'sun' ||
        requested.camera.distance !== distance || requested.camera.goal !== null ||
        JSON.stringify(requested.ship) !== JSON.stringify(ship)) throw new Error('Unexpected requested app-motion state');
    const started = performance.now();
    let attempts = 0, skipped = 0;
    while (performance.now() - started <= timeoutMs) {
        if (JSON.stringify(controls()) !== requestedJSON) throw new Error('Requested app-motion state changed while waiting');
        const before = window.__captureAppFrameState();
        window.__captureAppFrame();
        const after = window.__captureAppFrameState();
        attempts++;
        if (JSON.stringify(controls()) !== requestedJSON) throw new Error('Ship, epoch or requested camera changed during capture');
        if (after.completed > before.completed && after.frame > before.frame) {
            const volume = v.galaxyVolumeStats(), gl = s.renderer.getContext();
            if (gl.isContextLost() || s.renderer.getRenderTarget() !== null) throw new Error('Completed capture has no healthy default framebuffer');
            if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height ||
                s.renderer.getPixelRatio() !== dpr || innerWidth !== width || innerHeight !== height ||
                s.camera.aspect !== width / height) throw new Error('Completed capture has the wrong viewport, buffer, DPR or aspect');
            if (!settled || !volume.draft) {
                // No await/task boundary from the completed draw through both
                // pixel readback and PNG copy: preserveDrawingBuffer is false.
                const pixels = new Uint8Array(width * height * 4);
                gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                let alphaNonzero = 0, opaquePixels = 0, litPixels = 0;
                for (let i = 0; i < pixels.length; i += 4) {
                    if (pixels[i + 3] > 0) alphaNonzero++;
                    if (pixels[i + 3] === 255) opaquePixels++;
                    if (pixels[i] || pixels[i + 1] || pixels[i + 2]) litPixels++;
                }
                if (!alphaNonzero) throw new Error(`Transparent completed app-motion capture at frame ${after.frame}`);
                if (gl.getError() !== gl.NO_ERROR) throw new Error('App-motion capture has a WebGL readback error');
                const png = s.renderer.domElement.toDataURL('image/png');
                if (!png.startsWith('data:image/png;base64,') || png.length <= 22) throw new Error('App-motion canvas PNG is missing');
                const debug = gl.getExtension('WEBGL_debug_renderer_info');
                const gpu = { vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
                    version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
                    unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
                    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
                return { png, camera: { position: s.camera.position.toArray(), quaternion: s.camera.quaternion.toArray(), projection: s.camera.projectionMatrix.toArray() },
                    time: window.__G.t, ship, dpr: s.renderer.getPixelRatio(), size: [width, height], mobile: s.renderQuality.mobile, volume, gpu,
                    capture: { requested, before, after, attempts, skipped, waitedMs: performance.now() - started,
                        alphaNonzero, opaquePixels, litPixels, pixelSource: 'completed draw and same-task WebGL readback/PNG' } };
            }
        } else {
            skipped++;
        }
        // Give production's unchanged 30 Hz gate real wall time. Never reset
        // lastMobileFrame, replace its clock, or force simulation advancement.
        await new Promise(resolve => setTimeout(resolve, 16));
    }
    throw new Error(`No completed ${settled ? 'settled ' : ''}app-motion capture within ${timeoutMs} ms (${attempts} attempts, ${skipped} skipped)`);
}
