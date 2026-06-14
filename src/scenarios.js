// Travel simulations: curated pre-flight states for the long crossing.
// Each scenario writes ship/world state directly after a clean restart and
// shows a short physics card explaining what the player is about to watch.
// Also owns the first-run title overlay (dismissal persisted in storage).
import { SEC_YEAR, AU_KM, PC_KM, R_EARTH, MU_E, PL, STARS, K, COSMIC_ZOOMS } from "./constants.js";
import { G } from "./state.js";
import { cam } from "./scene.js";
import { eph } from "./ephemeris.js";
import { addBlackHole, clearBlackHoles } from "./blackholes.js";
import { clearTrail, pushTrail, computePrediction } from "./trails.js";
import { toast } from "./achievements.js";
import { apTravelToFocus } from "./autopilot.js";
import { resetHints } from "./hints.js";
import { hideHelp } from "./hud.js";

const $ = id => document.getElementById(id);
let H = { restart: () => { } };

// tuned offline against the live ephemeris field (see scenario comments)
const SCENARIOS = [
    {
        id: "firstOrbit",
        name: "FIRST ORBIT",
        blurb: "Low Earth orbit, river on — learn the controls where falling means flying.",
        physicsCard: [
            "Orbit is perpetual falling: your velocity is sideways, so the ground keeps curving away beneath you.",
            "v = √(μ/r) ≈ 7.73 km/s at 300 km — every circular orbit has exactly one speed.",
            "Burn prograde (W) and the far side of the orbit rises; orbits change at the opposite end.",
            "G shows the river: space itself flowing into Earth at escape velocity.",
        ],
        setup() {
            G.gr = true;
            G.predict = true;
            G.focus = "ship";
            cam.dist = 2.6;
            resetHints();
        },
    },
    {
        id: "hohmann",
        name: "HOHMANN TO MARS",
        blurb: "Classic interplanetary transfer: wait for alignment, burn, coast.",
        physicsCard: [
            "A Hohmann transfer is half an ellipse touching both orbits — the cheapest path between planets.",
            "Burn once to raise aphelion to Mars, coast for months, burn again to match Mars's orbit.",
            "Departure windows exist because Mars must reach the meeting point when you do — alignment repeats every ~26 months.",
            "⇧T hands the intercept to the autopilot; warp with 1–9 while you wait.",
        ],
        setup() {
            G.warp = 3600;
            G.focus = 2; // Mars
            cam.dist = Math.max(PL[2].R * K * 7, 2);
        },
    },
    {
        id: "freeReturn",
        name: "LUNAR FREE-RETURN",
        blurb: "Apollo's safety net — a figure-8 around the Moon with engines off.",
        physicsCard: [
            "You are coasting on a figure-8: out past the Moon, around its far side, home — engines silent the whole way.",
            "The Moon's gravity is the only steering: it bends the path and slings you back toward an Earth perigee.",
            "Apollo flew this shape so an engine failure still meant a ride home — Apollo 13 survived on it.",
            "The loop takes ~13 days at this warp; P shows it ahead. Errors of metres per second grow into thousands of km.",
        ],
        setup() {
            // translunar ellipse (perigee 300 km, apogee 400,000 km) sampled at
            // 50,000 km altitude; apogee aimed 1.28 rad ahead of the Moon.
            // Offline integration: lunar pass ~12,400 km, return perigee ~5,500 km.
            const rP = R_EARTH + 300, rA = 400000, r0 = R_EARTH + 50000;
            const a = (rP + rA) / 2, e = (rA - rP) / (rA + rP), p = a * (1 - e * e);
            const nu = Math.acos(Math.min(1, Math.max(-1, (p / r0 - 1) / e)));
            const th = Math.atan2(eph.moonY, eph.moonX) + 1.28 + Math.PI + nu;
            const cF = Math.sqrt(MU_E / p);
            const vr = cF * e * Math.sin(nu), vt = cF * (1 + e * Math.cos(nu));
            const ct = Math.cos(th), st = Math.sin(th);
            G.x = r0 * ct; G.y = r0 * st; G.z = 0;
            G.vx = vr * ct - vt * st; G.vy = vr * st + vt * ct; G.vz = 0;
            G.heading = Math.atan2(G.vy, G.vx);
            G.pitch = 0;
            G.warp = 21600;
            G.focus = "earth";
            cam.dist = 520;
        },
    },
    {
        id: "slingshot",
        name: "JUPITER SLINGSHOT",
        blurb: "Steal orbital momentum from a gas giant.",
        physicsCard: [
            "In Jupiter's frame you arrive and leave at the same speed — a perfect elastic bounce.",
            "The Sun's frame disagrees: the swing rotates your velocity, and Jupiter's 13 km/s of orbital motion gets added to it.",
            "This pass dives to ~3.5 Jupiter radii and steals ~7 km/s of heliocentric speed; Jupiter slows by an immeasurable hair — momentum is conserved.",
            "Voyager, Cassini, and New Horizons all paid for the outer system with this trick.",
        ],
        setup() {
            // ship ahead of Jupiter, drifting back at v∞ = 5.6 km/s with a
            // 1.35e6 km impact parameter; offline run: periapsis 3.5 R_J,
            // heliocentric 6.9 → 14.6 km/s over an 8-day encounter.
            const J = 3, b = 1.35e6, vinf = 5.6, ahead = 2e6;
            const jvxH = eph.plVx[J] - eph.sunVx, jvyH = eph.plVy[J] - eph.sunVy;
            const vJ = Math.hypot(jvxH, jvyH);
            const tx = jvxH / vJ, ty = jvyH / vJ;
            G.x = eph.plX[J] + ahead * tx - b * ty;
            G.y = eph.plY[J] + ahead * ty + b * tx; G.z = 0;
            G.vx = eph.plVx[J] - vinf * tx;
            G.vy = eph.plVy[J] - vinf * ty; G.vz = 0;
            G.heading = Math.atan2(G.vy, G.vx);
            G.pitch = 0;
            G.warp = 86400;
            G.focus = J;
            cam.dist = 2800;
        },
    },
    {
        id: "photonSphere",
        name: "PHOTON SPHERE DIVE",
        blurb: "Fall into a 100 km black hole and watch space outrun light.",
        physicsCard: [
            "This hole's r_s is 100 km — roughly 34 solar masses packed into a city-sized sphere.",
            "At 1.5 r_s sits the photon sphere: light orbits there, and every engine-off path below it ends inside.",
            "The ISCO at 3 r_s is the last stable circular orbit; closer in, orbiting demands ever more thrust.",
            "G shows the river hitting light speed at the horizon — that is why nothing climbs back out.",
            "Gravity here is Paczyński–Wiita: the sandbox reproduces the correct ISCO and capture radius.",
        ],
        setup() {
            G.z = 0; G.vz = 0; G.pitch = 0;
            const r = Math.hypot(G.x, G.y) || 1;
            const ux = G.x / r, uy = G.y / r;
            addBlackHole(G.x + 80000 * ux, G.y + 80000 * uy, 100, 0, 0, true);
            G.gr = true;
            G.warp = 1;
            G.focus = "bh:0";
            cam.dist = 160;
        },
    },
    {
        id: "darkEnergy",
        name: "LOCAL-GROUP EXPANSION",
        blurb: "Start where Lambda is finally visible against a galaxy halo.",
        physicsCard: [
            "Dark energy uses the physical ΛCDM term a = ΩΛH₀²r, so at 1 AU it is only about 5e-25 m/s².",
            "A one-solar-mass star balances Λ near 111 pc; a Milky-Way-mass halo balances it around 1 Mpc.",
            "This starts 1.3 Mpc out: violet points along Λ expansion, green points along the Milky Way dark-matter halo tide.",
            "O toggles dark energy; Shift+O toggles the NFW halo. At Gyr/s warp, the Local Group finally moves.",
        ],
        setup() {
            const sd = Math.hypot(eph.sunX, eph.sunY) || 1;
            const ux = -eph.sunX / sd, uy = -eph.sunY / sd; // heliocentric outward through Earth
            const rH = 1.3e6 * PC_KM;
            G.x = ux * (rH - sd); G.y = uy * (rH - sd); G.z = 0;
            G.vx = ux * 72 + eph.sunVx; G.vy = uy * 72 + eph.sunVy; G.vz = 0;
            G.heading = Math.atan2(G.vy, G.vx);
            G.pitch = 0;
            G.darkEnergy = true;
            G.darkMatter = true;
            G.gr = true;
            G.warp = 1000000000 * SEC_YEAR;
            G.focus = "ship";
            cam.dist = COSMIC_ZOOMS.LOCAL_GROUP;
        },
    },
    {
        id: "proxima",
        name: "VOYAGE TO PROXIMA",
        blurb: "Hand the autopilot 4.25 light-years and watch the burn.",
        physicsCard: [
            "Proxima Centauri is 4.25 ly out — 40 trillion km, about 9,000× the distance to Neptune.",
            "The autopilot flies a flip-and-burn: accelerate to the midpoint, flip, decelerate the rest of the way.",
            "A real crossing at 0.5c takes ~17 years; the hybrids sleep through it in VR — you are doing that right now.",
            "Time warp is your VR clock: at 1 Myr/s, civilizations rise and fall in the span of a breath.",
        ],
        setup() {
            G.focus = "star:0";
            apTravelToFocus(toast);
            G.focus = "ship";
            cam.dist = 60;
            G.warp = 2592000; // 30 d/s — the burn unfolds over seconds
        },
    },
    {
        id: "sgrA",
        name: "DIVE TO SGR A*",
        blurb: "Cross the galaxy to the supermassive hole at its heart.",
        physicsCard: [
            "SGR A* is the Milky Way's central black hole: 4.15 million solar masses, r_s ≈ 12.3 million km.",
            "Its photon sphere at 1.5 r_s would swallow half of Mercury's orbit, yet its mean density is below water's.",
            "It sits 26,000 ly away — even at 1 Myr/s warp, the crossing shows how empty a galaxy is.",
            "⇧T engages the crossing; contact here is the photon sphere, the boundary past which no path returns.",
        ],
        setup() {
            G.gr = true;
            G.warp = 1000000 * SEC_YEAR;
            G.focus = "star:8";
            cam.dist = Math.max(STARS[8].R * K * 30, 1);
        },
    },
];

