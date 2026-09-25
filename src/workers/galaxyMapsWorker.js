// Builds the Milky Way's face-on structure maps (universe/galaxyMaps.js) off
// the main thread and hands back the GPU payload (half-float RGBA mip chain).
import { generateGalaxyMaps, packGalaxyMapsHalf } from "../universe/galaxyMaps.js";

self.onmessage = e => {
    if (e.data?.type !== "build") return;
    const t0 = performance.now();
    const packed = packGalaxyMapsHalf(generateGalaxyMaps());
    packed.ms = performance.now() - t0;
    self.postMessage(packed, [...packed.levels.map(l => l.data.buffer), packed.lane.buffer]);
};
