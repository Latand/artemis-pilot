// Catch module fetch, evaluation and top-level initialization failures, even
// when no renderer or application controls were created.
import("./main.js").catch(error => {
    console.error("Artemis startup failed", error);
    window.dispatchEvent(new CustomEvent("artemis:startup-error", { detail: error }));
});