function syncModalClass() {
    const open = $("intro").style.display !== "none" || $("simsMenu").style.display === "flex";
    document.body.classList.toggle("ui-modal", open);
}

function requestAppFullscreen() {
    if (document.fullscreenElement) return;
    const root = $("root") || document.documentElement;
    if (!root.requestFullscreen) return;
    root.requestFullscreen({ navigationUI: "hide" }).catch(() => { });
}

function dismissIntro() {
    requestAppFullscreen();
    $("intro").style.display = "none";
    try { localStorage.setItem("ap_introSeen", "1"); } catch (e) { }
    syncModalClass();
}

export function toggleScenarioMenu() {
    const m = $("simsMenu");
    m.style.display = m.style.display === "flex" ? "none" : "flex";
    syncModalClass();
}
function closeMenu() {
    $("simsMenu").style.display = "none";
    syncModalClass();
}

function showPhysCard(sc) {
    const el = $("physCard");
    el.innerHTML = '<div class="pcTitle">' + sc.name + '</div><ul class="pcList">' +
        sc.physicsCard.map(l => "<li>" + l + "</li>").join("") +
        '</ul><div class="pcHint">CLICK TO DISMISS</div>';
    el.style.display = "block";
}

function loadScenario(sc) {
    hideHelp();
    H.restart();
    clearBlackHoles();
    sc.setup();
    clearTrail();
    pushTrail(true);
    computePrediction();
    if ($("intro").style.display !== "none") dismissIntro();
    closeMenu();
    showPhysCard(sc);
    toast("Simulation loaded · " + sc.name);
}

export function initScenarios(hooks) {
    H = hooks;
    const grid = $("simsGrid");
    for (const sc of SCENARIOS) {
        const d = document.createElement("div");
        d.className = "simCard";
        d.innerHTML = '<div class="scName">' + sc.name + '</div><div class="scBlurb">' + sc.blurb + "</div>";
        d.onclick = () => loadScenario(sc);
        grid.appendChild(d);
    }
    $("introEnter").onclick = dismissIntro;
    $("introSims").onclick = () => { dismissIntro(); toggleScenarioMenu(); };
    $("simsBtn").onclick = toggleScenarioMenu;
    $("simsClose").onclick = closeMenu;
    $("simsMenu").addEventListener("click", e => { if (e.target === e.currentTarget) closeMenu(); });
    $("physCard").onclick = () => { $("physCard").style.display = "none"; };
    document.addEventListener("pointerdown", requestAppFullscreen, { once: true, capture: true });
    syncModalClass();
}
