export const SURFACE_EXPOSURE_MAX_WIDTH = 512;
export const SURFACE_EXPOSURE_MAX_HEIGHT = 256;
const TAU = Math.PI * 2;
const linearByte = Float64Array.from({ length: 256 }, (_, i) => {
    const c = i / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
});

export function surfaceExposureTurns(angularVelocity, simExposureSeconds) {
    if (!Number.isFinite(angularVelocity) || !Number.isFinite(simExposureSeconds)) return 0;
    return Math.min(1, Math.abs(angularVelocity * simExposureSeconds / TAU));
}

// Prefix integrals are normalized by longitude. RGB is averaged in linear
// light; alpha and non-colour maps are never sRGB decoded. No latitude mixing
// beyond a bounded area downsample, and no random/stochastic samples.
export function buildLongitudeIntegral(bytes, sourceWidth, sourceHeight, {
    srgb = false, flipY = false,
    maxWidth = SURFACE_EXPOSURE_MAX_WIDTH, maxHeight = SURFACE_EXPOSURE_MAX_HEIGHT,
} = {}) {
    if (!Number.isInteger(sourceWidth) || sourceWidth < 1 || !Number.isInteger(sourceHeight) || sourceHeight < 1 ||
        bytes?.length !== sourceWidth * sourceHeight * 4) throw new Error('Invalid longitude exposure pixels');
    const width = Math.max(1, Math.min(sourceWidth, Math.floor(maxWidth)));
    const height = Math.max(1, Math.min(sourceHeight, Math.floor(maxHeight)));
    const data = new Float32Array((width + 1) * height * 4);
    for (let y = 0; y < height; y++) {
        const sourceRow = flipY ? height - 1 - y : y;
        const y0 = Math.floor(sourceRow * sourceHeight / height), y1 = Math.floor((sourceRow + 1) * sourceHeight / height);
        const sums = [0, 0, 0, 0];
        for (let x = 0; x < width; x++) {
            const x0 = Math.floor(x * sourceWidth / width), x1 = Math.floor((x + 1) * sourceWidth / width);
            const pixel = [0, 0, 0, 0];
            for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
                const k = (sy * sourceWidth + sx) * 4;
                for (let c = 0; c < 4; c++) pixel[c] += srgb && c < 3 ? linearByte[bytes[k + c]] : bytes[k + c] / 255;
            }
            const out = (y * (width + 1) + x + 1) * 4;
            for (let c = 0; c < 4; c++) {
                sums[c] += pixel[c] / (y1 - y0) / sourceWidth;
                data[out + c] = sums[c];
            }
        }
    }
    return { data, width, height };
}

// Shared row kernel: DOM fallback, worker and synchronous oracle use the same
// summation order, including source flipY applied by the row caller.
export function integrateLongitudeRow(data, bytes, sourceWidth, sourceRows, width, row, srgb) {
    const sums = [0, 0, 0, 0], pixel = [0, 0, 0, 0];
    for (let x = 0; x < width; x++) {
        pixel.fill(0);
        const x0 = Math.floor(x * sourceWidth / width), x1 = Math.floor((x + 1) * sourceWidth / width);
        for (let y = 0; y < sourceRows; y++) for (let sx = x0; sx < x1; sx++) {
            const k = (y * sourceWidth + sx) * 4;
            for (let c = 0; c < 4; c++) pixel[c] += srgb && c < 3 ? linearByte[bytes[k + c]] : bytes[k + c] / 255;
        }
        const out = (row * (width + 1) + x + 1) * 4;
        for (let c = 0; c < 4; c++) { sums[c] += pixel[c] / sourceRows / sourceWidth; data[out + c] = sums[c]; }
    }
}
export const SURFACE_EXPOSURE_MAX_SOURCE_PIXELS = 4 * 1024 * 1024;
export const SURFACE_EXPOSURE_COMPACT_SOURCE_PIXELS = 2 * 1024 * 1024;
// Read only bounded JPEG/PNG headers before decode. A changed response must
// not expand an already-observed 2K source into an unexpectedly large bitmap.
export function encodedSurfaceDimensions(bytes) {
    if (!(bytes instanceof Uint8Array)) return null;
    if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71 &&
        bytes[12] === 73 && bytes[13] === 72 && bytes[14] === 68 && bytes[15] === 82) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (bytes[0] !== 255 || bytes[1] !== 216) return null;
    let offset = 2;
    while (offset + 4 <= bytes.length) {
        if (bytes[offset++] !== 255) return null;
        while (bytes[offset] === 255) offset++;
        const marker = bytes[offset++];
        if (marker === 217 || marker === 218) return null;
        if (marker === 1 || marker >= 208 && marker <= 215) continue;
        const length = bytes[offset] * 256 + bytes[offset + 1];
        if (length < 2 || offset + length > bytes.length) return null;
        if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
            if (length < 7) return null;
            return { width: bytes[offset + 5] * 256 + bytes[offset + 6], height: bytes[offset + 3] * 256 + bytes[offset + 4] };
        }
        offset += length;
    }
    return null;
}
