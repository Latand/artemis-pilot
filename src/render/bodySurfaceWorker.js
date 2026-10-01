import { generateBodySurfaceMaps } from './bodySurfaceMaps.js';
self.onmessage = ({ data }) => {
    const maps = generateBodySurfaceMaps(data.profile, data.width);
    // Elevation stays transient in this worker. Runtime needs only the color
    // and separate normal texture; the pure generator exposes elevation to tests.
    self.postMessage({ width: maps.width, height: maps.height, color: maps.color, normal: maps.normal },
        [maps.color.buffer, maps.normal.buffer]);
};
