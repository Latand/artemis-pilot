// WebGL2 readback with one PBO and one fence. No clientWaitSync timeout and
// no getBufferSubData until the fence signals. Never queue another read while
// one is pending; retain the previous exposure rather than block the UI.
export class AsyncPixelRead {
    constructor() { this.gl = null; this.buffer = null; this.sync = null; this.bytes = 0; this.reads = 0; this.polls = 0; }
    enqueue(gl, width, height) {
        if (this.sync || gl.isContextLost() || !gl.fenceSync || !gl.getBufferSubData) return false;
        if (this.gl && this.gl !== gl) this.dispose();
        this.gl = gl;
        const old = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        try {
            if (!this.buffer) this.buffer = gl.createBuffer();
            if (!this.buffer) return false;
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
            const bytes = width * height * 4;
            if (bytes !== this.bytes) { gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); this.bytes = bytes; }
            gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
            this.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
            gl.flush();
            return !!this.sync;
        } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, old); }
    }
    poll(output) {
        const gl = this.gl;
        if (!gl || !this.sync || gl.isContextLost()) return false;
        this.polls++;
        const result = gl.clientWaitSync(this.sync, 0, 0);
        if (result === gl.TIMEOUT_EXPIRED) return false;
        gl.deleteSync(this.sync); this.sync = null;
        if (result === gl.WAIT_FAILED) return false;
        const old = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
        try {
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.buffer);
            gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, output);
            this.reads++; return true;
        } finally { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, old); }
    }
    dispose() {
        if (this.gl && !this.gl.isContextLost()) {
            if (this.sync) this.gl.deleteSync(this.sync);
            if (this.buffer) this.gl.deleteBuffer(this.buffer);
        }
        this.gl = this.buffer = this.sync = null; this.bytes = 0;
    }
}
