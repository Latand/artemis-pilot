function finiteNonnegative(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

// Pure delivery coordinator. Callers supply a reusable output record so the
// render-loop path can report physics truth without allocating per frame.
export function resolveJumpFrameDelivery(frame, deliveredAdvanceSec, postSimTimeSec, out) {
    const requested = finiteNonnegative(frame?.advanceSec);
    const delivered = Math.min(requested, finiteNonnegative(deliveredAdvanceSec));
    const fullyDelivered = delivered >= requested;
    out.requestedAdvanceSec = requested;
    out.deliveredAdvanceSec = delivered;
    out.fullyDelivered = fullyDelivered;
    out.syncTimeSec = fullyDelivered && requested > 0 && Number.isFinite(frame?.targetSimTimeSec)
        ? frame.targetSimTimeSec
        : NaN;
    out.postSimTimeSec = Number.isFinite(postSimTimeSec) ? postSimTimeSec : NaN;
    return out;
}
