// Read-only browser geometry and five-point hit testing. This helper never
// moves controls, changes simulation state, or drives the renderer.
export function landscapeQualityLayout() {
    const rect = el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
    const visibleHit = el => {
        const r=rect(el);
        if(r.width<=0||r.height<44||r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return false;
        return [[r.left+4,r.top+4],[r.right-4,r.top+4],[r.left+4,r.bottom-4],[r.right-4,r.bottom-4],[(r.left+r.right)/2,(r.top+r.bottom)/2]]
            .every(([x,y])=>el.contains(document.elementFromPoint(x,y)));
    };
    const quality=document.getElementById('renderQualityControls'),q=rect(quality);
    const panel=rect(document.getElementById('explorePanel')),dock=rect(document.getElementById('timeDock')),toolbar=rect(document.getElementById('exploreBar'));
    const owner=quality.open?document.getElementById('renderQualityMode'):quality.querySelector('summary');
    const hits={graphics:visibleHit(owner),settings:visibleHit(document.getElementById('tdMore')),paths:visibleHit(document.getElementById('motionPathsToggle'))};
    return {quality:q,panel,dock,toolbar,hits,open:quality.open,width:innerWidth,height:innerHeight,
        clear:q.left>=panel.right+9&&q.right<=innerWidth-9&&q.top>=toolbar.bottom+9&&q.bottom<=dock.top-9&&q.height>=44&&Object.values(hits).every(Boolean)};
}
