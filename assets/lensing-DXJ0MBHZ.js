import{E as M,l as d,V as g}from"./three.module-BZcyeVFu.js";import{S as A}from"./ShaderPass-6yITWj2u.js";import{K as u,r as S}from"./activeStars-BSeWxV3U.js";import{B as v,e as y}from"./ephemeris-BjWxoZHZ.js";import"./Pass-DLGDNUMv.js";const i=4,p=new A(new M({uniforms:{tDiffuse:{value:null},uN:{value:0},uC:{value:Array.from({length:i},()=>new d)},uT2:{value:new Float32Array(i)},uAspect:{value:1},uTexel:{value:new d(1/1024,1/1024)}},vertexShader:`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,fragmentShader:`
        uniform sampler2D tDiffuse;
        uniform int uN;
        uniform vec2 uC[${i}];
        uniform float uT2[${i}];
        uniform float uAspect;
        uniform vec2 uTexel;
        varying vec2 vUv;
        vec4 lensSample(vec2 uv){
            uv = clamp(uv, 0.0, 1.0);
            vec2 px = uTexel;
            vec4 c = texture2D(tDiffuse, uv) * 0.40;
            c += texture2D(tDiffuse, clamp(uv + vec2(px.x, 0.0), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv - vec2(px.x, 0.0), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv + vec2(0.0, px.y), 0.0, 1.0)) * 0.15;
            c += texture2D(tDiffuse, clamp(uv - vec2(0.0, px.y), 0.0, 1.0)) * 0.15;
            return c;
        }
        void main(){
            vec2 p = vUv * 2.0 - 1.0;
            p.x *= uAspect;
            vec2 q = p;
            for (int i = 0; i < ${i}; i++) {
                if (i >= uN) break;
                vec2 d = p - uC[i];
                float r2 = max(dot(d, d), 1e-9);
                q -= d * (uT2[i] / r2);
            }
            q.x /= uAspect;
            gl_FragColor = lensSample(q * 0.5 + 0.5);
        }`}));p.enabled=!1;const n=new g,t=[];function D(o,l,c,a,r,e,s){if(n.set(l,c,a).applyMatrix4(e.matrixWorldInverse),n.z>-1e-9)return;const m=n.length();if(m<r*1.5)return;const f=Math.min(s*Math.tan(Math.min(Math.sqrt(2*r/m),.6)),.55);if(f<.004)return;const x=s*(n.x/-n.z),h=s*(n.y/-n.z);Math.hypot(x,h)>4||o.push({cx:x,cy:h,t2:f*f})}function _(o,l){t.length=0;const c=1/Math.tan(o.fov*Math.PI/360);for(let e=0;e<v.n;e++)D(t,(y.earthX+v.x[e])*u,0,-(y.earthY+v.y[e])*u,v.rs[e]*u,o,c);for(const e of S)e.bh&&D(t,e.x*u,(e.z||0)*u,-e.y*u,e.rs*u,o,c);t.sort((e,s)=>s.t2-e.t2);const a=Math.min(i,t.length);if(p.enabled=a>0,!a)return!1;const r=p.uniforms;r.uN.value=a,r.uAspect.value=l;for(let e=0;e<a;e++)r.uC.value[e].set(t[e].cx,t[e].cy),r.uT2.value[e]=t[e].t2;return!0}export{p as lensingPass,_ as updateLensing};
