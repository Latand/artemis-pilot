import { defineConfig } from "vite";
import { galaxyPreviewPlugin } from "./scripts/galaxy-preview-plugin.mjs";

export default defineConfig({
    base: "./",
    plugins: [galaxyPreviewPlugin()],
    build: { target: "esnext", chunkSizeWarningLimit: 1200 },
});
