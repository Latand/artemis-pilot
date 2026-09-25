import * as THREE from 'three';

// A merging scene contains overlapping extended sources. Sum their
// display-linear contributions before the final ACES and sRGB transform;
// adding individually encoded cores clips a large, featureless white patch.
// This does not alter the luminosity/stellar population or the exposure.
export const linearFrame = { requested: false, renders: 0, width: 0, height: 0, colorBytes: 0 };
let target = null, output = null, outputCamera = null;
const viewport = new THREE.Vector4(), scissor = new THREE.Vector4();

export function renderLinearFrame(renderer, draw) {
    // The composer/lensing paths already own their target. They must not
    // receive another display transform. XR keeps its per-eye renderer.
    if (!linearFrame.requested || renderer.getRenderTarget() || renderer.xr.isPresenting) return false;
    renderer.getCurrentViewport(viewport);
    const gl = renderer.getContext();
    scissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));
    const scissorTest = gl.isEnabled(gl.SCISSOR_TEST), autoClear = renderer.autoClear;
    const w = Math.max(1, Math.round(viewport.z)), h = Math.max(1, Math.round(viewport.w));
    if (!target) {
        target = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        });
        target.texture.name = 'merger.displayLinearFrame';
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1,-1,0,3,-1,0,-1,3,0]), 3));
        const material = new THREE.ShaderMaterial({
            uniforms: { uFrame: { value: target.texture } },
            vertexShader: `varying vec2 vUv; void main() {vUv=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}`,
            fragmentShader: `uniform sampler2D uFrame; varying vec2 vUv;
                void main() {
                    gl_FragColor=vec4(texture2D(uFrame,vUv).rgb,1.);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`,
            depthTest: false, depthWrite: false, blending: THREE.NoBlending,
        });
        output = new THREE.Scene();
        const mesh = new THREE.Mesh(geometry, material); mesh.frustumCulled = false; output.add(mesh);
        outputCamera = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    } else if (target.width !== w || target.height !== h) target.setSize(w, h);
    const restore = () => {
        renderer.setRenderTarget(null);
        renderer.state.viewport(viewport); renderer.state.scissor(scissor); renderer.state.setScissorTest(scissorTest);
        renderer.autoClear = autoClear;
    };
    try {
        renderer.setRenderTarget(target);
        renderer.state.setScissorTest(false);
        renderer.clear(true, true, false);
        draw(); // same scene, same projection, same depth tiers; no second scene traversal
        restore(); renderer.autoClear = false;
        renderer.render(output, outputCamera);
        linearFrame.renders++;
        linearFrame.width = w; linearFrame.height = h; linearFrame.colorBytes = w * h * 8;
    } finally { restore(); }
    return true;
}
