import * as THREE from "three";

// View-depth range of the pass being drawn (set by scene.js renderSceneTiered).
// Point layers that live in the scene itself (submitted to both depth passes,
// so a star the camera approaches stays drawn inside the near tier) keep a
// vertex only when its view depth is in [x, y): every point lands in exactly
// one pass. Clip-space clipping alone cannot promise that -- with a tiny near
// plane, float32 rounds a light-year point onto the near pass's far plane
// (z == w) and it is drawn twice. Standalone so node smokes can import the
// star materials without the renderer.
export const tierDepthRange = { value: new THREE.Vector2(0, 1e38) };
