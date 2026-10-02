// Modeled substructure, not an observational image reconstruction. Catalog
// type, scale, axis and luminosity still come from galaxyPopulation.js.
// Small-scale dust and stellar associations are deterministic modeled detail.
// One component budget is shared across LOD; no second galaxy is overlaid.
export function galaxySeed(id) {
    let x = (id + 0x9e3779b9) >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
    x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
    return ((x ^ (x >>> 15)) >>> 0) / 4294967296;
}

export function needsGalaxyQuads(distanceMpc, radiusMpc, maxScaleKpc, pxScale, maxPointPx, wasQuad = false) {
    const nearest = Math.max(1e-6, distanceMpc - radiusMpc);
    const reachPx = 8 * maxScaleKpc * 0.001 / nearest * pxScale;
    return reachPx > Math.max(1, maxPointPx) * (wasQuad ? 0.25 : 0.4);
}

export const MORPH_VARYINGS = /* glsl */`
varying vec4 vMorph; // seed, type, resolved-detail weight, population quenching
varying vec3 vDiskFrame; // local major-axis cosine/sine, signed inclination
`;

export const MORPH_GLSL = /* glsl */`
// Intrinsic, identity-seeded structure. Pixel-footprint filtering suppresses
// unresolved frequencies, without substituting a different image at zoom.
float galHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3,p3.yzx+33.33);
    return fract((p3.x+p3.y)*p3.z);
}
float galNoise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(galHash(i),galHash(i+vec2(1,0)),f.x),
        mix(galHash(i+vec2(0,1)),galHash(i+vec2(1,1)),f.x),f.y);
}
float galFilteredNoise(vec2 p,float frequency,float footprint) {
    float keep=1.0-smoothstep(.25,1.2,frequency*footprint);
    return .5+(galNoise(p*frequency)-.5)*keep;
}
float galCloud(vec2 p,float footprint) {
    return .36*galFilteredNoise(p,2.7,footprint)+.25*galFilteredNoise(p,7.1,footprint)
        +.18*galFilteredNoise(p,17.3,footprint)+.12*galFilteredNoise(p,43.7,footprint)
        +.06*galFilteredNoise(p,109.1,footprint)+.03*galFilteredNoise(p,271.3,footprint);
}
float galRidge(float p, float footprint) {
    float f = min(footprint,20.0);
    return 1.0+1.6*cos(p)*exp(-.5*f*f)+.8*cos(2.0*p)*exp(-2.0*f*f)
        +.22857143*cos(3.0*p)*exp(-4.5*f*f)+.02857143*cos(4.0*p)*exp(-8.0*f*f);
}
vec3 galUnitLuma(vec3 c) { return c/max(dot(c,vec3(.2126,.7152,.0722)),1e-5); }
vec3 galDiskLight(vec2 p,float footprint,vec3 color,float inclination) {
    float r=length(p), theta=r>1e-5?atan(p.y,p.x):0.0;
    float seed=vMorph.x*6.283185307, T=vMorph.y;
    float disk=step(.5,T)*(1.0-step(8.5,T)), irregular=step(8.5,T);
    vec2 seedOffset=vec2(37.0*vMorph.x,71.0*vMorph.x);
    vec2 warp=vec2(galNoise(p*1.1+seedOffset),galNoise(p*1.3-seedOffset))-.5;
    vec2 field=p+.14*warp+seedOffset;
    float cloud=galCloud(field,footprint), fine=galFilteredNoise(field+vec2(2.7,-1.1),67.0,footprint);
    float arms=2.0+floor(vMorph.x*2.99), pitch=mix(3.5,1.65,clamp(T/9.0,0.0,1.0));
    float bend=.20*sin(1.3*r+seed)+.06*sin(4.1*r-seed)+.10*(cloud-.5);
    float phase=arms*(theta-pitch*log(max(r,.16))+bend)+seed;
    float angular=footprint/max(r,.16), fp=arms*(1.0+pitch)*angular;
    float arm=galRidge(phase,fp), branch=galRidge(phase+1.4+.7*sin(3.7*r+seed),fp+3.0*footprint);
    // Patchy dust follows the upstream edge of each arm; narrow lanes and
    // branches remain attached to the galaxy through orbiting and zooming.
    float dustRidge=galRidge(phase+.52,fp);
    float lane=exp(-.48*dustRidge*(.35+1.8*cloud));
    float envelope=smoothstep(.16,.55,r)*(1.0-smoothstep(5.0,7.0,r));
    float strength=vMorph.z*envelope*(1.0-.85*vMorph.w);
    float facing=smoothstep(.035,.2,inclination);
    float clumps=clamp((cloud-.40)*3.4,0.0,1.4);
    float structure=1.0+disk*strength*facing*(.66*(arm-1.0)+.10*(branch-1.0));
    structure*=mix(1.0,.64+1.20*cloud,disk*strength*facing);
    structure*=mix(1.0,lane,disk*strength*facing*.85);
    // Irregular systems have asymmetric cloud complexes rather than spirals.
    float asym=.45*cos(theta+seed)+.22*cos(3.0*theta-1.7*r+seed);
    structure*=1.0+irregular*strength*(asym+.95*(cloud-.5));
    float cluster=smoothstep(.71,.90,fine)*(1.0-smoothstep(.12,.7,footprint*67.0));
    float young=clamp((disk*max(0.0,arm-.6)*.16+irregular*.55)*strength*clumps,0.0,1.0);
    float hii=young*cluster;
    vec3 tint=mix(vec3(1.07,1.0,.89),vec3(.64,.86,1.24),young);
    tint=mix(tint,vec3(1.30,.63,.84),min(.28,hii));
    vec3 c=galUnitLuma(color*mix(vec3(1.0),tint,vMorph.z));
    // Fine grains represent unresolved associations, not individually
    // catalogued stars. No second luminous layer is added at an LOD switch.
    structure+=strength*(disk+irregular)*hii*.55;
    structure*=1.0+vMorph.z*(1.0-disk-irregular)*.06*(cloud-.5);
    return c*max(.06,structure);
}
float galDustBand(vec3 p,float footprint,float q) {
    float noise=galCloud(p.xy+vec2(vMorph.x*37.0,vMorph.x*71.0),footprint);
    float band=exp(-pow(p.z/max(.035,q*.35),2.0));
    float radial=smoothstep(.1,.6,length(p.xy))*(1.0-smoothstep(4.5,7.0,length(p.xy)));
    float disk=step(.5,vMorph.y)*(1.0-step(8.5,vMorph.y));
    return exp(-disk*vMorph.z*band*radial*(.35+1.4*noise)*(1.0-.8*vMorph.w));
}
vec3 galStructuredLight(vec2 pixel,vec4 ab,vec2 peak,vec3 color,float lane) {
    if(vMorph.z<=0.0) return color*(peak.x*exp(-length(pixel/ab.xy))*lane+peak.y*exp(-length(pixel/ab.zw))*mix(1.0,lane,.5));
    vec2 sky=pixel/ab.xy;
    vec2 p=mat2(vDiskFrame.x,vDiskFrame.y,-vDiskFrame.y,vDiskFrame.x)
        *vec2(sky.x,sky.y*(vDiskFrame.z<0.0?-1.0:1.0));
    float footprint=max(length(dFdx(p)),length(dFdy(p)));
    vec3 diskColor=galDiskLight(p,footprint,color,abs(vDiskFrame.z));
    vec3 coreColor=galUnitLuma(color*mix(vec3(1.0),vec3(1.08,1.0,.88),vMorph.z));
    return peak.x*exp(-length(p))*lane*diskColor
        +peak.y*exp(-length(pixel/ab.zw))*mix(1.0,lane,.5)*coreColor;
}
`;
