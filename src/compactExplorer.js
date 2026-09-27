import './compactExplorer.css';
import { G, keys } from './state.js';
import { onModeChange } from './uiMode.js';
import { setCineOpen } from './cinematic.js';
import { bindNavigationStick } from './mobile/joystick.js';
import { cancelTouchInput, onInputCancel, renderSession, setMobileGraphics, recoverGraphics, reloadSafe } from './mobile/renderSession.js';

let initialized = false;
// Compact mode owns presentation, not a second clock, navigator or physics
// controller. All existing live controls keep their IDs and event handlers.
export function initCompactExplorer({ stopMovement = () => {} } = {}) {
    if (initialized) return;
    const $ = id => document.getElementById(id);
    const panel = $('explorePanel'), dock = $('timeDock'), camera = $('exploreCamera');
    if (!panel || !dock || !camera) return;
    // Mobile chrome owns touch/coarse-pointer layouts only. A narrow desktop
    // capture/window keeps the ordinary desktop controls and never creates
    // touch-only event owners or sheets.
    const touchLike = matchMedia('(pointer:coarse)').matches || (navigator.maxTouchPoints || 0) > 0;
    if (!touchLike) return;
    initialized = true;
    const button = (id, label, target, text = label) => {
        const b = document.createElement('button'); b.id = id; b.type = 'button'; b.textContent = text;
        b.className = 'compactToggle'; b.setAttribute('aria-label', label);
        if (target) { b.setAttribute('aria-controls', target); b.setAttribute('aria-expanded', 'false'); }
        return b;
    };
    const content = document.createElement('div'); content.id = 'explorePanelBody';
    while (panel.firstChild) content.append(panel.firstChild);
    panel.append(content);
    const time = document.createElement('div'); time.id = 'tdOptions';
    for (const node of [dock.querySelector('.tdSpeedRow'), dock.querySelector('.tdFine')]) if (node) time.append(node);
    dock.append(time);
    const more = button('tdMore', 'Time settings', 'tdOptions', '⋯'); dock.querySelector('.tdHeading').append(more);
    const bar = document.createElement('header'); bar.id = 'touchBar'; bar.setAttribute('aria-label', 'Mobile navigation');
    const menuButton = button('touchMenuToggle', 'Menu and experience mode', 'touchMenu', '☰');
    const details = button('explorePanelToggle', 'Object details', 'explorePanel', 'Earth');
    const search = button('touchSearch', 'Find a world', 'navPanel', '⌕');
    bar.append(menuButton, details, search);
    const backdrop = button('touchBackdrop', 'Close panel', null, ''); backdrop.tabIndex = -1; backdrop.hidden = true;
    const menu = document.createElement('section'); menu.id = 'touchMenu'; menu.hidden = true;
    menu.innerHTML = `<h2>Explore your universe</h2><div id="touchModeSlot"></div><div class="touchMenuGrid" id="touchActions"></div>
        <p class="touchHint">One finger: look around. Pinch: approach or retreat. Drag two fingers together: pan. Move opens a thumb pad; it never fires the ship’s engine in Explore.</p>
        <label class="touchQuality">Graphics <select id="touchGraphics"><option value="auto">Auto · bounded quality</option><option value="safe">Safe · lighter rendering</option></select></label>
        <div id="touchRecoveryActions" class="touchMenuGrid"></div><details id="touchFlightSystems"><summary>Flight systems</summary><div id="touchFlightSlot"></div></details>`;
    const move = button('exploreMoveToggle', 'Toggle thumb controls', 'touchFlightControls', 'Move');
    const events = button('touchEvents', 'Explore events', 'evPanel', 'Events');
    const home = button('touchHome', 'Return to Earth', null, 'Earth');
    const help = button('touchHelp', 'Controls and help', 'help', 'Help');
    const tour = button('touchTour', 'Camera tour tools', 'cinePanel', 'Camera tour');
    menu.querySelector('#touchActions').append(move, events, home, help, tour);
    const reset = button('touchGraphicsReset', 'Recover graphics without resetting simulation', null, 'Recover graphics');
    const reload = button('touchReloadSafe', 'Reload in Safe mode', null, 'Reload safe');
    const diagnostics = button('touchDiagnostics', 'Export graphics diagnostics', null, 'Diagnostics');
    const fullscreen = button('touchFullscreen', 'Toggle fullscreen', null, 'Fullscreen');
    menu.querySelector('#touchRecoveryActions').append(reset, reload, diagnostics, fullscreen);
    const controls = document.createElement('div'); controls.id = 'touchFlightControls';
    controls.innerHTML = `<div class="touchStickWrap"><button type="button" id="touchStick" aria-label="Move camera with thumb pad"><span></span></button><span id="touchStickLabel">MOVE VIEW</span></div><div id="touchLift"><button type="button" aria-label="Move camera up" data-touch-key="KeyE">↑</button><button type="button" aria-label="Move camera down" data-touch-key="KeyQ">↓</button></div><div id="touchPilotActions"></div><div id="touchThrottleSlot"></div>`;
    const status = document.createElement('aside'); status.id = 'renderRecovery'; status.hidden = true; status.setAttribute('role', 'status');
    const statusText = document.createElement('span'), statusButton = button('renderRecoveryReset', 'Recover graphics', null, 'Recover');
    const statusReload = button('renderRecoveryReload', 'Reload in Safe mode', null, 'Reload safe');
    status.append(statusText, statusButton, statusReload);
    // Keep compact chrome and legacy sheets in the same stacking context as the canvas/panels.\n    $('root').append(backdrop, menu, bar, controls, status);
    const media = matchMedia('(pointer:coarse) and (max-width:760px), (pointer:coarse) and (max-height:540px)');
    let compact = media.matches, opened = null, returnFocus = null, moveOpen = false, measureRaf = 0, nativeOpening = false;
    const roots = { details: panel, time: dock, menu, search: $('navPanel'), events: $('evPanel'), help: $('help'), catalog: $('hygSearch'), cinematic: $('cinePanel'), move: camera };
    const moved = [[$('exploreBar').querySelector('.exploreModes'), $('touchModeSlot')], [$('mThrottle'), $('touchThrottleSlot')], [$('mMenuGrid'), $('touchFlightSlot')], ...['mRcsL','mRcsR','mBoost'].map(id => [$(id), $('touchPilotActions')])]
        .filter(([node]) => node).map(([node, destination]) => {
            const marker = document.createComment('desktop control location'); node.before(marker); return { node, destination, marker };
        });
    const measure = () => {
        cancelAnimationFrame(measureRaf);
        measureRaf = requestAnimationFrame(() => {
            const vv = window.visualViewport;
            // Do not resize the WebGL canvas from visualViewport events. Its
            // zoom scale/keyboard movement belongs only to DOM positioning.
            const h = Math.round(vv?.height || innerHeight), top = Math.round(vv?.offsetTop || 0);
            const values = { '--explore-visible-height': `${h}px`, '--explore-viewport-top': `${top}px`, '--touch-keyboard-offset': `${Math.max(0, innerHeight - h - top)}px`, '--touch-bar-height': `${Math.ceil(bar.getBoundingClientRect().height)}px`, '--time-dock-height': `${Math.ceil(dock.getBoundingClientRect().height)}px` };
            for (const [name, value] of Object.entries(values)) if (document.documentElement.style.getPropertyValue(name) !== value) document.documentElement.style.setProperty(name, value);
        });
    };
    const updateTitle = () => {
        const name = G.uiMode === 'pilot' ? 'Pilot · Ship' : G.uiMode === 'direct' ? 'Create' : $('exploreObject').textContent;
        if (details.textContent !== name) details.textContent = name;
        details.setAttribute('aria-label', G.uiMode === 'observe' ? `Object details: ${name}` : 'Experience menu');
    };
    const render = () => {
        document.body.classList.toggle('compact-explorer', compact);
        document.body.classList.toggle('compact-moving', compact && moveOpen);
        document.body.classList.toggle('touch-sheet-open', compact && !!opened);
        for (const [name, root] of Object.entries(roots)) {
            root?.classList.toggle('touch-sheet-active', compact && opened === name);
            if (root && compact && opened === name) { root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); }
            else if (root) { root.removeAttribute('aria-modal'); if (root.getAttribute('role') === 'dialog') root.removeAttribute('role'); }
        }
        panel.classList.toggle('expanded', compact && opened === 'details');
        dock.classList.toggle('expanded-time', compact && opened === 'time');
        content.hidden = compact && opened !== 'details'; time.hidden = compact && opened !== 'time';
        menu.hidden = !compact || opened !== 'menu'; backdrop.hidden = !compact || !opened;
        for (const [trigger, name] of [[details, 'details'], [more, 'time'], [menuButton, 'menu'], [search, 'search']]) trigger.setAttribute('aria-expanded', String(opened === name));
        move.setAttribute('aria-expanded', String(moveOpen));
        $('touchFlightSystems').hidden = G.uiMode === 'observe';
        tour.hidden = G.uiMode !== 'direct';
        $('touchStickLabel').textContent = G.uiMode === 'pilot' ? 'STEER' : 'MOVE VIEW';
        $('touchStick').setAttribute('aria-label', G.uiMode === 'pilot' ? 'Steer ship: left/right yaw, up/down pitch' : 'Move camera: left/right strafe, up/down forward/back');
        updateTitle(); measure();
    };
    const close = (focus = true) => {
        if (opened === 'search') $('navClose')?.click();
        if (opened === 'events') $('evClose')?.click();
        if (opened === 'catalog') $('hygClose')?.click();
        if (opened === 'cinematic') setCineOpen(false);
        if (opened === 'help' && $('help').style.display !== 'none') $('exploreHelp').click();
        opened = null; cancelTouchInput(); render();
        if (focus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    const open = (name, trigger) => {
        if (!compact) return;
        if (opened === name) { close(); return; }
        close(false); returnFocus = trigger?.closest('#touchMenu') ? menuButton : (trigger || document.activeElement); cancelTouchInput();
        nativeOpening = true;
        if (name === 'details') $('exploreInfo').open = true;
        if (name === 'search') $('exploreSearch').click();
        if (name === 'events') $('exploreEvents').click();
        if (name === 'help' && $('help').style.display !== 'block') $('exploreHelp').click();
        if (name === 'cinematic') setCineOpen(true);
        nativeOpening = false; opened = name; render();
        requestAnimationFrame(() => roots[name]?.querySelector('button,input,select,summary')?.focus({ preventScroll: true }));
    };
    const head = (root, label) => {
        const h = document.createElement('div'); h.className = 'mobileSheetHead';
        const title = document.createElement('strong'); title.textContent = label;
        const dismiss = button(`dismiss-${root.id}`, `Close ${label}`, null, '✕');
        h.append(title, dismiss); root.prepend(h); dismiss.addEventListener('click', () => close());
        let origin = null;
        h.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; origin = e.clientY; h.setPointerCapture(e.pointerId); });
        h.addEventListener('pointerup', e => { if (origin !== null && e.clientY - origin > 55) close(); origin = null; });
        h.addEventListener('pointercancel', () => { origin = null; });
    };
    head(panel, 'Object'); head(menu, 'Menu'); head(camera, 'Camera movement'); head($('cinePanel'), 'Camera tour');
    details.addEventListener('click', () => open(G.uiMode === 'observe' ? 'details' : 'menu', details));
    menuButton.addEventListener('click', () => open('menu', menuButton));
    search.addEventListener('click', () => open('search', search));
    more.addEventListener('click', () => open('time', more));
    events.addEventListener('click', () => open('events', events));
    help.addEventListener('click', () => open('help', help));
    tour.addEventListener('click', () => open('cinematic', tour));
    home.addEventListener('click', () => { close(); $('exploreHome').click(); });
    move.addEventListener('click', () => { moveOpen = !moveOpen; close(); render(); });
    backdrop.addEventListener('click', () => close());
    for (const [id,name] of [['navClose','search'],['evClose','events'],['helpClose','help'],['hygClose','catalog']]) $(id)?.addEventListener('click', () => {
        if (opened === name) { opened = null; render(); requestAnimationFrame(() => returnFocus?.focus({preventScroll:true})); }
    });
    for (const name of ['search','events','help','catalog','cinematic']) {
        const root = roots[name];
        if (!root) continue;
        new MutationObserver(() => {
            if (!compact || opened !== name) return;
            const closed = ['search','events'].includes(name) ? !root.classList.contains('open') : root.style.display === 'none';
            if (closed) { opened = null; cancelTouchInput(); render(); returnFocus?.focus({preventScroll:true}); }
        }).observe(root, {attributes:true,attributeFilter:['style','class']});
    }
    if ($('mReset')) $('mReset').textContent = 'Restart simulation';
    // A native entry point (for example Events inside time settings) must use
    // the same sheet owner and focus handling as the compact menu trigger.
    document.addEventListener('click', e => {
        if (!compact || nativeOpening) return;
        const entry = e.target.closest('#exploreEvents,#mNav,#mCatalog,#exploreCatalog,#mHelpBtn');
        const name = {exploreEvents:'events',mNav:'search',mCatalog:'catalog',exploreCatalog:'catalog',mHelpBtn:'help'}[entry?.id];
        if (!name) return;
        queueMicrotask(() => { close(false); opened = name; returnFocus = menuButton; render(); roots[name]?.querySelector('input,button')?.focus({preventScroll:true}); });
    }, true);
    // Destination and flight-system actions keep their original implementation.
    document.addEventListener('click', e => { if (compact && e.target.closest('[data-destination],.navItem,.hygResult,#exploreCatalog,#exploreScale,#touchFlightSlot button')) close(false); });
    document.addEventListener('keydown', e => {
        if (!compact || !opened) return;
        if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
        if (e.key !== 'Tab') return;
        const nodes = [...roots[opened].querySelectorAll('button,input,select,summary,a[href],[tabindex="0"]')].filter(n => n.getClientRects().length && !n.disabled);
        if (!nodes.length) return;
        const first = nodes[0], last = nodes.at(-1);
        if (e.shiftKey && (document.activeElement === first || !roots[opened].contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !roots[opened].contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }, true);
    const touchStick = controls.querySelector('#touchStick');
    if (!touchStick) throw new Error('Mobile thumb control failed to initialize');
    bindNavigationStick(touchStick);
    for (const b of controls.querySelectorAll('[data-touch-key]')) {
        let owner = null;
        const stop = () => { keys.delete(b.dataset.touchKey); const old = owner; owner = null; if (old !== null) try { b.releasePointerCapture(old); } catch { /* ended */ } };
        b.addEventListener('pointerdown', e => { e.preventDefault(); if (owner !== null) return; owner = e.pointerId; b.setPointerCapture(owner); keys.add(b.dataset.touchKey); });
        for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(event, e => { if (e.pointerId === owner) stop(); });
        onInputCancel(stop);
    }
    onInputCancel(stopMovement);
    onModeChange(() => { moveOpen = false; close(false); render(); });
    const applyMedia = () => {
        compact = media.matches; close(false);
        for (const { node, destination, marker } of moved) if (compact) destination.append(node); else marker.after(node);
        render();
    };
    media.addEventListener('change', applyMedia);
    for (const event of ['resize', 'scroll']) window.visualViewport?.addEventListener(event, measure);
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure); observer.observe(bar); observer.observe(dock);
    new MutationObserver(updateTitle).observe($('exploreObject'), { childList: true, characterData: true, subtree: true });
    const quality = $('touchGraphics'); quality.value = renderSession.mode;
    quality.addEventListener('change', () => setMobileGraphics(quality.value));
    for (const b of [reset, statusButton]) b.addEventListener('click', () => { recoverGraphics(); quality.value = 'safe'; });
    for (const b of [reload, statusReload]) b.addEventListener('click', () => { if (confirm('Reload in Safe mode? Unsaved simulation state will reset. Recover graphics keeps the current simulation.')) reloadSafe(); });
    diagnostics.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(window.__mobileDiagnostics?.(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'artemis-graphics.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    fullscreen.hidden = !document.documentElement.requestFullscreen;
    fullscreen.addEventListener('click', async () => {
        try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
        catch { fullscreen.textContent = 'Fullscreen unavailable'; }
    });
    window.addEventListener('ap:render-status', () => {
        quality.value = renderSession.mode;
        status.hidden = !['lost', 'slow', 'failed'].includes(renderSession.state);
        statusText.textContent = renderSession.reason;
    });
    applyMedia();
}
