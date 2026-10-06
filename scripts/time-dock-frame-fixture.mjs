// QA-only observation of delivered production frames. Never replace/drive the
// app scheduler: GPU admission may legitimately skip a raw display callback.
export function waitForProducedFrames(readFrame, count, {
    requestFrame = requestAnimationFrame, schedule = setTimeout, cancel = clearTimeout, timeoutMs = 10000,
} = {}) {
    const start = readFrame();
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || count < 1) throw Error('Invalid production frame window');
    return new Promise((resolve, reject) => {
        let settled = false, rafCallbacks = 0;
        const deadline = schedule(() => { settled = true; reject(Error(`Production did not deliver ${count} frames within ${timeoutMs}ms`)); }, timeoutMs);
        const poll = () => {
            if (settled) return;
            rafCallbacks++;
            const producedFrames = readFrame() - start;
            if (!Number.isSafeInteger(producedFrames) || producedFrames < 0 || producedFrames > count) {
                settled = true; cancel(deadline); reject(Error('Production frame window reset or overran')); return;
            }
            if (producedFrames === count) {
                settled = true; cancel(deadline); resolve({ producedFrames, rafCallbacks }); return;
            }
            requestFrame(poll);
        };
        requestFrame(poll);
    });
}
export const timeDockFrameHook = `window.__timeDockFrames = count => (${waitForProducedFrames.toString()})(() => frameNo, count);`;
