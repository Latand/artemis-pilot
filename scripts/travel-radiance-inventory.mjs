import assert from 'node:assert/strict';

export const foreignAttributes = Object.freeze({
  absMag: [1, 420, 'Float32Array'], color: [3, 420, 'Float32Array'],
  position: [3, 420, 'Float32Array'], radiusKm: [1, 420, 'Float32Array'], teffK: [1, 420, 'Float32Array'],
});

// Serialized into the existing read-only snapshot. All raw inventory remains
// in the report; no scene object, renderer property or frame is changed.
export function readTravelInventory(scene) {
  const objects = []; scene.traverse(object => { if (object.name === 'persistent Andromeda stars') objects.push(object); });
  return { variant: window.__travelVariant, objects: objects.map(object => {
    let geometryUsers = 0, materialUsers = 0;
    scene.traverse(other => {
      if (other.geometry === object.geometry) geometryUsers++;
      if ([other.material].flat().includes(object.material)) materialUsers++;
    });
    return { uuid: object.uuid, geometryUuid: object.geometry?.uuid, materialUuid: object.material?.uuid,
      type: object.type, materialType: object.material?.type, visible: object.visible,
      drawRange: { ...object.geometry?.drawRange }, geometryUsers, materialUsers,
      attributes: Object.fromEntries(Object.entries(object.geometry?.attributes || {}).map(([name, a]) => [name, [a.itemSize, a.count, a.array.constructor.name]])) };
  }) };
}

export function validateTravelInventory(inventory, expectedVariant = inventory?.variant) {
  assert(['A', 'B'].includes(expectedVariant), 'Known measured variant required');
  assert.equal(inventory?.variant, expectedVariant);
  assert(Array.isArray(inventory.objects));
  assert.equal(inventory.objects.length, expectedVariant === 'A' ? 0 : 1, 'Only the declared foreign point layer may differ');
  if (expectedVariant === 'B') {
    const object = inventory.objects[0];
    for (const key of ['uuid', 'geometryUuid', 'materialUuid']) assert.match(object[key], /^[a-f0-9-]{36}$/);
    assert.equal(object.type, 'Points'); assert.equal(object.materialType, 'ShaderMaterial');
    assert.equal(object.visible, false, 'The foreign point layer must be hidden in each MW fixture');
    assert.deepEqual(object.drawRange, { start: 0, count: 0 }, 'No foreign draw work may be subtracted');
    assert.deepEqual(object.attributes, foreignAttributes, 'Exact fixed production buffer capacities required');
    assert.equal(object.geometryUsers, 1); assert.equal(object.materialUsers, 1);
  }
  return inventory.objects.length;
}

export function comparableTravelState(state) {
  const extra = validateTravelInventory(state.travelInventory);
  const { travelInventory, ...result } = state;
  // The added empty object owns precisely one CPU geometry/material. Keep GPU
  // memory/program counts, all active layers and every other field exact.
  result.sceneObjects = { ...state.sceneObjects };
  for (const key of ['objects', 'geometries', 'materials']) {
    assert(Number.isSafeInteger(result.sceneObjects[key]) && result.sceneObjects[key] >= extra);
    result.sceneObjects[key] -= extra;
  }
  return result;
}

export function validateStableTravelInventory(scenario) {
  for (const label of ['A', 'B']) {
    const states = [scenario.prepared[label], scenario.before[label], ...scenario.trials.flatMap(t => t.blocks.filter(b => b.label === label).map(b => b.after))];
    for (const state of states) {
      validateTravelInventory(state.travelInventory, label);
      assert.deepEqual(state.travelInventory, states[0].travelInventory, 'Foreign object identity and bounded allocation remain stable');
    }
  }
}
