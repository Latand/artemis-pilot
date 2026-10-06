// Shared by the headless on-screen motion check and actual browser capture.
export const TRAIL_FIXTURE = {
    camera: { dist: 1400, yaw: -.4, pitch: .8 },
    step: 1 / 12, steps: 216,
    // x, y, z, Schwarzschild radius, inertial vx, vy, vz (km and km/s).
    holes: [
        [1e8, 1e8, 0, 3, 1800, 1200, 600],
        [1.002e8, 1e8, 1e5, 3, -1200, 1800, -600],
        [.999e8, 1.002e8, -1e5, 3, 1200, -1800, 1200],
    ],
};
