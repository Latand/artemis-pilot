// Explore "Object details": the physical facts shown for a focused body, and
// the units the viewing distance is reported in. Guards the things that are
// easy to regress silently — inventing a number the records do not carry,
// presenting a simulated orbit as a measurement, printing an interstellar
// distance as raw kilometres, and fact values breaking across lines on a phone.
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const checks = [];
const check = (condition, message) => { assert.ok(condition, message); checks.push(message); };

const server = await createServer({ server: { host: '127.0.0.1', port: 0, hmr: false } });
await server.listen();
const port = server.httpServer.address().port;
const browser = await chromium.launch({ headless: true });
const errors = [];
const observed = {};

async function openExplore(page) {
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/?tier1=0&hidehelp=1&dpr=1`);
    await page.waitForFunction(() => window.__AP_READY, null, { timeout: 60000 });
    const enter = page.getByRole('button', { name: 'ENTER SIMULATION', exact: true });
    if (await enter.isVisible()) await enter.click();
    await page.evaluate(async () => {
        const { setPaused } = await import('/src/timeCtl.js');
        setPaused(true, 'facts-smoke');
    });
    await page.waitForFunction(() => __G.focus === 'earth');
    await page.waitForTimeout(900);
}

const facts = page => page.evaluate(() => {
    const out = {};
    for (const row of document.querySelectorAll('#exploreFacts > div')) {
        const [dt, dd] = row.children;
        out[dt.textContent] = dd.textContent;
    }
    return { rows: out, basis: document.getElementById('exploreBasis').textContent };
});

const visit = async (page, destination, until) => {
    await page.locator(`[data-destination="${destination}"]`).click();
    await page.waitForFunction(until, null, { timeout: 30000 });
    await page.waitForTimeout(900);
    return facts(page);
};

// Bodies without a destination button are focused through the same setFocus
// the navigator uses. Name and rows are written in one panel update, so once
// the name matches, the rows belong to that body.
async function focus(page, value, name) {
    await page.evaluate(async v => {
        const { setFocus } = await import('/src/input.js');
        setFocus(v);
    }, value);
    await page.waitForFunction(n => document.getElementById('exploreObject').textContent === n, name, { timeout: 30000 });
    return facts(page);
}

// Earth's and the planets' Sun distance and orbital speed come from the
// simulation's approximate orbital phases. Those rows must say Simulated, the
// unqualified rows must be gone, and the copy must not claim real positions.
function simulatedOrbit(name, snapshot) {
    check(/^\d+\.\d{3} AU$/.test(snapshot.rows['Simulated Sun distance']), `${name} labels its Sun distance as simulated, in AU`);
    check(/^\d+\.\d{2} km\/s$/.test(snapshot.rows['Simulated orbital speed']), `${name} labels its orbital speed as simulated, in km/s`);
    for (const unqualified of ['Distance from the Sun', 'Orbital speed']) {
        check(!(unqualified in snapshot.rows), `${name} shows no unqualified "${unqualified}" row`);
    }
    check(/simulated/i.test(snapshot.basis) && /approximate/i.test(snapshot.basis), `${name} copy says its simulated rows are approximate`);
    check(!/planetary positions computed to today/i.test(snapshot.basis), `${name} copy does not claim real planetary positions`);
}

try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openExplore(page);
    const records = await page.evaluate(async () => {
        const { MOONS } = await import('/src/moons.js');
        const { PL, STARS } = await import('/src/constants.js');
        return {
            moons: MOONS.map(m => ({ name: m.name, parent: PL[m.p].name, orbitUsesParentMu: m.mu === PL[m.p].mu })),
            proxima: STARS[0].name,
            sgrA: STARS.findIndex(s => s.name === 'SGR A*'),
        };
    });

    // ---- Earth: measured radius, mass and gravity; simulated orbit ----
    const earth = await facts(page);
    observed.earth = earth;
    check(/6,371 km/.test(earth.rows.Radius), 'Earth reports its radius');
    check(/^5\.9\de24 kg$/.test(earth.rows.Mass), 'Earth reports mass in kg from its gravitational parameter');
    check(/^9\.8\d m\/s²$/.test(earth.rows['Surface gravity']), 'Earth reports surface gravity in m/s²');
    check(earth.rows.Basis === 'MEASURED', 'Earth is labelled as measured data');
    simulatedOrbit('Earth', earth);

    // ---- Earth's Moon: the one moon with its own gravitational parameter ----
    const moon = await visit(page, 'moon', () => __G.focus === 'moon');
    observed.moon = moon;
    check(/1,737 km/.test(moon.rows.Radius), 'Moon reports its radius');
    check(moon.rows.Mass === '7.35e22 kg', 'Moon reports mass 7.35e22 kg');
    check(moon.rows['Surface gravity'] === '1.62 m/s²', 'Moon reports surface gravity 1.62 m/s²');
    check(!!moon.rows['Distance from Earth'], 'Moon reports its distance from Earth');
    check(!('Orbital speed' in moon.rows) && !('Simulated orbital speed' in moon.rows), 'Moon does not claim a heliocentric orbital speed');

    // ---- Planetary moons: MOONS carries the parent's mu for the orbit only ----
    check(records.moons.length > 0 && records.moons.every(m => m.orbitUsesParentMu),
        'MOONS keeps the parent mu that drives each analytic orbit');
    check(records.moons[2]?.name === 'IO', 'moon:2 is Io');
    const io = await focus(page, 'moon:2', 'IO');
    observed.io = io;
    check(/1,82\d km/.test(io.rows.Radius), 'Io reports its own radius');
    for (const absent of ['Mass', 'Surface gravity']) {
        check(!(absent in io.rows), `Io shows no ${absent.toLowerCase()} (the only mu on record is Jupiter's)`);
    }
    check(io.rows.Basis === 'MEASURED', 'Io radius is labelled as measured data');

    observed.planetaryMoons = {};
    for (const [i, m] of records.moons.entries()) {
        const snapshot = await focus(page, `moon:${i}`, m.name);
        observed.planetaryMoons[m.name] = snapshot.rows;
        assert.ok(!('Mass' in snapshot.rows) && !('Surface gravity' in snapshot.rows),
            `${m.name} shows mass or gravity derived from ${m.parent}'s mu: ${JSON.stringify(snapshot.rows)}`);
        assert.ok(snapshot.rows.Radius, `${m.name} still reports its radius`);
    }
    checks.push(`All ${records.moons.length} planetary moons show no mass or surface gravity`);

    // ---- Mars: a PL planet without a destination button ----
    const mars = await focus(page, 2, 'MARS');
    observed.mars = mars;
    check(/^6\.4\de23 kg$/.test(mars.rows.Mass), 'Mars reports mass in kg');
    check(/^3\.7\d m\/s²$/.test(mars.rows['Surface gravity']), 'Mars reports surface gravity');
    check(mars.rows.Basis === 'MEASURED', 'Mars is labelled as measured data');
    simulatedOrbit('Mars', mars);

    // ---- Jupiter: a planet from the PL table ----
    const jupiter = await visit(page, 'jupiter', () => __G.focus === 3);
    observed.jupiter = jupiter;
    check(/^1\.9\de27 kg$/.test(jupiter.rows.Mass), 'Jupiter reports mass in kg');
    check(/^2\d\.\d\d m\/s²$/.test(jupiter.rows['Surface gravity']), 'Jupiter reports surface gravity');
    check(jupiter.rows.Basis === 'MEASURED', 'Jupiter is labelled as measured data');
    simulatedOrbit('Jupiter', jupiter);

    // ---- Sun: a modeled body, so its numbers come from the evolution model ----
    const sun = await visit(page, 'sun', () => __G.focus === 'sun');
    observed.sun = sun;
    check(/K$/.test(sun.rows['Effective temperature']), 'Sun reports an effective temperature');
    check(/L☉$/.test(sun.rows.Luminosity), 'Sun reports luminosity in solar units');
    check(/M☉$/.test(sun.rows.Mass), 'Sun reports mass in solar units');
    check(/R☉/.test(sun.rows.Radius), 'Sun reports radius in solar units');
    check(sun.rows.Basis === 'MODELED', 'Sun evolution is labelled as modeled');

    // ---- Sgr A*: a catalogue black hole ----
    check(records.sgrA >= 0, 'Sgr A* is in the star catalogue');
    const sgrA = await focus(page, `star:${records.sgrA}`, 'SGR A*');
    observed.sgrA = sgrA;
    check(/M☉$/.test(sgrA.rows.Mass), 'Sgr A* reports mass in solar units');
    check(!!sgrA.rows['Schwarzschild radius'], 'Sgr A* reports its Schwarzschild radius');

    // ---- A catalogue star: present fields shown, absent fields omitted ----
    const proxima = await visit(page, 'proxima', () => __G.focus === 'star:0');
    observed.proxima = proxima;
    check(/M☉$/.test(proxima.rows.Mass), 'Catalog star reports mass in solar units');
    check(/^4\.\d{2} ly$/.test(proxima.rows['Distance from the Sun']), 'Catalog star reports distance in light-years');
    for (const absent of ['Surface gravity', 'Orbital speed', 'Simulated orbital speed']) {
        check(!(absent in proxima.rows), `Catalog star does not invent ${absent.toLowerCase()}`);
    }

    // ---- No fact anywhere may be a non-number leaking into the UI ----
    const snapshots = Object.entries(observed).flatMap(([name, snapshot]) => name === 'planetaryMoons'
        ? Object.entries(snapshot).map(([moonName, rows]) => [moonName, { rows }])
        : [[name, snapshot]]);
    for (const [name, snapshot] of snapshots) {
        for (const [label, value] of Object.entries(snapshot.rows)) {
            assert.doesNotMatch(String(value), /NaN|undefined|null|Infinity/,
                `${name}: ${label} rendered a non-value (${value})`);
        }
    }
    checks.push('No fact renders NaN, undefined or Infinity');

    // ---- Viewing distance stays readable across fifteen orders of magnitude ----
    const units = [];
    for (const [name, ly] of [['interstellar', 20], ['galactic', 5e4], ['intergalactic', 5e6]]) {
        await page.evaluate(async l => {
            const { LY_SCENE } = await import('/src/constants.js');
            __cam.dist = LY_SCENE * l;
        }, ly);
        await page.waitForTimeout(900);
        const value = (await facts(page)).rows['Viewing distance'];
        units.push({ name, ly, value });
        check(/\d\s(ly|kly|Mly)$/.test(value), `${name} viewing distance uses a light-year unit (${value})`);
        assert.doesNotMatch(value, /\d{13,}/, `${name} viewing distance printed raw kilometres (${value})`);
    }
    observed.viewingDistance = units;
    checks.push('Viewing distance never prints a raw kilometre figure at interstellar scale');
    await page.close();

    // ---- 390×844 phone with Object details open: every value on one line ----
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await openExplore(phone);
    await phone.locator('#exploreInfo > summary').click();
    check(await phone.evaluate(() => document.getElementById('exploreInfo').open), 'Object details opens on a 390 px phone');
    observed.phoneLayout = {};
    for (const [label, value, name] of [
        ['Earth', 'earth', 'Earth'], ['Moon', 'moon', 'Moon'], ['Io', 'moon:2', 'IO'], ['Mars', 2, 'MARS'],
        ['Sun', 'sun', 'Sun'], ['Sgr A*', `star:${records.sgrA}`, 'SGR A*'], ['Proxima', 'star:0', records.proxima],
    ]) {
        await focus(phone, value, name);
        const layout = await phone.evaluate(() => {
            const list = document.getElementById('exploreFacts').getBoundingClientRect();
            const panel = document.getElementById('explorePanel');
            const range = document.createRange();
            const rows = [...document.querySelectorAll('#exploreFacts > div')].map(row => {
                const [dt, dd] = row.children;
                // Count line boxes; a fallback glyph such as ☉ may sit a few
                // pixels off the baseline, so only a jump of most of a line counts.
                range.selectNodeContents(dd);
                const tops = [...range.getClientRects()].map(r => r.top).sort((a, b) => a - b);
                const step = parseFloat(getComputedStyle(dd).fontSize) * 0.6;
                const valueLines = tops.reduce((n, top, i) => n + (i > 0 && top - tops[i - 1] > step ? 1 : 0), tops.length ? 1 : 0);
                const v = dd.getBoundingClientRect(), l = dt.getBoundingClientRect();
                return { label: dt.textContent, value: dd.textContent, valueLines, valueLeft: v.left, valueRight: v.right, labelRight: l.right };
            });
            return { rows, listLeft: list.left, listRight: list.right, panelOverflowX: panel.scrollWidth - panel.clientWidth, viewportWidth: innerWidth };
        });
        observed.phoneLayout[label] = layout;
        assert.ok(layout.rows.length > 1 && layout.listRight <= layout.viewportWidth, `${label}: facts list is laid out inside the phone viewport`);
        for (const row of layout.rows) {
            assert.equal(row.valueLines, 1, `${label}: "${row.label}" value "${row.value}" wraps onto ${row.valueLines} lines at 390 px`);
            assert.ok(row.valueLeft >= layout.listLeft - 0.5 && row.valueRight <= layout.listRight + 0.5,
                `${label}: "${row.value}" overflows the facts list`);
            assert.ok(row.labelRight <= row.valueLeft + 0.5, `${label}: "${row.label}" overlaps its value "${row.value}"`);
        }
        assert.ok(layout.panelOverflowX <= 0, `${label}: Object details scrolls sideways at 390 px`);
        checks.push(`${label}: all ${layout.rows.length} values sit on one line at 390×844 without overlap or overflow`);
    }
    await phone.close();

    assert.deepEqual(errors, [], 'no browser errors');
    checks.push('No browser errors');

    await mkdir(resolve('docs/exploration-ui'), { recursive: true });
    await writeFile(resolve('docs/exploration-ui/facts-checks.json'),
        JSON.stringify({ checks, observed, errors }, null, 2));
    console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
    await browser.close();
    await server.close();
}
