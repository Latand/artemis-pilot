import * as THREE from 'three';
import { bubbleMetric } from './warpBubble.js';
// Metric-derived colors on a bounded display grid. One Eulerian-flow snapshot
// y' = y + a(f-1): flat cabin, contracting front, expanding rear. Not a spatial
// embedding (Alcubierre spatial slices are flat), ray tracing or a GW solution.
export function createWarpMetricField() {
    const p=[],m=[];
    const point=(x,y,z)=>{const s=bubbleMetric(x,y,z);p.push(x,y,z);m.push(s.f,s.expansion,s.energy);};
    // Sparse longitudinal and latitude cross-sections through the wall.
    for(let i=0;i<16;i++) for(let j=0;j<64;j++) for(const k of [j,j+1]) {
        const a=i*Math.PI*2/16,t=k*Math.PI*2/64;
        const r=i%2?1:.84;point(r*Math.sin(t)*Math.cos(a),r*Math.cos(t),r*Math.sin(t)*Math.sin(a));
    }
    for(let j=-8;j<=8;j++) for(let i=0;i<64;i++) for(const k of [i,i+1]) {
        const y=j/9,r=Math.sqrt(1-y*y),a=k*Math.PI*2/64;
        point(r*Math.cos(a),y,r*Math.sin(a));
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
    geometry.setAttribute('metric',new THREE.Float32BufferAttribute(m,3));
    const material=new THREE.ShaderMaterial({
        uniforms:{level:{value:0}},transparent:true,depthWrite:false,depthTest:true,toneMapped:false,
        blending:THREE.NormalBlending,
        vertexShader:`attribute vec3 metric; uniform float level; varying vec3 ink; varying float alpha;
        void main(){
            vec3 p=position;
            p.y+=.28*level*(metric.x-1.0);
            float contraction=clamp(-metric.y/2.5,0.0,1.0);
            float expansion=clamp(metric.y/2.5,0.0,1.0);
            float exotic=clamp(-metric.z*32.0*3.14159265/6.25,0.0,1.0);
            ink=mix(vec3(.44,.27,.68),vec3(.15,.86,1.0),contraction);
            ink=mix(ink,vec3(1.0,.40,.70),expansion);
            alpha=level*(.18+.46*max(max(contraction,expansion),exotic*.6));
            gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);
        }`,fragmentShader:`varying vec3 ink; varying float alpha; void main(){gl_FragColor=vec4(ink,alpha);}`
    });
    const field=new THREE.LineSegments(geometry,material);
    field.name='Alcubierre expansion and exotic-energy guide';field.frustumCulled=false;field.visible=false;
    return field;
}
