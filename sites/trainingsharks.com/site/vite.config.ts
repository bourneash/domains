import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The engine is a raw .wasm in public/ — no bundler plugin, no glue module.
  // Vite copies it verbatim, which is exactly what we want for a hand-rolled ABI.
  build: { target: "es2022" }
});
