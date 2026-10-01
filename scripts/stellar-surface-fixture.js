export async function runStellarSurfaceChecks() {
        const THREE = await import('/node_modules/three/build/three.module.js');
        const { photosphereMaterial } = await import('/src/render/planetAppearance.js');
        const { updatePhotosphereAppearance, linearStarColor } = await import('/src/render/stellarAppearance.js');
        const { teffToRGB } = await import('/src/render/viewBrightness.js');
        const { applyTerrellToMaterial } = await import('/src/relView.js');
        const { STARS } = await import('/src/constants.js');
        const { stellarSurfaceTemperature } = await import('/src/render/stellarSurfaceProfile.js');
        const { CURATED_PHOTOMETRY } = await import('/src/render/curatedPhotometry.js');
        const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setSize(768, 768); renderer.setClearColor(0x03050a);
        renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.12;
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(48, 1, .01, 1000);
        camera.position.set(0, 0, 3.35); camera.lookAt(0, 0, 0);
        const map = new THREE.DataTexture(new Uint8Array([255,140,15,255]),1,1); map.colorSpace = THREE.SRGBColorSpace; map.needsUpdate = true;
        const material = applyTerrellToMaterial(photosphereMaterial(0xffffff, map, { name: 'SUN', tempK: 5772, radiusSolar: 1 }));
        const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material); scene.add(mesh);
        const read = () => {
            renderer.render(scene, camera);
            const pixels = new Uint8Array(768 * 768 * 4);
            renderer.getContext().readPixels(0, 0, 768, 768, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixels);
            return pixels;
        };
        function stats(pixels) {
            let n = 0, clipped = 0; const color = [0,0,0];
            for (let y=304;y<464;y++) for(let x=304;x<464;x++) {
                const o = (y*768+x)*4;
                n++; for(let c=0;c<3;c++) color[c]+=pixels[o+c];
                if (Math.max(...pixels.slice(o,o+3)) >= 250) clipped++;
            }
            return { mean: color.map(c=>c/n), clippedFraction: clipped/n };
        }
        const sumDiff = (a,b) => { let d=0; for(let i=0;i<a.length;i+=4)d+=Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2]); return d; };
        const scenarios = [
            { name: 'SUN', tempK: 5772, radiusSolar: 1 },
            { name: 'PROXIMA', tempK: 3383, radiusSolar: .1542 },
            { name: 'SIRIUS A', tempK: 10014, radiusSolar: 1.71 },
            { name: 'BETELGEUSE', tempK: 3794, radiusSolar: 764 },
            { name: 'RIGEL', tempK: 10516, radiusSolar: 78.9 },
            { name: 'VAN MAANEN', tempK: 6154, radiusSolar: .011 },
        ];
        const findings = [];
        const rendered = [];
        for (const star of scenarios) {
            updatePhotosphereAppearance(material, star); linearStarColor(teffToRGB(star.tempK), material.color);
            const first = read(), second = read();
            const m = stats(first);
            if(sumDiff(first,second)!==0) findings.push(`${star.name}: frame noise`);
            if(m.clippedFraction > .001) findings.push(`${star.name}: overexposed surface`);
            const old=material.userData.photosphere.uniforms.uGranulation.value.clone();
            material.userData.photosphere.uniforms.uGranulation.value.y=0;
            material.userData.photosphere.uniforms.uGranulation.value.w=0;
            const flat=read();
            material.userData.photosphere.uniforms.uGranulation.value.copy(old);
            const detailDelta=sumDiff(first,flat);
            if(detailDelta<=0 && material.userData.photosphere.profile.family !== 'white-dwarf') findings.push(`${star.name}: missing modeled detail`);
            read();
            const fig = document.createElement('figure');
            const img = document.createElement('img');img.src=renderer.domElement.toDataURL();img.width=420;img.height=390;img.style.objectFit='contain';
            const label=document.createElement('figcaption');label.textContent=`${star.name} · ${star.tempK} K · ${material.userData.photosphere.profile.family}`;
            fig.append(img,label);document.querySelector('main').append(fig);
            rendered.push({name:star.name,...m,detailDelta});
        }
        // Every initial destination compiles and retains its own profile;
        // no per-star program variants or texture allocations are needed.
        for (const star of STARS.filter(s=>!s.bh)) {
            const options={...star,tempK:stellarSurfaceTemperature(star,CURATED_PHOTOMETRY[star.name])||5772};
            updatePhotosphereAppearance(material,options);linearStarColor(teffToRGB(options.tempK),material.color);read();
        }
        updatePhotosphereAppearance(material,{name:'SUN',tempK:5772,radiusSolar:1});linearStarColor(teffToRGB(5772),material.color);
        const seeded=read();updatePhotosphereAppearance(material,{name:'OTHER',tempK:5772,radiusSolar:1});const other=read();
        if(sumDiff(seeded,other)<1000)findings.push('different star identities produce the same image');
        camera.position.z=400;camera.updateMatrixWorld();
        const tiny=read();material.userData.photosphere.uniforms.uGranulation.value.y=0;material.userData.photosphere.uniforms.uGranulation.value.w=0;material.userData.photosphere.uniforms.uSpots.value.y=0;
        const tinyFlat=read(), tinyDifference=sumDiff(tiny,tinyFlat);
        if(tinyDifference>30)findings.push('unresolved surface detail aliases');
        camera.position.z=3.35;camera.updateMatrixWorld();
        updatePhotosphereAppearance(material,{name:'WISE 0855-0714',tempK:250,radiusSolar:.1});linearStarColor(teffToRGB(250),material.color);
        const cold=stats(read());if(cold.mean.some(c=>c>1))findings.push('250 K brown dwarf emits visible light');
        const programCount=renderer.info.programs.length;
        renderer.dispose();material.dispose();map.dispose();mesh.geometry.dispose();
        return {rendered,tinyDifference,cold,programCount,findings};

}
