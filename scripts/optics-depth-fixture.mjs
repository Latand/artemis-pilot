// Actual production fragment with controlled colour/depth attachments. This
// isolates resolved-AA coverage and is supplementary to full-app screenshots.
export async function verifyDepthCoverageFixture(page) {
    return page.evaluate(() => {
        const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
        const gl=canvas.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true});
        if(!gl)throw new Error('Depth fixture requires WebGL2');
        const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
        const vertex=shader(gl.VERTEX_SHADER,'#version 300 es\nprecision highp float;in vec2 position;out vec2 vUv;void main(){vUv=position*.5+.5;gl_Position=vec4(position,0.,1.);}');
        const fragment=shader(gl.FRAGMENT_SHADER,'#version 300 es\nprecision highp float;precision highp int;precision highp sampler2D;\n#define varying in\n#define texture2D texture\n#define gl_FragDepthEXT gl_FragDepth\nout vec4 colour;\n#define gl_FragColor colour\n'+window.qa.lens.lensingPass.material.fragmentShader);
        const program=gl.createProgram();gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
        if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
        const position=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        const location=name=>gl.getUniformLocation(program,name);
        const textures=[];
        const texture=(unit,internal,type,data)=>{const t=gl.createTexture();textures.push(t);gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,internal,256,256,0,gl.RGBA,type,data);return t;};
        for(const [name,value]of Object.entries({uNear:1,uFar:1e6,uAspect:1,'uDist[0]':100,'uT2[0]':.02,uRingOpacity:1}))gl.uniform1f(location(name),value);
        for(const [name,value]of Object.entries({uHasDepth:1,uN:1,uRingPresent:1,tDiffuse:0,tDepth:1,uRingMap:2}))gl.uniform1i(location(name),value);
        gl.uniform2f(location('uC[0]'),0,0);gl.uniform2f(location('uRingRadii'),5,7);gl.uniform2f(location('uRingProjection'),1,1);gl.uniform2f(location('uRingBodyDepth'),110,2.75);
        gl.uniform4f(location('uRingBodyBounds'),(16.5-2.75)/112.75*.5+.5-3/256,-2.75/107.25*.5+.5-3/256,(16.5+2.75)/107.25*.5+.5+3/256,2.75/107.25*.5+.5+3/256);
        gl.uniformMatrix4fv(location('uViewToRing'),false,new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,-16.5,0,110,1]));
        gl.uniformMatrix3fv(location('uRingMapTransform'),false,new Float32Array([1,0,0,0,1,0,0,0,1]));
        texture(2,gl.RGBA8,gl.UNSIGNED_BYTE,new Uint8Array(256*256*4)); // a real zero-alpha ring gap
        const results=[],images={};
        for(const name of ['near-aa','ring-gap','foreground','unrelated-distant']){
            const colour=new Uint8Array(256*256*4),depth=new Float32Array(256*256*4).fill(1);
            const z=name==='near-aa'?110:name==='foreground'?50:1e5;
            const cx=name==='near-aa'||name==='foreground' ? .15 : name==='unrelated-distant' ? .5 : .19,r=.025*z;
            for(let y=0;y<256;y++)for(let x=0;x<256;x++){
                const px=(x+.5)/128-1,py=(y+.5)/128-1;
                const a=px*px+py*py+1,b=-cx*z*px-z,d=b*b-a*((cx*z)**2+z*z-r*r),i=(y*256+x)*4;
                colour[i+3]=255;
                if(d>=0){const t=(-b-Math.sqrt(d))/a;colour[i]=colour[i+2]=255;depth[i]=1e6*(t-1)/(t*(1e6-1));}
            }
            if(name==='near-aa')for(let y=1;y<255;y++)for(let x=1;x<255;x++){
                const i=(y*256+x)*4;
                if(colour[i]&&[-4,4,-256*4,256*4].some(d=>!colour[i+d])){depth[i]=1;colour[i]=colour[i+2]=230;}
            }
            texture(0,gl.RGBA8,gl.UNSIGNED_BYTE,colour);texture(1,gl.RGBA32F,gl.FLOAT,depth);
            const samples=[];
            for(const enabled of [false,true]){
                gl.uniform1f(location('uRingBodyRadius'),enabled?2.75:0);
                gl.drawArrays(gl.TRIANGLES,0,3);
                const pixels=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
                if(gl.getError()!==gl.NO_ERROR)throw new Error('Depth fixture GL error');
                let detached=0;for(let y=0;y<256;y++)for(let x=0;x<256;x++){const i=(y*256+x)*4;if((x+.5)/128-1>.21&&pixels[i]>200&&pixels[i+2]>200)detached++;}
                samples.push({enabled,detached,pixels});images[`${name}-${enabled?'on':'off'}`]=canvas.toDataURL('image/png');
            }
            const same=samples[0].pixels.every((x,i)=>x===samples[1].pixels[i]);
            if(name==='near-aa'&&!(samples[0].detached>0&&samples[1].detached===0))throw new Error('AA silhouette fixture did not eliminate detached edges');
            if(name!=='near-aa'&&!same)throw new Error(`Coverage lookup changed protected fixture: ${name}`);
            results.push({name,same,detachedOff:samples[0].detached,detachedOn:samples[1].detached});
        }
        textures.forEach(t=>gl.deleteTexture(t));gl.deleteBuffer(buffer);gl.deleteProgram(program);gl.deleteShader(vertex);gl.deleteShader(fragment);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return {scope:'Actual fragment with synthetic resolved-AA attachments; full-app compositor is tested separately',results,images};
    });
}
