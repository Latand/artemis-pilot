import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// Art direction only: a speculative twin-ring explorer, not a warp-drive model.
// Local +Y is the nose, exactly as expected by the existing flight renderer.
// Keep its tail close to -1.05 so the existing thrust marker remains attached.
export function createShipModel() {
    const craft = new THREE.Group();
    craft.name = "Artemis twin-ring explorer";
    const materials = {
        ceramic: new THREE.MeshPhongMaterial({ color: 0xd9e4e8, emissive: 0x1a232b, shininess: 75, specular: 0x607885 }),
        silver: new THREE.MeshPhongMaterial({ color: 0x718897, emissive: 0x101921, shininess: 85, specular: 0x9dafb7 }),
        graphite: new THREE.MeshPhongMaterial({ color: 0x17232e, emissive: 0x050a0e, shininess: 45, specular: 0x536b7c }),
        copper: new THREE.MeshPhongMaterial({ color: 0xb2744d, emissive: 0x21140c, shininess: 70, specular: 0xb39577 }),
        glass: new THREE.MeshPhongMaterial({ color: 0x082938, emissive: 0x051a24, shininess: 150, specular: 0xaee5ef }),
        cyan: new THREE.MeshBasicMaterial({ color: 0x67d7e8, toneMapped: false }),
        windows: new THREE.MeshBasicMaterial({ color: 0xf4d9a0, toneMapped: false }),
    };
    const parts = new Map(Object.keys(materials).map(key => [key, []]));
    const put = (key, geometry, x = 0, y = 0, z = 0) => {
        geometry.translate(x, y, z);
        parts.get(key).push(geometry);
    };
    const lathe = (profile, segments = 48) => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
    const tube = (radius, depth, thickness = .018) => lathe([
        [radius - thickness, -depth / 2], [radius, -depth / 2],
        [radius, depth / 2], [radius - thickness, depth / 2], [radius - thickness, -depth / 2],
    ]);
    const beam = (key, a, b, width, depth = width) => {
        const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
        const delta = to.clone().sub(from);
        const geometry = new THREE.BoxGeometry(width, delta.length(), depth);
        geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
        const mid = from.add(to).multiplyScalar(.5);
        put(key, geometry, mid.x, mid.y, mid.z);
    };

    // Continuous pressure hull with a broad, low command deck at the bow.
    const spine = lathe([[0, -.91], [.22, -.89], [.25, -.7], [.22, .55], [.17, 1.03], [0, 1.34]], 32);
    spine.scale(1, 1, .76);
    put("silver", spine);
    const command = new THREE.SphereGeometry(1, 32, 16);
    command.scale(.31, .58, .155);
    put("ceramic", command, 0, .86, .035);
    const canopy = new THREE.SphereGeometry(1, 24, 12);
    canopy.scale(.19, .32, .092);
    put("glass", canopy, 0, 1.0, .155);
    // Canopy spine and warm cabin portholes stay readable without bloom.
    beam("ceramic", [0, .76, .24], [0, 1.26, .19], .022, .026);
    for (const side of [-1, 1]) {
        for (let i = 0; i < 5; i++) {
            const y = -.26 + i * .13, z = .07;
            const radius = .25 - (y + .7) * .03 / 1.25;
            const x = Math.sqrt(radius * radius - (z / .76) ** 2) + .004;
            put("windows", new THREE.BoxGeometry(.018, .046, .021), side * x, y, z);
        }
        beam("graphite", [side * .17, -.81, .13], [side * .17, .56, .13], .042, .035);
    }

    // Two deep, chamfered annuli. Four radial pylons and four axial spars
    // make the rings a connected structure rather than floating ornaments.
    const ringProfile = [[.82, -.13], [.99, -.13], [1.065, -.065], [1.065, .065], [.99, .13], [.82, .13], [.79, .09], [.79, -.09], [.82, -.13]];
    for (const y of [-.61, .48]) {
        put("ceramic", lathe(ringProfile, 64), 0, y);
        put("graphite", tube(1.068, .056, .018), 0, y);
        put("copper", tube(1.07, .018, .018), 0, y - .043);
        put("graphite", tube(.798, .125, .025), 0, y);
        // Small separated segments in the inner channel, never a lens/shader.
        for (let i = 0; i < 16; i++) {
            const arc = new THREE.TorusGeometry(.763, .013, 4, 5, Math.PI * 2 / 16 * .68);
            arc.rotateZ(i * Math.PI * 2 / 16);
            arc.rotateX(Math.PI / 2);
            put("cyan", arc, 0, y);
        }
        for (let i = 0; i < 4; i++) {
            const angle = Math.PI / 4 + i * Math.PI / 2;
            const x = Math.cos(angle), z = Math.sin(angle);
            beam("silver", [x * .17, y - .04, z * .15], [x * .82, y, z * .82], .11, .07);
            // Recessed panel breaks on the outside edge.
            const panel = new THREE.BoxGeometry(.11, .08, .018);
            panel.rotateY(Math.PI / 2 - angle);
            put("graphite", panel, x * 1.063, y, z * 1.063);
        }
    }
    for (let i = 0; i < 4; i++) {
        const angle = Math.PI / 4 + i * Math.PI / 2;
        const x = Math.cos(angle) * .91, z = Math.sin(angle) * .91;
        beam("graphite", [x, -.61, z], [x, .48, z], .075, .075);
        beam("silver", [x * 1.025, -.55, z * 1.025], [x * 1.025, .42, z * 1.025], .028, .035);
    }
    // Compact conventional drive termination, using the existing exhaust.
    put("graphite", lathe([[.14, -.99], [.25, -.99], [.29, -.88], [.24, -.76], [.14, -.76], [.14, -.99]], 32));
    put("copper", tube(.263, .045, .035), 0, -.945);
    put("cyan", new THREE.CircleGeometry(.137, 24).rotateX(Math.PI / 2), 0, -.995);

    // Bake by material: seven draw calls, no textures, lights, per-frame
    // allocations, or resource growth when changing camera scale or mode.
    for (const [name, geometries] of parts) {
        const geometry = mergeGeometries(geometries);
        for (const part of geometries) part.dispose();
        geometry.computeBoundingSphere();
        const mesh = new THREE.Mesh(geometry, materials[name]);
        mesh.name = `ship.${name}`;
        craft.add(mesh);
    }
    craft.userData.design = "speculative-twin-ring";
    return craft;
}
