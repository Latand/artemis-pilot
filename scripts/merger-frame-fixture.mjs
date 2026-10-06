import assert from 'node:assert/strict';
// Local QA exposes only the existing counter. A current deployed app can use
// its public submission counter; neither path drives or replaces its scheduler.
export const mergerFrameHook = '\nwindow.__mergerFrameNumber = () => frameNo;';
export function readMergerFrameNumber() {
  return window.__mergerFrameNumber?.() ?? window.__renderFrameGate?.submitted;
}
export function mergerFramesDelivered({ start, count }) {
  const frame = window.__mergerFrameNumber?.() ?? window.__renderFrameGate?.submitted;
  return Number.isSafeInteger(frame) && frame >= start + count;
}
export async function waitForMergerFrames(page, count) {
  assert(Number.isSafeInteger(count) && count > 0);
  const start = await page.evaluate(readMergerFrameNumber);
  assert(Number.isSafeInteger(start) && start >= 0, 'Merger QA needs a local source counter or current deployed GPU submission counter');
  await page.waitForFunction(mergerFramesDelivered, { start, count }, { timeout:180000, polling:'raf' });
  const end = await page.evaluate(readMergerFrameNumber);
  assert(Number.isSafeInteger(end) && end >= start + count, 'Requested production frames actually ran');
  return { start, end, requestedFrames:count, producedFrames:end-start };
}
