// Read-only inventory, serialized by Playwright into the real application.
export function captureExploredWarmResources() {
    const q=window.exploredQA, {renderer,scene}=q.s, textures=new Map(), materials=new Set();
    scene.traverse(object=>{
        for(const material of (Array.isArray(object.material)?object.material:[object.material]).filter(Boolean)) {
            materials.add(material.uuid);
            const bindings=[...Object.values(material),...Object.values(material.uniforms||{}).map(u=>u.value)];
            for(const texture of bindings)if(texture?.isTexture&&!textures.has(texture.uuid))textures.set(texture.uuid,{
                id:texture.uuid,source:texture.source?.uuid,width:texture.image?.width,height:texture.image?.height,
                initialized:!!renderer.properties.get(texture).__webglTexture,
            });
        }
    });
    const label=q.body.systemBodyRenderState()[1].label;
    return {gpu:{...renderer.info.memory},materials:[...materials].sort(),textures:[...textures.values()].sort((a,b)=>a.id.localeCompare(b.id)),
        p2Label:{object:label.uuid,material:label.material.uuid,texture:label.material.map.uuid},
        camera:{focus:q.state.G.focus,distance:q.s.cam.dist,target:q.s.cam.tgt.toArray()}};
}

export function gpuResourcesDoNotGrow(current, baseline) {
    return current.geometries<=baseline.geometries&&current.textures<=baseline.textures;
}

export function inspectExploredWarmTransition(before,after) {
    const failures=[], same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
    const identity=state=>state.textures.map(({initialized,...texture})=>texture);
    if(!same(before.materials,after.materials))failures.push('Material identity changed during first use');
    if(!same(identity(before),identity(after)))failures.push('Texture UUID/source/dimensions changed during first use');
    if(!same(before.p2Label,after.p2Label))failures.push('Known P2 label binding changed');
    const labelBefore=before.textures.find(t=>t.id===before.p2Label.texture),labelAfter=after.textures.find(t=>t.id===before.p2Label.texture);
    if(!labelBefore||labelBefore.width!==256||labelBefore.height!==64||!labelBefore.source)failures.push('Known existing P2 label texture is missing or changed');
    if(!labelAfter?.initialized)failures.push('P2 label was not GPU initialized before the repeat baseline');
    const old=new Map(before.textures.map(t=>[t.id,t]));
    const uploaded=after.textures.filter(t=>t.initialized&&!old.get(t.id)?.initialized).map(t=>t.id);
    const expected=labelBefore&&!labelBefore.initialized?[labelBefore.id]:[];
    if(!same(uploaded,expected))failures.push('Unexpected first-use upload outside the known P2 label');
    if(before.textures.some(t=>t.initialized&&!after.textures.find(a=>a.id===t.id)?.initialized))failures.push('Previously initialized texture disappeared');
    if(after.gpu.textures-before.gpu.textures!==uploaded.length)failures.push('GPU allocation count is not explained by observed known uploads');
    if(after.gpu.geometries>before.gpu.geometries)failures.push('Unexpected first-use geometry allocation');
    return {passed:failures.length===0,failures,uploaded,expected,allocationDelta:after.gpu.textures-before.gpu.textures};
}
