// Browser-safe, read-only fixture metadata. No production quality setter,
// synthetic mode, or dependency on the newer adaptive-quality controller.
export function captureDiskQuality(scene, river) {
    const { renderer, renderQuality, cvHost, viewportSize, bloomPass } = scene;
    const gl = renderer.getContext();
    return {
        modePresent: Object.hasOwn(renderQuality, 'mode'),
        mode: Object.hasOwn(renderQuality, 'mode') ? renderQuality.mode : null,
        mobile: renderQuality.mobile, pixelRatio: renderer.getPixelRatio(),
        antialias: gl.getContextAttributes()?.antialias ?? null,
        riverCount: river.count, riverTexWidth: river.texW,
        host: { width: cvHost.clientWidth, height: cvHost.clientHeight },
        viewport: { width: viewportSize.w, height: viewportSize.h },
        canvas: { width: renderer.domElement.width, height: renderer.domElement.height },
        drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
        bloom: !!bloomPass.enabled, canvasTarget: renderer.getRenderTarget() === null,
        contextLost: gl.isContextLost(),
    };
}

export function assertDiskFullQuality(actual, { mobile, bloom, viewport }) {
    const require = (pass, detail) => { if (!pass) throw Error('Disk full-quality evidence: '+detail); };
    require(actual && typeof actual.modePresent === 'boolean', 'explicit mode-presence evidence');
    require(typeof mobile === 'boolean' && typeof bloom === 'boolean', 'explicit device and render path');
    require(actual.modePresent ? actual.mode === 'high' : actual.mode === null, 'High mode or genuine legacy absence');
    require(actual.mobile === mobile, 'device classification');
    require(actual.pixelRatio === 1, 'actual renderer DPR must be 1');
    require(actual.antialias === true, 'native context antialiasing must be active');
    const texWidth = mobile ? 96 : 124;
    require(actual.riverCount === texWidth * texWidth && actual.riverTexWidth === texWidth, 'full device river allocation');
    require(viewport && Number.isInteger(viewport.width) && viewport.width > 0 &&
        Number.isInteger(viewport.height) && viewport.height > 0, 'known positive viewport dimensions');
    for (const name of ['host', 'viewport', 'canvas', 'drawingBuffer'])
        require(actual[name]?.width === viewport.width && actual[name]?.height === viewport.height, `${name} dimensions`);
    require(actual.bloom === bloom, 'requested direct/bloom path');
    require(actual.canvasTarget === true && actual.contextLost === false, 'healthy canvas render target');
    return { passed: true, profile: actual.modePresent ? 'current-high' : 'legacy-native-full',
        pixelRatio: 1, antialias: true, riverCount: texWidth * texWidth };
}
