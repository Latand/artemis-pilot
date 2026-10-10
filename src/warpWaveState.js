// Event markers for an explicitly illustrative radiation guide. No waveform,
// energy, amplitude or detector prediction is derived from the warp metric.
export const WARP_WAVES={enabled:false,events:[],phase:'off',speed:0,replay:null,replayAge:0,lastT:null};
export function resetWarpWaves(){Object.assign(WARP_WAVES,{enabled:false,events:[],phase:'off',speed:0,replay:null,replayAge:0,lastT:null});}
export function noteWarpTransition(phase,speed,x,y,z,t) {
    const s=WARP_WAVES;
    if(s.lastT!==null && t<s.lastT){s.events.length=0;s.replay=null;s.phase=phase;s.speed=speed;s.lastT=t;return;}
    s.lastT=t;
    const changed=phase!==s.phase;
    const collapse=s.speed>0&&speed===0;
    if(s.enabled && ((changed&&speed>0&&['ramping','braking'].includes(phase))||collapse)) {
        if(s.events.length===4)s.events.shift();
        s.events.push({x,y,z,t,kind:collapse?'collapse':phase});
    }
    s.phase=phase;s.speed=speed;
}
export function pulseAge(event,t){return Math.max(0,t-event.t);}
