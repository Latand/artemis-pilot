import './compactExplorer.css';

let initialized = false;
// Use the existing controls and labels; compact mode does not create a
// second time controller, navigator, or copy of the selected object's facts.
export function initCompactExplorer({ stopMovement = () => {} } = {}) {
    if (initialized) return;
    initialized = true;
    const $ = id => document.getElementById(id);
    const panel = $('explorePanel'), dock = $('timeDock'), camera = $('exploreCamera');
    if (!panel || !dock || !camera) return;
    const button = (id, label, target) => {
        const b = document.createElement('button'); b.id = id; b.type = 'button'; b.textContent = label;
        b.className = 'compactToggle'; b.setAttribute('aria-controls', target); b.setAttribute('aria-expanded', 'false');
        return b;
    };
    const header = document.createElement('div'); header.className = 'compactObjectHeader';
    const title = document.createElement('div'); title.className = 'compactObjectTitle';
    for (const node of [panel.querySelector('.exploreEyebrow'), $('exploreObject'), $('exploreKind')]) if (node) title.append(node);
    const content = document.createElement('div'); content.id = 'explorePanelBody';
    while (panel.firstChild) content.append(panel.firstChild);
    const details = button('explorePanelToggle', 'Details', content.id);
    const move = button('exploreMoveToggle', 'Move', camera.id);
    header.append(title, details, move); panel.append(header, content);
    const time = document.createElement('div'); time.id = 'tdOptions';
    for (const node of [dock.querySelector('.tdSpeedRow'), dock.querySelector('.tdFine')]) if (node) time.append(node);
    dock.append(time);
    const more = button('tdMore', 'Settings', time.id);
    dock.querySelector('.tdHeading').append(more);
    const media = matchMedia('(max-width:760px), (max-height:540px) and (pointer:coarse)');
    let compact = media.matches, detailOpen = false, timeOpen = false, moveOpen = false;
    const setCss = (key, value) => { if (document.documentElement.style.getPropertyValue(key) !== value) document.documentElement.style.setProperty(key, value); };
    const measure = () => {
        const vv = window.visualViewport;
        setCss('--explore-visible-height', `${Math.round(vv?.height || innerHeight)}px`);
        setCss('--explore-viewport-top', `${Math.round(vv?.offsetTop || 0)}px`);
        setCss('--explore-toolbar-bottom', `${Math.ceil($('exploreBar').getBoundingClientRect().bottom)}px`);
        const h = Math.ceil(dock.getBoundingClientRect().height);
        if (h > 0) setCss('--time-dock-height', `${h}px`);
    };
    const render = () => {
        document.body.classList.toggle('compact-explorer', compact);
        document.body.classList.toggle('compact-moving', compact && moveOpen);
        panel.classList.toggle('expanded', compact && detailOpen);
        content.hidden = compact && !detailOpen; time.hidden = compact && !timeOpen;
        // CSS hides controls outside Explore/cabin/XR; never overwrite the
        // mode controller's visibility with inline display styles.
        details.setAttribute('aria-expanded', String(detailOpen)); details.textContent = detailOpen ? 'Close' : 'Details';
        more.setAttribute('aria-expanded', String(timeOpen)); more.textContent = timeOpen ? 'Close' : 'Settings';
        move.setAttribute('aria-expanded', String(moveOpen));
        measure();
    };
    details.addEventListener('click', () => { detailOpen = !detailOpen; timeOpen = false; moveOpen = false; stopMovement(); render(); });
    more.addEventListener('click', () => { timeOpen = !timeOpen; detailOpen = false; moveOpen = false; stopMovement(); render(); });
    move.addEventListener('click', () => { moveOpen = !moveOpen; detailOpen = false; timeOpen = false; stopMovement(); render(); });
    const collapse = () => { detailOpen = timeOpen = moveOpen = false; stopMovement(); render(); };
    for (const id of ['exploreSearch', 'exploreEvents', 'exploreHelp']) $(id)?.addEventListener('click', collapse);
    document.querySelectorAll('[data-ui-mode], [data-destination]').forEach(b => b.addEventListener('click', collapse));
    document.addEventListener('keydown', e => {
        if (!compact || e.key !== 'Escape' || !(detailOpen || timeOpen || moveOpen)) return;
        const owner = detailOpen ? details : timeOpen ? more : move;
        collapse(); owner.focus();
    });
    media.addEventListener('change', () => { compact = media.matches; collapse(); });
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure); observer.observe($('exploreBar')); observer.observe(dock);
    render();
}
