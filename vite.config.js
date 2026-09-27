import { defineConfig } from "vite";
import { galaxyPreviewPlugin } from "./scripts/galaxy-preview-plugin.mjs";

export default defineConfig({
    base: "./",
    define: { __BUILD_ID__: JSON.stringify(process.env.ARTEMIS_BUILD_ID || process.env.GITHUB_SHA || "local") },
    plugins: [galaxyPreviewPlugin()],
    build: { target: "esnext", chunkSizeWarningLimit: 1200 },
});
