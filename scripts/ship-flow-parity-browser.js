// Vite resolves this static package import before the browser runs the test.
import * as THREE from 'three';
export async function verifyShipFlowParity() {
  const {renderer}=await import('/src/scene.js');
  const {FLOW_GLSL}=await import('/src/river.js');const {sampleWarpRiverFlow}=await import('/src/warpRiver.js');
  const {shipFlowFixtures,shipFlowUniforms}=await import('/scripts/ship-flow-fixtures.mjs');
  const target=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,depthBuffer:false,stencilBuffer:false});
  const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1),geometry=new THREE.PlaneGeometry(2,2),out=new Float32Array(4),cpu=new THREE.Vector3();
  const results=[];const prev=renderer.getRenderTarget();
  const material=new THREE.ShaderMaterial({uniforms:{},vertexShader:'void main(){gl_Position=vec4(position,1.0);}',fragmentShader:FLOW_GLSL+'\nuniform vec3 uWarpShip;void main(){gl_FragColor=vec4(flowField(uWarpShip),1.0);}',depthTest:false,depthWrite:false});
  scene.add(new THREE.Mesh(geometry,material));
  try {
   for(const fixture of shipFlowFixtures()){
    const u=shipFlowUniforms(fixture,THREE.Vector3,THREE.Vector4);
    const max=Number(FLOW_GLSL.match(/uBody\[(\d+)\]/)[1]);
    while(u.uBody.value.length<max){u.uBody.value.push(new THREE.Vector4());u.uSink.value.push(0);u.uHole.value.push(0);}
    Object.assign(material.uniforms,u);material.uniformsNeedUpdate=true;
    renderer.setRenderTarget(target);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,1,1,out);sampleWarpRiverFlow(u,cpu);
    const values=cpu.toArray();const error=Math.max(...values.map((v,i)=>Math.abs(v-out[i])/Math.max(1,Math.abs(v))));results.push({name:fixture.name,cpu:values,gpu:Array.from(out).slice(0,3),error});
   }
   return results;
  } finally {renderer.setRenderTarget(prev);geometry.dispose();target.dispose();material.dispose();}
}
