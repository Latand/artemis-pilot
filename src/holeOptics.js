// Illustrative optics shared by named and placed black holes, all in simulation time:
//
//  * shadow — a black disc of radius sqrt(27)/2 r_s ~ 2.6 r_s (the critical
//    impact parameter), i.e. angular radius 2.6 r_s / d from afar;
//  * photon ring — the thin bright rim just outside it, lit by the disk (or,
//    faintly, by starlight);
//  * accretion disk — an annulus from the ISCO (3 r_s) outward with a
//    Novikov–Thorne-like temperature T ~ r^-3/4 (1 - sqrt(r_in/r))^1/4 scaled
//    by the accretion rate, rotating at the local circular (Paczynski–Wiita)
//    angular velocity in sim time, seen with Doppler beaming and
//    gravitational redshift: colour from the observed temperature T g,
//    brightness x g^4, g = sqrt(1 - 3 r_s / 2r) / (1 - beta cos psi). Where an
//    orbit is shorter than the sim time a rendered frame spans, the disk shows
//    the orbit-averaged ring instead of a strobing pattern;
//  * jet — only for an explicitly jetted source, launched once the disk
//    exists and growing at ~c in sim time.
//
// Everything lives under holeRoot. The screen-space lens (lensing.js) bends
// the world rendered WITHOUT holeRoot and then draws holeRoot unbent on top,
// so a hole never lenses its own disk as if it were a background source.
// Occlusion by the shadow is analytic (behind the hole's plane of the sky and
// inside its apparent radius), not a depth-buffer test: at interplanetary
// distances one depth quantum spans the whole disk.
import * as THREE from "three";
import { K } from "./constants.js";
import { scene } from "./scene.js";

export { SHADOW_RS } from './render/holeAppearance.js';
import { SHADOW_RS, shadowAngularRadius } from './render/holeAppearance.js';
export const holeRoot = new THREE.Group();
holeRoot.name = "hole.optics";
scene.add(holeRoot);

// ---- GLSL ----
const GLSL_BLACKBODY = /* glsl */`
    // Tanner Helland blackbody fit, linear RGB, max component 1
    vec3 blackbody(float T) {
        float t = clamp(T / 100.0, 10.0, 400.0);
        float r, g, b;
        if (t <= 66.0) { r = 1.0; g = (99.4708025861 * log(t) - 161.1195681661) / 255.0; }
        else { r = 329.698727446 * pow(t - 60.0, -0.1332047592) / 255.0; g = 288.1221695283 * pow(t - 60.0, -0.0755148492) / 255.0; }
        if (t >= 66.0) b = 1.0; else if (t <= 19.0) b = 0.0; else b = (138.5177312231 * log(t - 10.0) - 305.0447927307) / 255.0;
        return pow(clamp(vec3(r, g, b), 0.0, 1.0), vec3(2.2));
    }`;
const GLSL_NOISE = /* glsl */`
    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x) {
        vec3 i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                       mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                       mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
        float a = 0.5, s = 0.0;
        for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.03 + vec3(11.7, 3.1, 5.3); a *= 0.5; }
        return s / 0.9375;
    }`;
// Analytic occlusion by the shadow. rel: world offset from the hole centre;
// uCamRel: camera minus hole centre (computed on the CPU in doubles).
export const GLSL_SHADOW_OCCLUSION = /* glsl */`
    uniform vec3 uCamRel;
    uniform float uShadowR;
    float shadowed(vec3 rel) {
        float D = length(uCamRel);
        vec3 v = -uCamRel / max(D, 1e-30);   // camera -> hole
        float s = dot(rel, v);                // > 0: beyond the hole's plane of the sky
        if (s <= 0.0) return 0.0;
        vec3 perp = rel - s * v;
        return length(perp) * D / (D + s) < uShadowR ? 1.0 : 0.0;
    }`;

