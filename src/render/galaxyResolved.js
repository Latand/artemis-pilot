// Bounded close-view model for every external catalog / statistical galaxy.
// Positive Gaussian mixture approximates the existing exponential profile,
// integrates the half-ray analytically and stays finite inside the source.
// This is modeled structure, not resolved observations or galaxy N-body.
export const GALAXY_GAUSSIANS = Object.freeze([
    [.075, .0676845], [.18, .11460846], [.4, .22299283],
    [.8, .29381531], [1.45, .22809303], [2.5, .0468238],
]);
export const GALAXY_SUPPORT = 8;
export function erfApprox(x) {
    const sign = Math.sign(x), a = Math.abs(x), t = 1 / (1 + .3275911 * a);
    return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - .284496736) * t + .254829592) * t * Math.exp(-a * a));
}
export function gaussianRayColumn(origin, direction, q, scale = 1) {
    const o = origin.map((v, i) => v / scale / (i === 2 ? q : 1));
    const d = direction.map((v, i) => v / scale / (i === 2 ? q : 1));
    const A = d.reduce((s, v) => s + v * v, 0), B = d.reduce((s, v, i) => s + v * o[i], 0);
    // Cross product is stable at a far observer, unlike C-B^2/A.
    const cross = [o[1]*d[2]-o[2]*d[1],o[2]*d[0]-o[0]*d[2],o[0]*d[1]-o[1]*d[0]];
    const c = cross.reduce((s, v) => s + v*v, 0) / A;
    let value = 0;
    for (const [sigma, weight] of GALAXY_GAUSSIANS) value += weight * Math.exp(-.5*c/(sigma*sigma)) * .5 * (1-erfApprox(B/Math.sqrt(2*A)/sigma));
    return value / (q * scale * Math.sqrt(A));
}
// Same conservative sphere projection as the vertex shader. A support sphere
// crossing the eye plane uses the viewport; the fragment's half-ray handles
// forward-only visibility. No center-only near-plane or angular-size cull.
export function galaxyScreenBounds(center, radius, projection = [1,1,0,0]) {
    const [x,y,z] = center, [sx,sy,ox,oy] = projection, depth = -z;
    if (depth + radius <= 0) return null;
    if (depth <= radius) return [-1,-1,1,1];
    const nx = sx*x/depth-ox, ny = sy*y/depth-oy;
    const rx = sx*radius/(depth-radius)*(1+Math.abs(x)/depth);
    const ry = sy*radius/(depth-radius)*(1+Math.abs(y)/depth);
    const result = [Math.max(-1,nx-rx),Math.max(-1,ny-ry),Math.min(1,nx+rx),Math.min(1,ny+ry)];
    return result[0] >= result[2] || result[1] >= result[3] ? null : result;
}
export const RESOLVED_VARYINGS = /* glsl */`
#ifndef GAL_POINTS
varying vec3 vCenterH, vAxisV, vBasisV;
varying vec4 vPhysical; // intrinsic flattening, bulge flattening, spheroid, near weight
varying vec2 vFacePeak;
varying vec2 vNdc;
#endif
`;
export const RESOLVED_GLSL = /* glsl */`
#ifndef GAL_POINTS
float galErf(float x) {
    float a = abs(x), t = 1.0 / (1.0 + .3275911*a);
    return sign(x) * (1.0 - (((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*exp(-a*a));
}
vec2 galGaussian(vec3 o, vec3 d, float q, float scale) {
    vec3 axis = vec3(scale,scale,scale*q);
    vec3 O = o / axis, D = d / axis;
    float A = dot(D,D), B = dot(O,D);
    vec3 cr = cross(O,D);
    float c = dot(cr,cr) / A;
    float root = sqrt(A), x = B / (1.41421356237*root);
    float light = 0.0, firstMoment=0.0;
    ${GALAXY_GAUSSIANS.map(([s,w]) => `{ float radial=${w.toFixed(8)}*exp(-0.5*c/${(s*s).toFixed(8)}); float column=radial*0.5*(1.0-galErf(x/${s.toFixed(8)})); light+=column; firstMoment+=(-B/A)*column+radial*${(s/Math.sqrt(2*Math.PI)).toFixed(10)}/root*exp(-x*x/${(s*s).toFixed(8)}); }`).join('\n    ')}
    return vec2(light/(q*scale*root),max(0.0,firstMoment/max(light,1e-30)));
}
vec3 galResolvedLight(vec3 ray) {
    vec3 n = normalize(vAxisV), e1 = normalize(vBasisV), e2 = cross(n,e1);
    vec3 o = vec3(dot(-vCenterH,e1),dot(-vCenterH,e2),dot(-vCenterH,n));
    vec3 d = vec3(dot(ray,e1),dot(ray,e2),dot(ray,n));
    float q = max(vPhysical.x,.025), q2 = max(vPhysical.y,.1);
    float s1 = mix(1.0,.7,vPhysical.z), s2 = mix(.12,.1,vPhysical.z);
    vec2 diskSample=galGaussian(o,d,q,s1);
    float disk=diskSample.x,bulge=galGaussian(o,d,q2,s2).x;
    // Analytic first moment of the forward ray, not a plane intersection.
    // Inside the disk this still samples material AHEAD of the observer.
    vec3 p=o+diskSample.y*d;
    float footprint = max(length(dFdx(p.xy)),length(dFdy(p.xy)));
    vec3 structure = galDiskLight(p.xy/s1, footprint/s1, vColor, abs(dot(n,ray)));
    // Nearby rays keep a continuous finite-thickness dust band. As in the
    // old display model, this attenuates this galaxy's light only.
    float edge = 1.0-smoothstep(6.0,8.0,length(p/(s1*vec3(1.0,1.0,max(q,.15)))));
    float dust = mix(1.0,galDustBand(p,footprint,q),(1.0-vPhysical.z)*(1.0-smoothstep(.15,.55,abs(d.z))));
    vec3 coreColor = galUnitLuma(vColor*vec3(1.08,1.0,.88));
    return edge * (vFacePeak.x*disk*structure*mix(1.0,dust,.75)
        + vFacePeak.y*bulge*coreColor*mix(1.0,dust,.55));
}
#endif
`;
