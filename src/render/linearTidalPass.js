import * as THREE from 'three';
import { EXT_STRETCH_GLSL } from './stellarAppearance.js';

// Add radiance first, apply the nonlinear display transform once. Applying
// asinh/ACES/sRGB to each of thousands of overlapping kernels made their
// summed faint outskirts brighter than their cores (a saturated white blob).
export class LinearTidalPass {
    constructor(pixelBudget = 1048576) {
        this.pixelBudget = pixelBudget;
        this.target = null;
        this.renders = 0;
        this.size = new THREE.Vector2();
        this.viewport = new THREE.Vector4();
        this.scissor = new THREE.Vector4();
        this.clearColor = new THREE.Color();
        this.targetViewport = new THREE.Vector4();
        this.targetScissor = new THREE.Vector4();
        this.material = new THREE.ShaderMaterial({
            uniforms: { uLight: { value: null }, uStretch: { value: 1 } },
            vertexShader: `varying vec2 uvLight; void main() {
                uvLight = position.xy * .5 + .5;
                gl_Position = vec4(position.xy, 0., 1.);
            }`,
            fragmentShader: `uniform sampler2D uLight; uniform float uStretch;
                varying vec2 uvLight;
                ${EXT_STRETCH_GLSL}
                void main() {
                    vec3 c = texture2D(uLight, uvLight).rgb;
                    float y = dot(c, vec3(.2126, .7152, .0722));
                    if (y > 0.) c *= extStretch(y, uStretch) / y;
                    gl_FragColor = vec4(c, 1.);
                    #include <tonemapping_fragment>
                    #include <colorspace_fragment>
                }`,
            depthTest: false, depthWrite: false, transparent: true,
            blending: THREE.AdditiveBlending,
        });
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(
            new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
        this.scene = new THREE.Scene();
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    }
    render(renderer, source, camera, stretch, pointDpr = null) {
        const target = renderer.getRenderTarget();
        const dpr = pointDpr?.value;
        const face = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
        renderer.getCurrentViewport(this.viewport);
        const gl = renderer.getContext();
        this.scissor.fromArray(gl.getParameter(gl.SCISSOR_BOX));
        const scissorTest = gl.isEnabled(gl.SCISSOR_TEST), autoClear = renderer.autoClear;
        renderer.getClearColor(this.clearColor);
        const alpha = renderer.getClearAlpha(), xr = renderer.xr.enabled;
        this.size.set(this.viewport.z, this.viewport.w);
        const restoreTarget = () => {
            // An active RT viewport is in device pixels, not the renderer's
            // global CSS viewport. Do not modify the latter (DPR/composer).
            if (target) {
                this.targetViewport.copy(target.viewport); this.targetScissor.copy(target.scissor);
                const test = target.scissorTest;
                target.viewport.copy(this.viewport); target.scissor.copy(this.scissor); target.scissorTest = scissorTest;
                renderer.setRenderTarget(target, face, level);
                target.viewport.copy(this.targetViewport); target.scissor.copy(this.targetScissor); target.scissorTest = test;
            } else renderer.setRenderTarget(null, face, level);
            renderer.state.viewport(this.viewport); renderer.state.scissor(this.scissor); renderer.state.setScissorTest(scissorTest);
        };
        const scale = Math.min(1, Math.sqrt(this.pixelBudget / Math.max(1, this.size.x * this.size.y)));
        const w = Math.max(1, Math.floor(this.size.x * scale)), h = Math.max(1, Math.floor(this.size.y * scale));
        if (!this.target) this.target = new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        });
        else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
        try {
            renderer.xr.enabled = false;
            renderer.setRenderTarget(this.target);
            renderer.state.setScissorTest(false);
            renderer.setClearColor(0, 0);
            renderer.clear(true, false, false);
            renderer.autoClear = false;
            if (pointDpr) pointDpr.value = dpr * h / this.size.y;
            renderer.render(source, camera);
            if (pointDpr) pointDpr.value = dpr;
            restoreTarget();
            this.material.uniforms.uLight.value = this.target.texture;
            this.material.uniforms.uStretch.value = stretch;
            renderer.render(this.scene, this.camera);
            this.renders++;
        } finally {
            if (pointDpr) pointDpr.value = dpr;
            restoreTarget();
            renderer.setClearColor(this.clearColor, alpha);
            renderer.autoClear = autoClear;
            renderer.xr.enabled = xr;
        }
    }
    stats() {
        return { renders: this.renders, size: this.target ? [this.target.width, this.target.height] : null,
            bytes: this.target ? this.target.width * this.target.height * 8 : 0 };
    }
    dispose() {
        this.target?.dispose(); this.material.dispose(); this.scene.children[0].geometry.dispose();
        this.target = null;
    }
}