// Full-viewport ray primitives avoid near-plane cuts through a disk quad,
// faceted near-horizon spheres/Fresnel shells, and float32 galaxy-scale
// translations. CPU subtracts in doubles BEFORE conversion to units of rs.
// Shadow angle is the finite-distance *static* Schwarzschild result. Disk
// transfer, lensing and jets remain bounded visual approximations, not GR
// ray tracing and not a Kerr / moving-observer solution.
const analyticFragment = /* glsl */`
    uniform vec3 uOrigin, uAxisX, uAxisY, uNormal, uViewDepth;
    uniform vec4 uDepthProjection;
    uniform mat3 uCameraRotation;
    uniform mat4 uInverseProjection;
    uniform float uAspect, uTanFov, uShadowCos, uDistance, uNear, uFar, uRsUnits;
    uniform float uDiskOn, uRout, uTmax, uGain, uPhaseA, uPhaseB, uWA, uFrameOrbits;
    uniform float uJetLength, uJetI, uDiskUnclipped;
    varying vec2 vScreen;
    ${GLSL_BLACKBODY}
    ${GLSL_NOISE}
    vec3 local(vec3 p) { return vec3(dot(p,uAxisX), dot(p,uAxisY), dot(p,uNormal)); }
    void main() {
        // Inverse projection also supports asymmetric per-eye XR frusta.
        // NDC z=0 avoids the ill-conditioned infinite far plane.
        vec4 projected = uInverseProjection * vec4(vScreen,0.0,1.0);
        vec3 viewRay = normalize(projected.xyz / projected.w);
        vec3 ray = normalize(uCameraRotation * viewRay);
        vec3 toHole = -uOrigin / max(uDistance, 1e-12);
        float cosAngle = dot(ray,toHole);
        float aa = max(fwidth(cosAngle), 1e-7);
        float shadow = smoothstep(uShadowCos-aa, uShadowCos+aa, cosAngle);
        vec3 col = vec3(0.0);
        float alpha = 0.0;
        #if HOLE_LAYER == 0
        alpha = shadow;
        #endif
        float depthRs = max(1e-5, uDistance);
        vec3 ro = local(uOrigin), rd = local(ray);
        // Plane hit is analytical, so even a camera inside the disk's bounding
        // box cannot expose triangle edges or its rectangular support plane.
        #if HOLE_LAYER == 1
        if (uDiskOn > 0.5 && abs(rd.z) > 1e-7) {
            // Raster-footprint support for an otherwise razor-thin plane.
            // A camera exactly in that plane previously got hit=0 on every
            // ray, so all disk emission vanished for one side-crossing frame.
            // A normalized, clipped interval gives fractional coverage inside;
            // it is sampling regularization, not a new accretion model.
            float hit = -ro.z/rd.z, coverage = 1.0;
            float entry = -1.0, exitHit = 1.0;
            // One uniform decision for the complete draw: no derivative is
            // moved into a per-fragment fast-path branch.
            if (uDiskUnclipped < .5) {
                float halfSupport = clamp(uDistance * max(length(dFdx(ray)),length(dFdy(ray))) * .5, .001, .02);
                // Center the interval on the original plane hit. Subtracting two
                // large ray distances can erase a thin support in float32; bounded
                // offsets preserve unit coverage and that exact hit when unclipped.
                float planeHit = -ro.z/rd.z;
                float halfWidth = halfSupport/abs(rd.z);
                float depthPerRs = max(1e-12,uRsUnits*dot(uViewDepth,ray));
                entry = max(-1.0,(max(0.0,uNear/depthPerRs)-planeHit)/halfWidth);
                exitHit = min(1.0,(uFar/depthPerRs-planeHit)/halfWidth);
                coverage = clamp((exitHit-entry)*.5,0.0,1.0);
                hit = planeHit+halfWidth*((entry+exitHit)*.5);
            }
            if (exitHit > entry && hit > 0.0) {
                vec3 p = ro+hit*rd;
                float r = length(p.xy), x = r/3.0;
                float dx = max(fwidth(x), .001);
                float mask = smoothstep(1.0,1.0+dx,x) * (1.0-smoothstep(uRout*.82,uRout,x)) * coverage;
                // Near-side emission may stand in front of the angular shadow.
                float behind = step(uDistance*cosAngle, hit);
                mask *= 1.0-shadow*behind;
                if (mask > .0001 && x > 1.0 && x < uRout) {
                    float phi = atan(p.y,p.x);
                    float f = pow(x,-.75)*pow(max(0.0,1.0-inversesqrt(x)),.25)/.48805;
                    float beta = min(.7, sqrt(1.0/(2.0*max(r-1.0,.01))));
                    vec3 velocity = vec3(-sin(phi),cos(phi),0.0);
                    float shift = sqrt(max(.01,1.0-1.5/r))/(1.0-beta*dot(velocity,-rd));
                    float omega = sqrt(1.0/x)*2.0/(3.0*x-1.0);
                    float a = phi-omega*uPhaseA, b = phi-omega*uPhaseB;
                    float n = mix(fbm(vec3(cos(b)*7.0+7.1,sin(b)*7.0-3.3,log(x)*12.0+1.7)),
                                  fbm(vec3(cos(a)*7.0,sin(a)*7.0,log(x)*12.0)),uWA);
                    float footprint = max(length(fwidth(p.xy)),.001);
                    float detail = (1.0-smoothstep(.4,2.0,footprint))*(1.0-smoothstep(.5,3.0,uFrameOrbits*omega));
                    float bands = sin(log(x)*95.0+3.0*n);
                    float texture = max(.2,1.0+detail*(1.5*(n-.5)+.12*bands));
                    float I = uGain*pow(shift*f,4.0)*texture;
                    col += blackbody(uTmax*f*shift)*I*mask;
                    alpha = max(alpha,mask);
                    depthRs = hit;
                }
            }
        }
        #endif
        #if HOLE_LAYER == 2
        // Filtered critical-curve halo. An illustrative light-transfer cue,
        // not a resolved sequence of n-th order photon rings.
        float angle = acos(clamp(cosAngle,-1.0,1.0));
        float edge = acos(clamp(uShadowCos,-1.0,1.0));
        float width = max(fwidth(angle)*1.25, edge*.014);
        float ring = exp(-pow((angle-edge-width*.9)/max(width,1e-7),2.0));
        float halo = exp(-pow((angle-edge-width*3.0)/max(width*4.0,1e-7),2.0));
        float asymmetry = .55+.45*clamp(dot(ray,uAxisX)*3.0+.5,0.0,1.0);
        float ringI = (uDiskOn>.5 ? .16+uGain*.6 : .015)*asymmetry;
        col += blackbody(uDiskOn>.5 ? uTmax : 6500.0)*(ring+.18*halo)*ringI*(1.0-shadow);
        alpha = max(alpha, clamp((ring+.12*halo)*ringI,0.0,.95)*(1.0-shadow));
        #endif
        #if HOLE_LAYER == 3
        // Optional, analytically smooth pair of jets; no tessellated cones or
        // camera-facing stretched sprites. Dormant named holes have none.
        if (uJetLength > 0.0 && uJetI > 0.0) {
            float rr = dot(rd.xy,rd.xy);
            float t = max(0.0,-dot(ro.xy,rd.xy)/max(rr,1e-8));
            vec3 p = ro+t*rd;
            float z = abs(p.z), widthJ = max(.12,z*.055);
            float jet = exp(-dot(p.xy,p.xy)/(widthJ*widthJ))*smoothstep(2.0,8.0,z)
                      *(1.0-smoothstep(uJetLength*.65,uJetLength,z))*uJetI;
            jet *= 1.0-shadow*step(uDistance*cosAngle,t);
            col += vec3(.35,.6,1.0)*jet;
            alpha = max(alpha,min(.9,jet));
            depthRs = max(1e-5,t);
        }
        #endif
        if (alpha < .0005 && max(col.r,max(col.g,col.b)) < .0005) discard;
        // The shadow is opaque; the other layers represent emitted light.
        // Disk extent is not an optical-depth model: a wide, cold TDE disk
        // must not turn its nearly zero emission into an opaque black sheet.
        // Straight alpha cancels the additive source-alpha factor for HDR.
        gl_FragColor = vec4(col/max(alpha,.001),alpha);
        float z = max(1e-12,depthRs*uRsUnits*dot(uViewDepth,ray));
        // Match the actual projection, including scaled XR rigs and its active
        // depth tier. Fullscreen support is never projection-clipped for us.
        // Far fragments can round to exactly depth=1 in float32. Fence the
        // tier in view units as well, before the rounded projection test.
        if (z < uNear || z > uFar) discard;
        float clipZ = -uDepthProjection.x*z+uDepthProjection.y;
        float clipW = -uDepthProjection.z*z+uDepthProjection.w;
        float depth = .5*(clipZ/clipW+1.0);
        if (clipW <= 0.0 || depth < 0.0 || depth > 1.0) discard;
        gl_FragDepthEXT = depth;
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;

// Conservative all-frustum proof for the raster support interval. This is an
// eligibility optimization only; every rejected/uncertain camera uses the
// normalized shader path. See docs/qa/disk-unclipped-proof.md for the bounds.
export function diskSupportUnclipped(input) {
    if (!input || typeof input!=='object') return false;
    const f = Math.fround, u = 2 ** -24, gamma = n => n*u/(1-n*u);
    const array = value => Array.isArray(value) || ArrayBuffer.isView(value) ? Array.from(value,f) : [];
    const vector = value => value && typeof value==='object' && !Array.isArray(value) && !ArrayBuffer.isView(value)
        ? [f(value.x),f(value.y),f(value.z)] : array(value);
    const origin=vector(input.origin), normal=vector(input.normal), view=vector(input.viewDepth);
    const rotation=array(input.rotation), projection=array(input.inverseProjection);
    const near=f(input.near), far=f(input.far), rs=f(input.rsUnits);
    const width=input.viewportWidth, height=input.viewportHeight;
    if (![width,height].every(x=>Number.isInteger(x) && x>=4 && x<=32768)) return false;
    const values=[...origin,...normal,...view,...rotation,...projection,near,far,rs];
    if (origin.length!==3 || normal.length!==3 || view.length!==3 || rotation.length!==9 || projection.length!==16
        || !values.every(Number.isFinite) || values.some(x=>Math.abs(x)>2**70)
        || !(near>0 && far>near && rs>=2**-32 && rs<=2**32)) return false;
    // Deliberately reject asymmetric/orthographic/custom projection forms.
    // At NDC z=0, the accepted inverse gives (a*x,b*y,-1,w).
    if (![1,2,3,4,6,7,8,9,10,12,13].every(i=>projection[i]===0)
        || projection[14]!==-1 || !(projection[0]>0 && projection[0]<=2 && projection[5]>0 && projection[5]<=2)
        || !(projection[15]>=2**-32 && projection[15]<=2**32)) return false;
    // Include two pixels beyond each viewport edge for derivative helper
    // lanes. The visible fragment and its native derivative neighborhood must
    // both retain the same plane hit, not just the central sampled ray.
    const extentX=projection[0]*(1+4/width), extentY=projection[5]*(1+4/height);
    if (extentX>2 || extentY>2) return false;
    const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
    const columns=[rotation.slice(0,3),rotation.slice(3,6),rotation.slice(6,9)];
    let gramError2=0, frobenius2=0;
    for(let i=0;i<3;i++) for(let j=0;j<3;j++) {
        const error=dot(columns[i],columns[j])-(i===j?1:0);
        gramError2+=error*error;
    }
    for(const value of rotation) frobenius2+=value*value;
    const gramError=Math.sqrt(gramError2)+64*Number.EPSILON;
    if (!(gramError<1e-5 && Math.abs(dot(normal,normal)-1)<1e-5 && Math.abs(dot(view,view)-1)<1e-5)) return false;
    const lo=Math.sqrt(1-gramError), hi=Math.sqrt(1+gramError);
    // IEEE float32 model: gamma(2) covers projected multiplication/division;
    // gamma(5), sqrt and division cover each normalize. The matrix product
    // has three products/two sums; the final dot gets its own gamma(5).
    const qError=gamma(2);
    const normError=Math.max(Math.sqrt(1+gamma(5))*(1+u)-1,1-Math.sqrt(1-gamma(5))*(1-u));
    const normalizeError=(normError+u)/(1-normError);
    const viewError=2*qError/(1-qError)+normalizeError;
    const worldError=hi*viewError+gamma(5)*Math.sqrt(frobenius2)*(1+viewError);
    const rayError=2*worldError/(lo-worldError)+normalizeError;
    const qMax=Math.hypot(extentX,extentY,1);
    const bounds=axis=>{
        const coefficients=columns.map(column=>dot(axis,column));
        const spread=Math.abs(coefficients[0])*extentX+Math.abs(coefficients[1])*extentY;
        const a=-coefficients[2]-spread, b=-coefficients[2]+spread;
        const error=Math.hypot(...axis)*(rayError+gamma(5)*(1+rayError))+128*Number.EPSILON;
        return [Math.min(a/lo,a/(hi*qMax))-error,Math.max(b/lo,b/(hi*qMax))+error];
    };
    const originZ=dot(origin,normal), originError=gamma(5)*origin.reduce((sum,x,i)=>sum+Math.abs(x*normal[i]),0)+128*Number.EPSILON;
    const heightLo=Math.abs(originZ)-originError, heightHi=Math.abs(originZ)+originError;
    const support=f(.02), radial=bounds(normal), depth=bounds(view);
    const slope=originZ>0 ? [-radial[1],-radial[0]] : radial;
    if (!(heightLo>2*support && slope[0]>.001 && depth[0]>0 && rs*depth[0]>2e-12)) return false;
    // The factor-two interior is a fail-closed numerical margin, not changed
    // physical clipping. It dominates rounding in hit/width/clip divisions.
    // Rays outside this proven interior keep the original clipped interval.
    const first=(heightLo-support)/slope[1]*rs*depth[0];
    const last=(heightHi+support)/slope[0]*rs*depth[1];
    return Number.isFinite(first) && Number.isFinite(last) && first>2*near && last<far/2;
}

export function makeHoleOptics() {
    const uniforms = {
        uOrigin:{value:new THREE.Vector3()}, uViewDepth:{value:new THREE.Vector3(0,0,-1)}, uDepthProjection:{value:new THREE.Vector4()}, uAxisX:{value:new THREE.Vector3(1,0,0)},
        uAxisY:{value:new THREE.Vector3(0,0,-1)}, uNormal:{value:new THREE.Vector3(0,1,0)},
        uCameraRotation:{value:new THREE.Matrix3()}, uInverseProjection:{value:new THREE.Matrix4()}, uAspect:{value:1}, uTanFov:{value:1},
        uShadowCos:{value:1}, uDistance:{value:100}, uNear:{value:.02}, uFar:{value:1e20}, uRsUnits:{value:1},
        uDiskOn:{value:0}, uRout:{value:20}, uTmax:{value:6500}, uGain:{value:0},
        uPhaseA:{value:0}, uPhaseB:{value:0}, uWA:{value:1}, uFrameOrbits:{value:0},
        uJetLength:{value:0}, uJetI:{value:0}, uDiskUnclipped:{value:0},
    };
    const makeLayer = layer => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2), new THREE.ShaderMaterial({
            uniforms, defines:{HOLE_LAYER:layer},
            vertexShader:'varying vec2 vScreen; void main(){ vScreen=position.xy; gl_Position=vec4(position.xy,0.0,1.0); }',
            fragmentShader:analyticFragment, transparent:true, depthWrite:false, depthTest:true,
            blending:layer>=1 ? THREE.AdditiveBlending : THREE.NormalBlending,
        }));
        mesh.name=['analytic black-hole shadow','analytic accretion disk','analytic critical-curve glow','analytic polar jets'][layer];
        mesh.frustumCulled=false; mesh.renderOrder=8;
        // Keep an entire distant hole behind a nearer one. Equal renderOrder
        // permits Three's back-to-front centre sort; equal-centre creation IDs
        // preserve shadow -> disk -> ring -> jet within each hole.
        mesh.userData.holeLayer=layer;
        return mesh;
    };
    const shadow=makeLayer(0), disk=makeLayer(1), ring=makeLayer(2), jet=makeLayer(3);
    // Qualify float32 capability when this material is compiled, including
    // recompilation after native context restoration. Unknown/lower precision
    // keeps the normalized path; no capability query enters the draw hot path.
    const diskPrecision=new WeakMap();
    disk.material.onBeforeCompile=(parameters,renderer)=>{
        uniforms.uDiskUnclipped.value=0;
        if (!renderer || typeof renderer!=='object') return;
        let supported=false;
        try {
            const gl=renderer.getContext();
            const format=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);
            supported=parameters?.precision==='highp'
                && format?.precision>=23 && format.rangeMin>=126 && format.rangeMax>=127;
        } catch { /* Unknown capabilities use normalized support. */ }
        // A material can reuse an older program without this callback. Once
        // any compiled variant is uncertain, keep this renderer on fallback
        // for this material's lifetime, including later cached-program returns.
        diskPrecision.set(renderer,supported && diskPrecision.get(renderer)!==false);
    };
    const center=new THREE.Vector3(), eye=new THREE.Vector3(), forward=new THREE.Vector3(), rotation=new THREE.Matrix4(), viewport=new THREE.Vector4();
    const o={shadow,ring,disk,jet,rsUnits:1};
    const prepare=(mesh,camera,renderer)=>{
        mesh.parent.getWorldPosition(center); eye.setFromMatrixPosition(camera.matrixWorld);
        const orbit=camera.userData.preciseOrbit;
        if (orbit && orbit.worldPosition.equals(eye)) {
            // Keep target-centre subtraction separate from the small orbit
            // offset; this also preserves stellar-mass horizons in the Galaxy.
            uniforms.uOrigin.value.copy(orbit.target).sub(center).add(orbit.offset).divideScalar(o.rsUnits);
        } else uniforms.uOrigin.value.copy(eye).sub(center).divideScalar(o.rsUnits);
        const d=uniforms.uOrigin.value.length();
        uniforms.uDistance.value=d;
        uniforms.uShadowCos.value=Math.cos(shadowAngularRadius(d));
        rotation.extractRotation(camera.matrixWorld);
        uniforms.uCameraRotation.value.setFromMatrix4(rotation);
        uniforms.uInverseProjection.value.copy(camera.projectionMatrixInverse);
        const view=camera.matrixWorldInverse.elements, projection=camera.projectionMatrix.elements;
        uniforms.uViewDepth.value.set(-view[2],-view[6],-view[10]);
        uniforms.uDepthProjection.value.set(projection[10],projection[14],projection[11],projection[15]);
        uniforms.uAspect.value=camera.aspect;
        uniforms.uTanFov.value=1/Math.abs(camera.projectionMatrix.elements[5]);
        uniforms.uNear.value=camera.near; uniforms.uFar.value=camera.far;
        // Each component has its own depth test and active-tier fence. A rear
        // disk cannot cover a foreground planet using the hole centre's depth.
        const layer=mesh.userData.holeLayer;
        if (layer===1) {
            uniforms.uDiskUnclipped.value=0;
            if (uniforms.uDiskOn.value>.5 && diskPrecision.get(renderer)===true
                && camera.isPerspectiveCamera && !camera.parent && typeof renderer?.getCurrentViewport==='function') {
                renderer.getCurrentViewport(viewport);
                uniforms.uDiskUnclipped.value = diskSupportUnclipped({
                    origin:uniforms.uOrigin.value, normal:uniforms.uNormal.value, viewDepth:uniforms.uViewDepth.value,
                    rotation:uniforms.uCameraRotation.value.elements, inverseProjection:uniforms.uInverseProjection.value.elements,
                    near:camera.near, far:camera.far, rsUnits:o.rsUnits, viewportWidth:viewport.z, viewportHeight:viewport.w,
                }) ? 1 : 0;
            }
        }
        const enabled=layer===1 ? uniforms.uDiskOn.value>.5 : layer===3 ? uniforms.uJetLength.value>0 && uniforms.uJetI.value>0 : true;
        const extent=layer===1 ? 3*uniforms.uRout.value : layer===3 ? uniforms.uJetLength.value : SHADOW_RS*1.5;
        forward.set(0,0,-1).transformDirection(rotation);
        const z=-uniforms.uOrigin.value.dot(forward);
        mesh.geometry.setDrawRange(0,enabled && (d<extent*2 || (z>0 && extent/d/uniforms.uTanFov.value>1e-5)) ? 6 : 0);
    };
    for (const mesh of [shadow,disk,ring,jet]) mesh.onBeforeRender=(renderer,_s,camera)=>prepare(mesh,camera,renderer);
    return o;
}

const axis=new THREE.Vector3(), q=new THREE.Quaternion(), zAxis=new THREE.Vector3(0,0,1);
export function updateHoleOptics(o,p) {
    const u=o.shadow.material.uniforms;
    o.rsUnits=Math.max(1e-15,p.rsKm*K); u.uRsUnits.value=o.rsUnits;
    u.uDiskOn.value=p.diskOn ? 1 : 0; u.uRout.value=Math.max(2,p.routOverRin||20);
    u.uTmax.value=p.TmaxK||6500; u.uGain.value=Math.max(0,p.gain||0);
    axis.set(p.axisX||0,p.axisY??1,p.axisZ||0).normalize();
    q.setFromUnitVectors(zAxis,axis);
    u.uNormal.value.copy(axis); u.uAxisX.value.set(1,0,0).applyQuaternion(q); u.uAxisY.value.set(0,1,0).applyQuaternion(q);
    const rin=3*p.rsKm, omega=Math.sqrt(p.muKm3/rin)/(rin-p.rsKm), period=2*Math.PI/omega;
    const s=p.t/period, a=s-Math.floor(s), b=s+.5-Math.floor(s+.5);
    u.uPhaseA.value=a*2*Math.PI; u.uPhaseB.value=b*2*Math.PI; u.uWA.value=1-Math.abs(2*a-1);
    u.uFrameOrbits.value=Math.abs(p.frameDt||0)*omega;
    u.uJetLength.value=p.jetOn ? Math.min(2e4,Math.max(0,p.jetLenKm/p.rsKm)) : 0;
    u.uJetI.value=p.jetOn ? p.jetI||0 : 0;
}

// Retained for TDE debris, whose separate stream geometry is camera-relative.
export function trackCameraRel(mesh,uniforms,holeOf) {
    const h=new THREE.Vector3(), c=new THREE.Vector3();
    mesh.onBeforeRender=(_r,_s,camera)=>{const root=holeOf(mesh); if(!root)return;root.getWorldPosition(h);camera.getWorldPosition(c);uniforms.uCamRel.value.copy(c).sub(h);};
}
