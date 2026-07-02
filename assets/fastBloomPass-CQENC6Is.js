import{l as r,m as u,K as l,H as h,E as o,p as n}from"./three.module-BZcyeVFu.js";import{P as f,F as v}from"./Pass-DLGDNUMv.js";class g extends f{constructor(t=new r(1,1),i=.34,e=1.15,s=.86){super(),this.strength=i,this.radius=e,this.threshold=s,this.resolution=t.clone(),this.scale=.38,this.isFastBloomPass=!0,this.needsSwap=!1;const a={type:h,minFilter:l,magFilter:l,depthBuffer:!1,stencilBuffer:!1};this.rtBright=new u(1,1,a),this.rtA=new u(1,1,a),this.rtB=new u(1,1,a),this.rtBright.texture.name="FastBloom.bright",this.rtA.texture.name="FastBloom.a",this.rtB.texture.name="FastBloom.b",this.highMat=new o({uniforms:{tDiffuse:{value:null},uThreshold:{value:s},uSoftness:{value:.18}},vertexShader:`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,fragmentShader:`
                uniform sampler2D tDiffuse;
                uniform float uThreshold;
                uniform float uSoftness;
                varying vec2 vUv;
                void main(){
                    vec3 c = texture2D(tDiffuse, vUv).rgb;
                    float l = max(max(c.r, c.g), c.b);
                    float m = smoothstep(uThreshold, uThreshold + uSoftness, l);
                    gl_FragColor = vec4(c * m, 1.0);
                }`,depthTest:!1,depthWrite:!1}),this.blurMat=new o({uniforms:{tDiffuse:{value:null},uTexel:{value:new r(1,1)},uDirection:{value:new r(1,0)},uRadius:{value:e}},vertexShader:`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,fragmentShader:`
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
                }`,depthTest:!1,depthWrite:!1}),this.blendMat=new o({uniforms:{tDiffuse:{value:null},uStrength:{value:i}},vertexShader:`
                varying vec2 vUv;
                void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,fragmentShader:`
                uniform sampler2D tDiffuse;
                uniform float uStrength;
                varying vec2 vUv;
                void main(){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb * uStrength, 1.0); }`,blending:n,transparent:!0,depthTest:!1,depthWrite:!1}),this.fsQuad=new v(null),this.setSize(this.resolution.x,this.resolution.y)}setSize(t,i){this.resolution.set(t,i);const e=Math.max(2,Math.round(t*this.scale)),s=Math.max(2,Math.round(i*this.scale));this.rtBright.setSize(e,s),this.rtA.setSize(e,s),this.rtB.setSize(e,s),this.blurMat.uniforms.uTexel.value.set(1/e,1/s)}render(t,i,e){const s=t.autoClear;t.autoClear=!1,this.highMat.uniforms.tDiffuse.value=e.texture,this.highMat.uniforms.uThreshold.value=this.threshold,this.fsQuad.material=this.highMat,t.setRenderTarget(this.rtBright),t.clear(),this.fsQuad.render(t),this.blurMat.uniforms.tDiffuse.value=this.rtBright.texture,this.blurMat.uniforms.uDirection.value.set(1,0),this.blurMat.uniforms.uRadius.value=this.radius,this.fsQuad.material=this.blurMat,t.setRenderTarget(this.rtA),t.clear(),this.fsQuad.render(t),this.blurMat.uniforms.tDiffuse.value=this.rtA.texture,this.blurMat.uniforms.uDirection.value.set(0,1),t.setRenderTarget(this.rtB),t.clear(),this.fsQuad.render(t),this.blendMat.uniforms.tDiffuse.value=this.rtB.texture,this.blendMat.uniforms.uStrength.value=this.strength,this.fsQuad.material=this.blendMat,t.setRenderTarget(this.renderToScreen?null:e),this.fsQuad.render(t),t.autoClear=s}dispose(){this.rtBright.dispose(),this.rtA.dispose(),this.rtB.dispose(),this.highMat.dispose(),this.blurMat.dispose(),this.blendMat.dispose(),this.fsQuad.dispose()}}export{g as FastBloomPass};
