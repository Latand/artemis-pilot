export const JUMP_END_LATCH_MS = 1500;

function setText(node, text) {
    const value = String(text);
    if (node.textContent !== value) node.textContent = value;
}

function setHidden(node, hidden) {
    if (node.hidden !== hidden) node.hidden = hidden;
}

function setClass(node, name, enabled) {
    if (node.classList.contains(name) !== enabled) node.classList.toggle(name, enabled);
}

export function eventSurfaceAllowed(uiMode, cabin, clean, xr) {
    return uiMode === "observe" && !cabin && !clean && !xr;
}

export function createEventController({
    panel,
    button,
    close,
    jumpDock,
    jumpDockLabel,
    jumpChip,
    jumpChipLabel,
    jumpChipEta,
    cancelJump,
    endLatchMs = JUMP_END_LATCH_MS,
}) {
    let open = false;
    let activityRevision = 0;
    let lastSeenRevision = 0;
    let discoveryRevision = -1;
    let jumpWasActive = false;
    let activeJumpLabel = "";
    let jumpEndUntilMs = 0;

    function renderUnread() {
        setClass(button, "evBtn--new", !open && activityRevision > lastSeenRevision);
    }

    function setOpen(nextOpen) {
        const next = !!nextOpen;
        if (open === next) return false;
        open = next;
        setClass(panel, "open", next);
        const expanded = next ? "true" : "false";
        if (button.getAttribute("aria-expanded") !== expanded) button.setAttribute("aria-expanded", expanded);
        if (next) {
            lastSeenRevision = activityRevision;
            renderUnread();
            close.focus();
        } else {
            renderUnread();
            if (button.getClientRects().length > 0) button.focus();
        }
        return true;
    }

    function noteActivity() {
        activityRevision++;
        if (open) lastSeenRevision = activityRevision;
        renderUnread();
    }

    function syncDiscovery(nextRevision, change) {
        if (!Number.isInteger(nextRevision) || nextRevision === discoveryRevision) return 0;
        const initial = discoveryRevision < 0;
        discoveryRevision = nextRevision;
        if (!initial && change === "append") noteActivity();
        else {
            lastSeenRevision = activityRevision;
            renderUnread();
        }
        return change === "append" && !initial ? 1 : 2;
    }

    function latchJumpEnd(label, nowMs) {
        setText(jumpChipLabel, label);
        setText(jumpChipEta, "");
        jumpEndUntilMs = nowMs + endLatchMs;
        jumpWasActive = false;
        activeJumpLabel = "";
    }

    function renderJump(active, label, etaWallSec, simTimeSec, nowMs, terminalOutcome = "") {
        void simTimeSec;
        setHidden(jumpDock, !active);
        if (!active) {
            if (jumpWasActive) {
                latchJumpEnd(
                    terminalOutcome === "arrive" ? "Arrived at " + activeJumpLabel : "Jump cancelled",
                    nowMs,
                );
            }
            setHidden(jumpChip, !(jumpEndUntilMs > nowMs));
            return;
        }
        setHidden(jumpChip, false);
        if (!jumpWasActive || activeJumpLabel !== label) {
            jumpEndUntilMs = 0;
            activeJumpLabel = label;
            jumpWasActive = true;
            setText(jumpChipLabel, "Riding time to " + label);
        }
        const eta = Math.ceil(etaWallSec);
        setText(jumpDockLabel, "JUMPING TO " + label + " · ETA ~" + eta + "s · touch time to cancel");
        setText(jumpChipEta, "ETA ~" + eta + "s");
    }

    return {
        setOpen,
        toggleOpen() { return setOpen(!open); },
        closeForAction() { return setOpen(false); },
        handleEscape(key) { return key === "Escape" && open ? setOpen(false) : false; },
        handleMode(uiMode, cabin, clean, xr) {
            if (!eventSurfaceAllowed(uiMode, cabin, clean, xr)) setOpen(false);
        },
        setLive(active) { setClass(button, "evBtn--live", !!active); },
        syncDiscovery,
        noteActivity,
        beginJump() {
            jumpEndUntilMs = 0;
        },
        renderJump,
        requestCancel(simTimeSec, nowMs) {
            if (!cancelJump()) return false;
            renderJump(false, "", 0, simTimeSec, nowMs, "cancel");
            return true;
        },
        isOpen() { return open; },
        hasUnread() { return !open && activityRevision > lastSeenRevision; },
    };
}
