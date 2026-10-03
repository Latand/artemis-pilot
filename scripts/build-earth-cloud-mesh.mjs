// Offline only: fixed detail18 geodesic belt and 5-degree equirectangular caps.
// The reference-radius Float32 round trips reproduce the reviewed unit mesh.
// Production loads only the generated payload; no hull generation runs in a frame.
import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { ConvexHull } from "three/addons/math/ConvexHull.js";
function buildCappedEarthCloudUnitMesh() {
  const radius = 6.377;
  const capDegrees = 5;
  const sectors = 96;
  const ringCount = 2;
  const native = new THREE.IcosahedronGeometry(1, 18);
  native.rotateY(Math.PI);
  const indexed = mergeVertices(native, 1e-7);
  const source = {
    positions: Array.from(indexed.attributes.position.array, (x) => Math.fround(x * radius)),
    uv: Array.from(indexed.attributes.uv.array),
    indices: Array.from(indexed.index.array)
  };
  native.dispose();
  indexed.dispose();
  const southV = capDegrees / 180, northV = 1 - southV, EPS = 1e-10;
  const atUv = (u, v) => {
    const phi = u * 2 * Math.PI, theta = (1 - v) * Math.PI;
    return [-Math.cos(phi) * Math.sin(theta) * radius, Math.cos(theta) * radius, Math.sin(phi) * Math.sin(theta) * radius];
  };
  const sourceVertices = Array.from({ length: source.positions.length / 3 }, (_, i) => ({ p: source.positions.slice(i * 3, i * 3 + 3), uv: source.uv.slice(i * 2, i * 2 + 2) }));
  const canonical = (u) => {
    let n = u - Math.floor(u);
    if (n > 1 - EPS || n < EPS) n = 0;
    return Math.round(n * 1e10) / 1e10;
  };
  function intersection(a, b, boundary) {
    const t = (boundary - a.uv[1]) / (b.uv[1] - a.uv[1]);
    let u = a.uv[0] + t * (b.uv[0] - a.uv[0]);
    u = canonical(u) + Math.floor(u + EPS);
    return { p: atUv(u, boundary), uv: [u, boundary] };
  }
  function clip(poly, boundary, above) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ia = above ? a.uv[1] >= boundary : a.uv[1] <= boundary, ib = above ? b.uv[1] >= boundary : b.uv[1] <= boundary;
      if (ia) out.push(a);
      if (ia !== ib) out.push(intersection(a, b, boundary));
    }
    return out;
  }
  const polygons = [];
  const rings = /* @__PURE__ */ new Map([[southV, /* @__PURE__ */ new Set()], [northV, /* @__PURE__ */ new Set()]]);
  for (let i = 0; i < source.indices.length; i += 3) {
    let p = source.indices.slice(i, i + 3).map((j) => sourceVertices[j]);
    p = clip(p, southV, true);
    p = clip(p, northV, false);
    if (p.length >= 3) {
      polygons.push(p);
      for (const v of p) if (rings.has(v.uv[1])) rings.get(v.uv[1]).add(canonical(v.uv[0]));
    }
  }
  for (const us of rings.values()) for (let i = 0; i < sectors; i++) us.add(canonical(i / sectors));
  const boundaryAngles = new Map([...rings].map(([v, us]) => [v, [...us].sort((a, b) => a - b)]));
  const vertices = [], indices = [], indexByKey = /* @__PURE__ */ new Map();
  let omittedZeroArea = 0;
  function vertex(v) {
    const p = v.p.map(Math.fround), uv = v.uv.map(Math.fround);
    const k = p.map((x) => Math.round(x * 1e7)).join(",") + "|" + uv.map((x) => Math.round(x * 1e7)).join(",");
    if (indexByKey.has(k)) return indexByKey.get(k);
    const id = vertices.length;
    vertices.push({ p, uv });
    indexByKey.set(k, id);
    return id;
  }
  function triangle(a, b, c) {
    const p = a.p, q = b.p, r = c.p;
    const x = q.map((x2, i) => x2 - p[i]), y = r.map((x2, i) => x2 - p[i]);
    const n = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    const d = n.reduce((s, x2, i) => s + x2 * p[i], 0);
    if (Math.hypot(...n) < 1e-13) {
      omittedZeroArea++;
      return;
    }
    if (d < 0) [b, c] = [c, b];
    indices.push(vertex(a), vertex(b), vertex(c));
  }
  for (let poly of polygons) {
    const anchor = poly.findIndex((v) => v.uv[1] !== southV && v.uv[1] !== northV);
    if (anchor < 0) throw new Error("Unexpected all-boundary belt polygon");
    poly = poly.slice(anchor).concat(poly.slice(0, anchor));
    const split = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      split.push(a);
      if (a.uv[1] === b.uv[1] && boundaryAngles.has(a.uv[1])) {
        const lo = Math.min(a.uv[0], b.uv[0]), hi = Math.max(a.uv[0], b.uv[0]);
        const cuts = [];
        for (const u of boundaryAngles.get(a.uv[1])) for (const k of [-1, 0, 1, 2]) {
          const v = u + k;
          if (v > lo + EPS && v < hi - EPS) cuts.push(v);
        }
        cuts.sort((x, y) => a.uv[0] < b.uv[0] ? x - y : y - x);
        for (const u of cuts) split.push({ p: atUv(u, a.uv[1]), uv: [u, a.uv[1]] });
      }
    }
    for (let i = 1; i < split.length - 1; i++) triangle(split[0], split[i], split[i + 1]);
  }
  const beltTriangles = indices.length / 3;
  for (const [boundary, angles] of boundaryAngles) {
    const north = boundary > 0.5;
    const levels = Array.from({ length: ringCount }, (_, i) => north ? 1 - (1 - boundary) * (ringCount - i) / ringCount : boundary * (ringCount - i) / ringCount);
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i], b = i + 1 < angles.length ? angles[i + 1] : angles[0] + 1;
      for (let row = 0; row < levels.length - 1; row++) {
        const v2 = levels[row], w = levels[row + 1], A = { p: atUv(a, v2), uv: [a, v2] }, B = { p: atUv(b, v2), uv: [b, v2] }, C = { p: atUv(a, w), uv: [a, w] }, D = { p: atUv(b, w), uv: [b, w] };
        triangle(A, B, C);
        triangle(B, D, C);
      }
      const v = levels.at(-1), pole = north ? 1 : 0;
      triangle({ p: atUv(a, v), uv: [a, v] }, { p: atUv(b, v), uv: [b, v] }, { p: [0, north ? radius : -radius, 0], uv: [(a + b) / 2, pole] });
    }
  }
