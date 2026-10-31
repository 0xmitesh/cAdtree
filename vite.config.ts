import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig, type ViteDevServer } from "vite";

export default defineConfig(({ command, mode }) => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      ...(command === "serve" && mode === "synthetic"
        ? [
            {
              name: "synthetic-development-home",
              configureServer(server: ViteDevServer) {
                server.middlewares.use((request, _response, next) => {
                  if (request.url === "/")
                    request.url = "/tests/synthetic.html";
                  next();
                });
              },
            },
          ]
        : []),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== "true",
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === "true" ? null : {},
    },
  };
});
