// Diagnostics must not replace the original test failure with an unbounded
// DevTools wait when the renderer is already blocked.
export async function boundedDiagnostic(task, timeoutMs = 5000) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(task).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error) })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: `Diagnostic timed out after ${timeoutMs} ms` }), timeoutMs); }),
        ]);
    } finally { clearTimeout(timer); }
}
