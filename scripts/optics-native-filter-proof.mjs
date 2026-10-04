import assert from 'node:assert/strict';

// Pixel QA only. Observe the actual linked program and texture binding at one
// production lens draw, after Three has uploaded uniforms. Never used by the
// paired performance runner; no uniform, sampler or render-policy mutation.
export function installNativeLensProof() {
    const gl=qa.s.renderer.getContext();
    window.__opticsNativeProof=null;window.__opticsNativeProofAllowed=false;
    const originals={drawArrays:gl.drawArrays,drawElements:gl.drawElements};
    function inspect(){
        if(!window.__opticsNativeProofAllowed||window.__opticsNativeProof)return;
        const program=gl.getParameter(gl.CURRENT_PROGRAM);
        const ringLocation=gl.getUniformLocation(program,'uRingPresent');
        if(ringLocation===null||gl.getUniform(program,ringLocation)!==1)return;
        const shaders=gl.getAttachedShaders(program).map(shader=>({type:gl.getShaderParameter(shader,gl.SHADER_TYPE),
            compiled:gl.getShaderParameter(shader,gl.COMPILE_STATUS),source:gl.getShaderSource(shader),log:gl.getShaderInfoLog(shader)}));
        if(!shaders.some(shader=>shader.source.includes('lensGeometry[')))return;
        const sampler=gl.getUniformLocation(program,'uRingMap');
        if(sampler===null)throw new Error('Active ring sampling shader lacks its native sampler');
        const previous=gl.getParameter(gl.ACTIVE_TEXTURE),unit=gl.getUniform(program,sampler);
        let texture;
        try{
            gl.activeTexture(gl.TEXTURE0+unit);
            const anisotropic=gl.getExtension('EXT_texture_filter_anisotropic');
            texture={unit,bound:!!gl.getParameter(gl.TEXTURE_BINDING_2D),minFilter:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER),
                magFilter:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER),wrapS:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S),
                wrapT:gl.getTexParameter(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T),anisotropy:anisotropic?gl.getTexParameter(gl.TEXTURE_2D,anisotropic.TEXTURE_MAX_ANISOTROPY_EXT):null};
        }finally{gl.activeTexture(previous);}
        window.__opticsNativeProof={linked:gl.getProgramParameter(program,gl.LINK_STATUS),log:gl.getProgramInfoLog(program),
            ringPresent:gl.getUniform(program,ringLocation),lensCount:gl.getUniform(program,gl.getUniformLocation(program,'uN')),
            shaders,texture,contextLost:gl.isContextLost(),glError:gl.getError()};
    }
    for(const name of Object.keys(originals))gl[name]=function(...args){inspect();return originals[name].apply(gl,args);};
    window.__finishOpticsNativeProof=()=>{for(const name of Object.keys(originals))gl[name]=originals[name];return window.__opticsNativeProof;};
}

export function validateNativeLensProof(proof){
    assert(proof,'A production lens draw with ring sampling must be observed');
    assert.equal(proof.contextLost,false);assert.equal(proof.glError,0);assert.equal(proof.linked,true);
    assert.equal(proof.ringPresent,1);assert(proof.lensCount>0);
    assert(proof.shaders.length>=2&&proof.shaders.every(shader=>shader.compiled));
    assert(proof.shaders.some(shader=>shader.source.includes('lensGeometry[')&&shader.source.includes('iteration < 3')));
    assert.equal(proof.texture.bound,true);
    assert.equal(proof.texture.minFilter,9987,'Native trilinear mipmap filter');
    assert.equal(proof.texture.magFilter,9729,'Native linear magnification');
    assert.equal(proof.texture.wrapS,10497);assert.equal(proof.texture.wrapT,33071);
    assert.equal(proof.texture.anisotropy,4,'Native ring anisotropy retained');
}
