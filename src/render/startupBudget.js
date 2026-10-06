// An async driver compile is optional. Its promise may never settle or reject
// late after a context loss. A deadline unblocks initialization; it cannot
// interrupt a driver call that synchronously blocks the browser main thread.
export function withinStartupBudget(work, timeoutMs = 1200) {
    return new Promise(resolve => {
        let settled = false;
        const finish = result => {
            if (settled) return;
            settled = true; clearTimeout(timer); resolve(result);
        };
        const timer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
        Promise.resolve().then(work).then(value => finish({ status: 'ready', value }),
            error => finish({ status: 'error', error: String(error?.message || error) }));
    });
}
