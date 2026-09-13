// Explore "Object details": the physical facts shown for a focused body, and
// the units the viewing distance is reported in. Guards two things that are
// easy to regress silently — inventing a number the records do not carry, and
// printing an interstellar distance as raw kilometres.
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

try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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

    const facts = () => page.evaluate(() => {
        const out = {};
        for (const row of document.querySelectorAll('#exploreFacts > div')) {
            const [dt, dd] = row.children;
            out[dt.textContent] = dd.textContent;
        }
        return { rows: out, basis: document.getElementById('exploreBasis').textContent };
    });
    const visit = async (destination, until) => {
        await page.locator(`[data-destination="${destination}"]`).click();
        await page.waitForFunction(until, null, { timeout: 30000 });
        await page.waitForTimeout(900);
        return facts();
    };

    // ---- Earth: a measured body with a full record ----
    await page.waitForFunction(() => __G.focus === 'earth');
    await page.waitForTimeout(900);
    const earth = await facts();
    observed.earth = earth;
    check(/6,371 km/.test(earth.rows.Radius), 'Earth reports its radius');
    check(/^5\.9\de24 kg$/.test(earth.rows.Mass), 'Earth reports mass in kg from its gravitational parameter');
    check(/^9\.8\d m\/s²$/.test(earth.rows['Surface gravity']), 'Earth reports surface gravity in m/s²');
    check(/^[01]\.\d{3} AU$/.test(earth.rows['Distance from the Sun']), 'Earth reports its Sun distance in AU');
    check(/^\d+\.\d{2} km\/s$/.test(earth.rows['Orbital speed']), 'Earth reports orbital speed in km/s');
    check(earth.rows.Basis === 'MEASURED', 'Earth is labelled as measured data');
    check(earth.basis.length > 0, 'The basis line carries model-limit copy');

    // ---- Moon: mass is known, but MOONS carries no mu for other moons ----
    const moon = await visit('moon', () => __G.focus === 'moon');
    observed.moon = moon;
    check(/1,737 km/.test(moon.rows.Radius), 'Moon reports its radius');
    check(/^7\.3\de22 kg$/.test(moon.rows.Mass), 'Moon reports mass in kg');
    check(/^1\.6\d m\/s²$/.test(moon.rows['Surface gravity']), 'Moon reports surface gravity');
    check(!!moon.rows['Distance from Earth'], 'Moon reports its distance from Earth');
    check(!('Orbital speed' in moon.rows), 'Moon does not claim a heliocentric orbital speed');

    // ---- Jupiter: a planet from the PL table ----
    const jupiter = await visit('jupiter', () => __G.focus === 3);
    observed.jupiter = jupiter;
    check(/^1\.9\de27 kg$/.test(jupiter.rows.Mass), 'Jupiter reports mass in kg');
    check(/^2\d\.\d\d m\/s²$/.test(jupiter.rows['Surface gravity']), 'Jupiter reports surface gravity');
    check(/^\d\.\d{3} AU$/.test(jupiter.rows['Distance from the Sun']), 'Jupiter reports its Sun distance in AU');
    check(jupiter.rows.Basis === 'MEASURED', 'Jupiter is labelled as measured data');

    // ---- Sun: a modeled body, so its numbers come from the evolution model ----
    const sun = await visit('sun', () => __G.focus === 'sun');
    observed.sun = sun;
    check(/K$/.test(sun.rows['Effective temperature']), 'Sun reports an effective temperature');
    check(/L☉$/.test(sun.rows.Luminosity), 'Sun reports luminosity in solar units');
    check(/M☉$/.test(sun.rows.Mass), 'Sun reports mass in solar units');
    check(/R☉/.test(sun.rows.Radius), 'Sun reports radius in solar units');
    check(sun.rows.Basis === 'MODELED', 'Sun evolution is labelled as modeled');

    // ---- A catalogue star: present fields shown, absent fields omitted ----
    const proxima = await visit('proxima', () => __G.focus === 'star:0');
    observed.proxima = proxima;
    check(/M☉$/.test(proxima.rows.Mass), 'Catalog star reports mass in solar units');
    check(/^4\.\d{2} ly$/.test(proxima.rows['Distance from the Sun']), 'Catalog star reports distance in light-years');
    for (const absent of ['Surface gravity', 'Orbital speed']) {
        check(!(absent in proxima.rows), `Catalog star does not invent ${absent.toLowerCase()}`);
    }

    // ---- No fact anywhere may be a non-number leaking into the UI ----
    for (const [name, snapshot] of Object.entries(observed)) {
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
        const value = (await facts()).rows['Viewing distance'];
        units.push({ name, ly, value });
        check(/\d\s(ly|kly|Mly)$/.test(value), `${name} viewing distance uses a light-year unit (${value})`);
        assert.doesNotMatch(value, /\d{13,}/, `${name} viewing distance printed raw kilometres (${value})`);
    }
    observed.viewingDistance = units;
    checks.push('Viewing distance never prints a raw kilometre figure at interstellar scale');

    assert.deepEqual(errors, [], 'no browser errors');
    checks.push('No browser errors');

    await mkdir(resolve('docs/exploration-ui'), { recursive: true });
    await writeFile(resolve('docs/exploration-ui/facts-checks.json'),
        JSON.stringify({ checks, observed, errors }, null, 2));
    console.log(JSON.stringify({ checks, observed, errors }, null, 2));
} finally {
    await browser.close();
    await server.close();
}
