// Lagrangian neighbours are selected once, in the worker, from the first
// simulated disk frame. Their current separation describes local tidal
// stretching, not the camera direction or a cosmetic velocity streak.
export const DEBRIS_NEIGHBOURS = 6;
export function buildDebrisNeighbours(positions, nMW) {
    const n = positions.length / 3, graph = new Int32Array(n * DEBRIS_NEIGHBOURS).fill(-1);
    const grid = new Map(), cell = 3;
    const key = (x,y,z,g) => `${x},${y},${z},${g}`;
    for (let i=0;i<n;i++) {
        const k=key(Math.floor(positions[i*3]/cell),Math.floor(positions[i*3+1]/cell),Math.floor(positions[i*3+2]/cell),Number(i>=nMW));
        if(!grid.has(k))grid.set(k,[]);grid.get(k).push(i);
    }
    const best=new Float64Array(DEBRIS_NEIGHBOURS);
    for(let i=0;i<n;i++) {
        best.fill(Infinity);
        const x=positions[i*3],y=positions[i*3+1],z=positions[i*3+2],cx=Math.floor(x/cell),cy=Math.floor(y/cell),cz=Math.floor(z/cell),gal=Number(i>=nMW);
        for(let dz=-2;dz<=2;dz++)for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++) {
            const bucket=grid.get(key(cx+dx,cy+dy,cz+dz,gal));if(!bucket)continue;
            for(const j of bucket) {
                if(i===j)continue;
                const d=(positions[j*3]-x)**2+(positions[j*3+1]-y)**2+(positions[j*3+2]-z)**2;
                if(d>=best[DEBRIS_NEIGHBOURS-1])continue;
                let at=DEBRIS_NEIGHBOURS-1;
                while(at>0&&d<best[at-1]){best[at]=best[at-1];graph[i*DEBRIS_NEIGHBOURS+at]=graph[i*DEBRIS_NEIGHBOURS+at-1];at--;}
                best[at]=d;graph[i*DEBRIS_NEIGHBOURS+at]=j;
            }
        }
    }
    return graph;
}

export function sampleDebrisShapes(pos, ws, graph, out) {
    const n=ws.length/2;
    for(let i=0;i<n;i++) {
        const o=i*4;out[o]=1;out[o+1]=0;out[o+2]=0;out[o+3]=1;
        if(!graph||ws[i*2]<.004)continue;
        const x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2],radius=Math.max(.3,ws[i*2+1]*4),r2=radius*radius;
        let xx=0,yy=0,zz=0,xy=0,xz=0,yz=0,weight=0;
        for(let k=0;k<DEBRIS_NEIGHBOURS;k++) {
            const j=graph[i*DEBRIS_NEIGHBOURS+k];if(j<0)continue;
            const dx=pos[j*3]-x,dy=pos[j*3+1]-y,dz=pos[j*3+2]-z;
            const u=Math.max(0,1-(dx*dx+dy*dy+dz*dz)/r2),w=u*u;
            // Neighbours that have phase-mixed far away cease to determine
            // this kernel. The compact support goes smoothly to zero.
            xx+=w*dx*dx;yy+=w*dy*dy;zz+=w*dz*dz;xy+=w*dx*dy;xz+=w*dx*dz;yz+=w*dy*dz;weight+=w;
        }
        const trace=xx+yy+zz;if(trace<1e-12||weight<1e-5)continue;
        let ax=xx>=yy&&xx>=zz?1:0,ay=yy>xx&&yy>=zz?1:0,az=zz>xx&&zz>yy?1:0;
        for(let k=0;k<8;k++) {
            const vx=xx*ax+xy*ay+xz*az,vy=xy*ax+yy*ay+yz*az,vz=xz*ax+yz*ay+zz*az;
            const l=Math.hypot(vx,vy,vz);if(l<1e-12)break;ax=vx/l;ay=vy/l;az=vz/l;
        }
        const lambda=xx*ax*ax+yy*ay*ay+zz*az*az+2*(xy*ax*ay+xz*ax*az+yz*ay*az);
        const q=Math.min(2.5,Math.sqrt(lambda/Math.max(trace-lambda,trace*.02)));
        const support=Math.min(1,weight/4);
        out[o]=ax;out[o+1]=ay;out[o+2]=az;out[o+3]=1+Math.max(0,q-1)*support*support;
    }
    return out;
}
