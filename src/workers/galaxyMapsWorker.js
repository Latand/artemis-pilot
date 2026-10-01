// Builds the Milky Way's face-on structure maps (universe/galaxyMaps.js) off
// the main thread and hands back the GPU payload (half-float RGBA mip chain,
// and the old stars' arm transport table, universe/armTransport.js).
import { generateGalaxyMaps, packGalaxyMapsHalf } from "../universe/galaxyMaps.js";
import { buildArmTransport } from "../universe/armTransport.js";

self.onmessage = e => {
    if (e.data?.type !== "build") return;
    const t0 = performance.now();
    const maps = generateGalaxyMaps();
    const packed = packGalaxyMapsHalf(maps);
    const arm = buildArmTransport(maps);
    packed.arm = { nr: arm.nr, nb: arm.nb, data: arm.half };
    packed.ms = performance.now() - t0;
    self.postMessage(packed, [...packed.levels.map(l => l.data.buffer), packed.lane.buffer, packed.arm.data.buffer]);
};
