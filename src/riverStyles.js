import { setRiverStyle } from './river.js';

// One presentation: Time pulses. Older saved choices and share URLs cannot
// silently restore a removed style. The gravity on/off control is retained.
export function initRiverStyles() {
    setRiverStyle(3);
}