// The supporting convex hull rejects inward-slanting clipped polygon fans.
  // This runs offline only; fixed vertex insertion order keeps the payload stable.
  const rawVertices = vertices.slice(), uniquePoints = /* @__PURE__ */ new Map();
  for (const v of rawVertices) {
    const r = Math.hypot(...v.p), p = v.p.map((x) => x * radius / r), k = p.map((x) => Math.round(x * 1e7)).join(",");
    if (!uniquePoints.has(k)) uniquePoints.set(k, new THREE.Vector3(...p));
  }
  const hull = new ConvexHull().setFromPoints([...uniquePoints.values()]);
  vertices.length = 0;
  indices.length = 0;
  indexByKey.clear();
  for (const face of hull.faces) {
    const corners = [];
    let e = face.edge;
    do {
      const p = e.head().point;
      const r = p.length(), pole = Math.hypot(p.x, p.z) < 1e-7;
      corners.push({ p: p.toArray(), uv: [pole ? NaN : canonical(Math.atan2(p.z, -p.x) / (2 * Math.PI)), 1 - Math.acos(Math.max(-1, Math.min(1, p.y / r))) / Math.PI] });
      e = e.next;
    } while (e !== face.edge);
    if (corners.length !== 3) throw new Error("Hull face not triangular");
    const us = corners.map((v) => v.uv[0]).filter(Number.isFinite);
    if (Math.max(...us) - Math.min(...us) > 0.5) {
      for (const v of corners) if (v.uv[0] < 0.5) v.uv[0] += 1;
    }
    const finite = corners.map((v) => v.uv[0]).filter(Number.isFinite);
    for (const v of corners) if (!Number.isFinite(v.uv[0])) v.uv[0] = finite.reduce((a, b) => a + b, 0) / finite.length;
    triangle(...corners);
  }
  const mesh = { positions: vertices.flatMap((v) => v.p), normals: vertices.flatMap((v) => {
    const r = Math.hypot(...v.p);
    return v.p.map((x) => Math.fround(x / r));
  }), uv: vertices.flatMap((v) => v.uv), indices };
  if (vertices.length >= 65536) throw new Error("Cloud indices exceed Uint16");
  return {
    positions: Float32Array.from(mesh.positions, (value) => value / radius),
    uv: Float32Array.from(mesh.uv),
    indices: Uint16Array.from(mesh.indices)
  };
}
export {
  buildCappedEarthCloudUnitMesh
};
