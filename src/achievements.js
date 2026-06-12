import { blip } from "./audio.js";

export const ACH = [
    { id: "highE", label: "Raise apoapsis past 100,000 km", name: "High-energy orbit" },
    { id: "record", label: "Beat Apollo 13 record (400,171 km)", name: "Farthest humans in history" },
    { id: "soi", label: "Enter the Moon's sphere of influence", name: "Lunar SOI entered" },
    { id: "flyby", label: "Lunar flyby below 5,000 km", name: "Low lunar flyby" },
    { id: "orbitM", label: "Capture lunar orbit", name: "Lunar orbit captured" },
    { id: "landM", label: "Land on the Moon", name: "The Eagle has landed" },
    { id: "home", label: "Return & splash down on Earth", name: "Welcome home, commander" },
    { id: "interplanetary", label: "Go interplanetary (1M km out)", name: "Interplanetary space" },
    { id: "planet", label: "Enter another planet's SOI", name: "Interplanetary visitor" },
    { id: "mars", label: "Land on Mars", name: "The Martian" },
    { id: "sun", label: "Reach the Sun's corona", name: "Icarus, but with a heat shield" },
    { id: "bh", label: "Cross a black hole's photon sphere", name: "Beyond the event horizon" },
];
const achDone = new Set();
const objListEl = document.getElementById("objList");
const toastsEl = document.getElementById("toasts");
export function renderObjectives() {
    objListEl.innerHTML = "";
    for (const a of ACH) {
        const li = document.createElement("li");
        li.textContent = a.label;
        if (achDone.has(a.id)) li.className = "done";
        objListEl.appendChild(li);
    }
}
export function award(id) {
    if (achDone.has(id)) return;
    achDone.add(id);
    const a = ACH.find(x => x.id === id);
    toast("★ " + a.name);
    renderObjectives();
}
export function toast(msg) {
    const d = document.createElement("div");
    d.className = "toast";
    d.textContent = msg;
    toastsEl.appendChild(d);
    blip();
    setTimeout(() => { d.style.transition = "opacity .5s"; d.style.opacity = "0"; setTimeout(() => d.remove(), 550); }, 3800);
}
