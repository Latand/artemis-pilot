import * as THREE from 'three';
import { bodyBoundsHooksSafe } from './bodyBoundsHooks.js';

// A draw-only precision aid. Geometry remains the physical six-kilometre
// shell. Never guess a world-distance bound for polygonOffsetUnits: drivers
// can map a nominal unit to more than one fixed-point depth code.
export const CLOUD_DEPTH_GUARD_MAX_ITEMS = 256;
const groundForCloud = new WeakMap();
export function registerEarthCloudGround(cloud, ground) { groundForCloud.set(cloud, ground); }
function uniformSphereTransform(matrix) {
    const e = matrix?.elements;
    if (!e) return false;
    const xx = e[0] ** 2 + e[1] ** 2 + e[2] ** 2, yy = e[4] ** 2 + e[5] ** 2 + e[6] ** 2, zz = e[8] ** 2 + e[9] ** 2 + e[10] ** 2;
    const tolerance = Math.max(xx, yy, zz) * 1e-6;
    return xx > 0 && yy > 0 && zz > 0 && Math.abs(xx - yy) <= tolerance && Math.abs(xx - zz) <= tolerance &&
        Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]) <= tolerance &&
        Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]) <= tolerance &&
        Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]) <= tolerance;
}

export function createCloudDepthGuard() {
    const cloudSphere = new THREE.Sphere(), otherSphere = new THREE.Sphere(), groundSphere = new THREE.Sphere();
    const eye = new THREE.Vector3(), cloudRay = new THREE.Vector3(), otherRay = new THREE.Vector3(), viewCenter = new THREE.Vector3();
    const state = { enabled: false, reason: 'not-rendered', checked: 0, blockedBy: null, blockedObjectId: null };
    function stop(reason, object) {
        state.enabled = false; state.reason = reason; state.blockedBy = object?.name || object?.type || null;
        state.blockedObjectId = object?.id ?? null;
        return false;
    }
    function bounds(object, geometry, target, exactSphere = false) {
        // Instanced and skinned meshes need their aggregate/deformed object
        // bounds, never the untransformed source geometry's small sphere.
        const sphere = object.isInstancedMesh || object.isSkinnedMesh ? object.boundingSphere : geometry?.boundingSphere;
        if (!sphere || !object.matrixWorld) return false;
        target.copy(sphere).applyMatrix4(object.matrixWorld);
        if (!exactSphere) {
            // Frobenius norm bounds the largest singular value even when a
            // scaled parent and rotated child introduce shear. Column maxima
            // alone can underbound those ordinary scene transforms.
            const e = object.matrixWorld.elements;
            target.radius = sphere.radius * Math.hypot(e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]);
        }
        return Number.isFinite(target.radius) && target.radius >= 0 && Number.isFinite(target.center.x) &&
            Number.isFinite(target.center.y) && Number.isFinite(target.center.z);
    }
    function evaluate(camera, cloud, ground, lists, relativisticBeta = 0, drawDeformationPossible = false) {
        state.checked = 0; state.blockedBy = null; state.blockedObjectId = null;
        if (!camera?.isPerspectiveCamera || relativisticBeta !== 0) return stop('unsupported-projection');
        if (drawDeformationPossible) return stop('draw-deformation-context');
        if (!ground || !bounds(cloud, cloud.geometry, cloudSphere, true) || !bounds(ground, ground.geometry, groundSphere, true)) return stop('missing-ground-or-cloud-bounds');
        if (!uniformSphereTransform(cloud.matrixWorld) || !uniformSphereTransform(ground.matrixWorld) ||
            cloudSphere.center.distanceToSquared(groundSphere.center) > 1e-12 || cloudSphere.radius <= groundSphere.radius) return stop('deformed-cloud-or-ground');
        if (!lists || !Array.isArray(lists.opaque) || !Array.isArray(lists.transmissive) || !Array.isArray(lists.transparent)) return stop('missing-draw-list');
        if (lists.opaque.length + lists.transmissive.length + lists.transparent.length > CLOUD_DEPTH_GUARD_MAX_ITEMS) return stop('draw-list-budget');
        let cloudListed = false;
        for (let i = 0; i < lists.transparent.length; i++) if (lists.transparent[i].object === cloud) { cloudListed = true; break; }
        if (!cloudListed) return stop('cloud-not-in-draw-list');
        eye.setFromMatrixPosition(camera.matrixWorld);
        cloudRay.subVectors(cloudSphere.center, eye);
        const distance = cloudRay.length();
        if (!(distance > cloudSphere.radius)) return stop('inside-cloud-shell');
        cloudRay.divideScalar(distance);
        const cloudAngle = Math.asin(Math.min(1, cloudSphere.radius / distance));
        const cloudDepth = -viewCenter.copy(cloudSphere.center).applyMatrix4(camera.matrixWorldInverse).z;
        if (!(cloudDepth > 0)) return stop('cloud-behind-camera');
        for (let category = 0; category < 3; category++) {
          const list = category === 0 ? lists.opaque : category === 1 ? lists.transmissive : lists.transparent;
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const object = item.object, material = item.material;
            if (object === cloud || object === ground || !material?.visible || !material.depthWrite || !material.depthTest) continue;
            state.checked++;
            if (!object.isMesh) return stop('unknown-expanded-primitive', object);
            if (material.polygonOffset || (material.depthFunc !== THREE.LessEqualDepth && material.depthFunc !== THREE.LessDepth)) return stop('unknown-occluder-depth-policy', object);
            if (!bodyBoundsHooksSafe(material)) return stop('unknown-material-hook', object);
            // Dynamic aggregate/deformed bounds may lag the draw. Do not infer
            // freshness or silently recompute them in a material callback.
            // TDE's known hook is harmless only while the caller guarantees no
            // placed black holes; other custom draw-time transforms fail closed.
            if (object.isSkinnedMesh || object.isInstancedMesh || object.isBatchedMesh || material.displacementMap ||
                material.isShaderMaterial || item.geometry?.morphAttributes?.position?.length || item.geometry?.attributes?.position?.version !== 0 ||
                (object.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender && !object.userData.tdeHooked)) return stop('unknown-deformation', object);
            if (!bounds(object, item.geometry, otherSphere)) return stop('unknown-occluder-bounds', object);
            // Anything wholly inside the ideal ground sphere is necessarily
            // behind the enclosing cloud mesh, not a foreground occluder.
            if (otherSphere.center.distanceTo(groundSphere.center) + otherSphere.radius <= groundSphere.radius) continue;
            const depth = -viewCenter.copy(otherSphere.center).applyMatrix4(camera.matrixWorldInverse).z;
            // Use the entire cloud depth extent, including grazing facets;
            // only geometry wholly behind that sphere is certainly background.
            // All possibly foreground distances remain guarded.
            if (depth - otherSphere.radius > cloudDepth + cloudSphere.radius || depth + otherSphere.radius <= 0) continue;
            otherRay.subVectors(otherSphere.center, eye);
            const otherDistance = otherRay.length();
            if (!(otherDistance > otherSphere.radius)) return stop('foreground-overlap', object);
            otherRay.divideScalar(otherDistance);
            const otherAngle = Math.asin(Math.min(1, otherSphere.radius / otherDistance));
            if (cloudRay.dot(otherRay) >= Math.cos(Math.min(Math.PI, cloudAngle + otherAngle + 1e-6))) return stop('foreground-overlap', object);
          }
        }
        state.enabled = true; state.reason = 'clear-cloud-footprint';
        return true;
    }
    return { evaluate, state };
}

export function installEarthCloudDepthGuard(material, betaUniform, drawDeformationPossible = () => false) {
    const guard = createCloudDepthGuard(), previous = material.onBeforeRender;
    material.userData.cloudDepthGuard = guard.state;
    // Bias defaults off, including unregistered fixtures and unknown renderers.
    material.polygonOffset = false;
    material.onBeforeRender = function(renderer, scene, camera, geometry, cloud, group) {
        previous?.call(this, renderer, scene, camera, geometry, cloud, group);
        // Three r164 builds this list before material.onBeforeRender. Reuse it;
        // never traverse the entire scene or compute large missing bounds here.
        const lists = renderer.renderLists?.get?.(scene, 0);
        material.polygonOffset = guard.evaluate(camera, cloud, groundForCloud.get(cloud), lists, betaUniform.value, drawDeformationPossible());
    };
    return material;
}
