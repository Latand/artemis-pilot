import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = file => readFileSync(path.join(root, file), "utf8");

const readme = read("README.md");
const html = read("index.html");
const packageJson = JSON.parse(read("package.json"));
const failures = [];
const assertionMessages = [];

function requireMatch(text, pattern, message) {
    assertionMessages.push(message);
    if (!pattern.test(text)) failures.push(message);
}

function rejectMatch(text, pattern, message) {
    assertionMessages.push(message);
    if (pattern.test(text)) failures.push(message);
}

function requireEqual(actual, expected, message) {
    assertionMessages.push(message);
    if (actual !== expected) failures.push(message);
}

function requireCondition(condition, message) {
    assertionMessages.push(message);
    if (!condition) failures.push(message);
}

function section(startMarker, endMarker, label) {
    const start = html.indexOf(startMarker);
    const end = html.indexOf(endMarker, start + startMarker.length);
    const message = `${label} section markers must remain present`;
    assertionMessages.push(message);
    if (start < 0 || end < 0) {
        failures.push(message);
        return "";
    }
    return html.slice(start, end);
}

function metaContent(key, value) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`<meta\\s+${key}="${escaped}"\\s+content="([^"]+)"\\s*/?>`, "i")
        .exec(html)?.[1];
}

function elementText(source, id) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markup = new RegExp(`<[^>]+\\bid="${escaped}"[^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i")
        .exec(source)?.[1] ?? "";
    return markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

const head = section("<head>", "</head>", "Head");
const help = section('<div id="help">', '<div id="hint">', "Help");
const intro = section('<div id="intro">', '<script>try', "Intro");
const introLore = elementText(intro, "introLore");
const brandedTitle = "Artemis — Live Universe Simulator";
const antithesisPattern = /\bnot\b.{0,80}\b(?:but|rather)\b|\bisn['’]t\b.{0,80}\b(?:but|it['’]s)\b|,\s*not\b|\bmore\s+[a-z-]+(?:\s+[a-z-]+){0,3}\s+than\s+[a-z-]+|\brather than\b/is;
const changedPublicProse = [readme, head, help, intro, packageJson.description ?? ""].join("\n");

rejectMatch(readme, /physics[- ]true/i,
    "README opening must avoid absolute accuracy language");
rejectMatch(intro, /physics[- ]true|REAL PHYSICS|Every date, orbit and cataclysm is computed/i,
    "intro must avoid universal accuracy language");
rejectMatch(readme, /bounded energy at any warp/i,
    "README must avoid a global energy guarantee");
rejectMatch(help, /RK4 world motion for Earth, Sun, Moon, planets/i,
    "Help must avoid assigning RK4 to Solar System bodies");
rejectMatch(intro + help, /—/,
    "Intro and Help prose must avoid em dashes");
rejectMatch(changedPublicProse, antithesisPattern,
    "changed public prose must avoid antithesis constructions");

requireEqual(elementText(intro, "introTitle"), "ARTEMIS",
    "intro identity must remain ARTEMIS");
requireEqual(/<title>([^<]+)<\/title>/i.exec(head)?.[1]?.trim(), brandedTitle,
    "document title must preserve the ARTEMIS brand identity");
requireEqual(metaContent("property", "og:title"), brandedTitle,
    "Open Graph title must preserve the ARTEMIS brand identity");
requireEqual(metaContent("name", "twitter:title"), brandedTitle,
    "Twitter title must preserve the ARTEMIS brand identity");
requireMatch(elementText(intro, "introSub"), /MODELED PHYSICS/i,
    "intro subtitle must identify modeled physics");
requireCondition((introLore.match(/[.!?](?=\s|$)/g) ?? []).length === 4,
    "intro lore must contain four sentences");
requireMatch(introLore, /press\s+H/i,
    "intro lore must point players to Help with the H key");

requireMatch(readme, /Solar System.{0,120}(?:KDK|velocity-Verlet)|(?:KDK|velocity-Verlet).{0,120}Solar System/is,
    "README must scope KDK or velocity-Verlet to Solar System ephemerides");
requireMatch(help, /Solar System.{0,120}(?:KDK|velocity-Verlet)|(?:KDK|velocity-Verlet).{0,120}Solar System/is,
    "Help must scope KDK or velocity-Verlet to Solar System ephemerides");
requireMatch(readme, /RK4.{0,120}ship.{0,120}placed[- ]hole/is,
    "README must identify ship RK4 inputs");
requireMatch(readme, /RK4.{0,100}ship.{0,180}Solar System.{0,120}player-placed-hole.{0,180}capped.{0,80}priority-ranked.{0,100}stellar/is,
    "README must scope the capped priority-ranked stellar subset to ship RK4");
requireMatch(help, /RK4.{0,100}ship.{0,180}Solar System.{0,120}player-placed holes.{0,180}capped.{0,80}priority-ranked.{0,100}stellar/is,
    "Help must scope the capped priority-ranked stellar subset to ship RK4");
requireMatch(readme, /RK4 path.{0,100}player-placed holes.{0,160}Solar System bodies.{0,120}gravitational debris.{0,120}other placed holes/is,
    "README must list player-placed-hole RK4 inputs");
requireMatch(help, /RK4 path.{0,100}player-placed holes.{0,160}Solar System bodies.{0,120}gravitational debris.{0,120}other placed holes/is,
    "Help must list player-placed-hole RK4 inputs");
rejectMatch(readme + help, /placed-hole RK4.{0,180}(?:active stars|stellar subset)|RK4 path.{0,180}(?:active stars|stellar subset)/is,
    "player-placed-hole RK4 must exclude the active-star subset");
requireMatch(readme, /analytic.{0,80}(?:osculating )?Kepler.{0,80}high warp/is,
    "README must disclose analytic Kepler handoffs at high warp");
requireMatch(help, /analytic.{0,80}(?:osculating )?Kepler.{0,80}high warp/is,
    "Help must disclose analytic Kepler handoffs at high warp");
requireMatch(intro, /press H|physics models/i,
    "intro must point players to model scope in Help");

requireMatch(readme, /Integrated dynamics/i,
    "Model scope must name integrated dynamics");
requireMatch(readme, /Analytic handoffs/i,
    "Model scope must name analytic handoffs");
requireMatch(readme, /Reduced-order (?:models|equations)/i,
    "Model scope must name reduced-order models");
requireMatch(readme, /Visual metaphors/i,
    "Model scope must name visual metaphors");
requireMatch(help, /reduced-order/i,
    "Help must disclose reduced-order deep-time transitions");
requireMatch(help, /spacetime river.{0,100}velocity-field visualization/is,
    "Help must identify the spacetime river as a velocity-field visualization");

requireMatch(readme, /general relativity.{0,160}(?:Sun-only 1PN|weak-field.{0,40}1PN).{0,120}pseudo-Newtonian/is,
    "README must state the general-relativity boundary");
requireMatch(readme, /collisions?.{0,160}hydrodynamics.{0,80}fragmentation/is,
    "README must state the collision, hydrodynamics, and fragmentation boundary");
requireMatch(readme, /Sun-only stellar evolution/i,
    "README must state the stellar-evolution boundary");
requireMatch(readme, /merger energy bookkeeping.{0,140}waveform.{0,80}strain propagation/is,
    "README must state the gravitational-wave boundary");
requireMatch(readme, /bounded local active gravity/i,
    "README must state the local active-gravity boundary");
requireMatch(readme, /absence of galaxy-wide N-body integration|no galaxy-wide N-body integration/i,
    "README must state the galaxy-wide integration boundary");
requireMatch(help, /Paczynski-Wiita|Paczyński.Wiita/i,
    "Help must identify the compact-object approximation");
requireMatch(help, /pseudo-Newtonian/i,
    "Help must classify Paczynski-Wiita as pseudo-Newtonian");
requireMatch(help, /limited.{0,40}1PN|1PN.{0,40}limited/is,
    "Help must disclose limited 1PN support");
requireMatch(readme, /player-placed holes.{0,100}Paczynski-Wiita.{0,100}pseudo-Newtonian/is,
    "README must scope Paczynski-Wiita to player-placed holes");
requireMatch(help, /player-placed holes.{0,100}(?:Paczynski-Wiita|Paczyński.Wiita).{0,100}pseudo-Newtonian/is,
    "Help must scope Paczynski-Wiita to player-placed holes");
requireMatch(readme, /catalog.{0,80}special-object black holes.{0,140}capped active-star Newtonian field/is,
    "README must place catalog and special-object black holes in the capped active-star Newtonian field");
requireMatch(help, /catalog.{0,80}special-object black holes.{0,140}capped active-star Newtonian field/is,
    "Help must place catalog and special-object black holes in the capped active-star Newtonian field");
rejectMatch(readme + help, /(?:all|every|near) compact objects?.{0,100}Paczynski-Wiita|pseudo-Newtonian compact objects/i,
    "Paczynski-Wiita claims must avoid global compact-object scope");

requireMatch(readme, /Milky Way.{0,180}Andromeda.{0,180}contingent deterministic scenario/is,
    "README must describe the Milky Way and Andromeda scenario as contingent");
requireMatch(readme, /NFW.{0,180}R2 physics review/is,
    "README must disclose the pending NFW R2 physics review");
requireMatch(readme, /bound(?:ed)?(?:-system)? handling.{0,180}suppress.{0,180}disk(?:-regime| regime)/is,
    "README must disclose NFW suppression in bound disk regimes");

const socialImage = "https://latand.github.io/artemis-pilot/social-preview.jpg";
requireEqual(metaContent("property", "og:image"), socialImage,
    "og:image must use the GitHub Pages subpath URL");
requireEqual(metaContent("name", "twitter:image"), socialImage,
    "twitter:image must use the GitHub Pages subpath URL");
requireCondition(existsSync(path.join(root, "public/social-preview.jpg")),
    "public social preview image must exist");

const socialDescriptions = [
    ["page", metaContent("name", "description") ?? ""],
    ["Open Graph", metaContent("property", "og:description") ?? ""],
    ["Twitter", metaContent("name", "twitter:description") ?? ""],
];
for (const [label, description] of socialDescriptions) {
    requireMatch(description, /fly.{0,40}Earth orbit/is,
        `${label} description must invite flight from Earth orbit`);
    requireMatch(description, /black holes?/i,
        `${label} description must name black-hole travel`);
    requireMatch(description, /billion years per second/i,
        `${label} description must state the deep-time control range`);
    requireMatch(description, /modeled universe/i,
        `${label} description must describe a modeled universe`);
}

requireMatch(help, /RMB drag.{0,140}free camera.{0,100}detached from any body/is,
    "Help must preserve detached free-camera meaning");
rejectMatch(html, /\bR2\b/i,
    "rendered player copy must exclude internal R2 terminology");

const viewport = metaContent("name", "viewport") ?? "";
requireMatch(viewport, /(?:^|,\s*)width=device-width(?:,|$)/i,
    "viewport must preserve width=device-width");
requireMatch(viewport, /(?:^|,\s*)initial-scale=1(?:,|$)/i,
    "viewport must preserve initial-scale=1");
requireMatch(viewport, /(?:^|,\s*)viewport-fit=cover(?:,|$)/i,
    "viewport must preserve viewport-fit=cover");
rejectMatch(viewport, /maximum-scale\s*=\s*1|user-scalable\s*=\s*no/i,
    "viewport must allow browser zoom");

requireMatch(packageJson.description ?? "", /layered live-universe simulator/i,
    "package description must describe a layered live-universe simulator");

rejectMatch(assertionMessages.join("\n"), antithesisPattern,
    "science-copy assertion messages must avoid antithesis constructions");

if (failures.length) {
    console.error(`science copy smoke failed (${failures.length})`);
    for (const failure of failures) console.error(`FAIL: ${failure}`);
    process.exit(1);
}

console.log("science copy smoke passed");
