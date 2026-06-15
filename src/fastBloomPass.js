import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

export class FastBloomPass extends Pass {
    constructor(resolution = new THREE.Vector2(1, 1), strength = .34, radius = 1.15, threshold = .86) {
        super();
        this.strength = strength;
        this.radius = radius;
        this.threshold = threshold;
        this.resolution = resolution.clone();
        this.scale = .38;
        this.isFastBloomPass = true;
        this.needsSwap = false;
        const opts = {
            type: THREE.HalfFloatType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false,
        };
        this.rtBright = new THREE.WebGLRenderTarget(1, 1, opts);
        this.rtA = new THREE.WebGLRenderTarget(1, 1, opts);
        this.rtB = new THREE.WebGLRenderTarget(1, 1, opts);
        this.rtBright.texture.name = "FastBloom.bright";
        this.rtA.texture.name = "FastBloom.a";
        this.rtB.texture.name = "FastBloom.b";

        this.highMat = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                uThreshold: { value: threshold },
                uSoftness: { value: .18 },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: /* glsl */`
                uniform sampler2D tDiffuse;
                uniform float uThreshold;
                uniform float uSoftness;
                varying vec2 vUv;
                void main(){
                    vec3 c = texture2D(tDiffuse, vUv).rgb;
                    float l = max(max(c.r, c.g), c.b);
                    float m = smoothstep(uThreshold, uThreshold + uSoftness, l);
                    gl_FragColor = vec4(c * m, 1.0);
                }`,
            depthTest: false,
            depthWrite: false,
        });
        this.blurMat = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                uTexel: { value: new THREE.Vector2(1, 1) },
                uDirection: { value: new THREE.Vector2(1, 0) },
                uRadius: { value: radius },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: /* glsl */`
                uniform sampler2D tDiffuse;
                uniform vec2 uTexel;
                uniform vec2 uDirection;
                uniform float uRadius;
                varying vec2 vUv;
                void main(){
                    vec2 o = uTexel * uDirection * uRadius;
                    vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
                    c += texture2D(tDiffuse, vUv + o * 1.384615).rgb * 0.316216;
                    c += texture2D(tDiffuse, vUv - o * 1.384615).rgb * 0.316216;
                    c += texture2D(tDiffuse, vUv + o * 3.230769).rgb * 0.070270;
                    c += texture2D(tDiffuse, vUv - o * 3.230769).rgb * 0.070270;
                    gl_FragColor = vec4(c, 1.0);
                }`,
            depthTest: false,
            depthWrite: false,
        });
        this.blendMat = new THREE.ShaderMaterial({
            uniforms: {
                tDiffuse: { value: null },
                uStrength: { value: strength },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
            fragmentShader: /* glsl */`
                uniform sampler2D tDiffuse;
                uniform float uStrength;
                varying vec2 vUv;
                void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * uStrength, 1.0); }`,
            blending: THREE.AdditiveBlending,
            transparent: true,
            depthTest: false,
            depthWrite: false,
        });
        this.fsQuad = new FullScreenQuad(null);
        this.setSize(this.resolution.x, this.resolution.y);
    }

    setSize(width, height) {
        this.resolution.set(width, height);
        const w = Math.max(2, Math.round(width * this.scale));
        const h = Math.max(2, Math.round(height * this.scale));
        this.rtBright.setSize(w, h);
        this.rtA.setSize(w, h);
        this.rtB.setSize(w, h);
        this.blurMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    }

    render(renderer, writeBuffer, readBuffer) {
        const oldAutoClear = renderer.autoClear;
        renderer.autoClear = false;

        this.highMat.uniforms.tDiffuse.value = readBuffer.texture;
        this.highMat.uniforms.uThreshold.value = this.threshold;
        this.fsQuad.material = this.highMat;
        renderer.setRenderTarget(this.rtBright);
        renderer.clear();
        this.fsQuad.render(renderer);

        this.blurMat.uniforms.tDiffuse.value = this.rtBright.texture;
        this.blurMat.uniforms.uDirection.value.set(1, 0);
        this.blurMat.uniforms.uRadius.value = this.radius;
        this.fsQuad.material = this.blurMat;
        renderer.setRenderTarget(this.rtA);
        renderer.clear();
        this.fsQuad.render(renderer);

        this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
        this.blurMat.uniforms.uDirection.value.set(0, 1);
        renderer.setRenderTarget(this.rtB);
        renderer.clear();
        this.fsQuad.render(renderer);

        this.blendMat.uniforms.tDiffuse.value = this.rtB.texture;
        this.blendMat.uniforms.uStrength.value = this.strength;
        this.fsQuad.material = this.blendMat;
        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        this.fsQuad.render(renderer);

        renderer.autoClear = oldAutoClear;
    }

    dispose() {
        this.rtBright.dispose();
        this.rtA.dispose();
        this.rtB.dispose();
        this.highMat.dispose();
        this.blurMat.dispose();
        this.blendMat.dispose();
        this.fsQuad.dispose();
    }
}
