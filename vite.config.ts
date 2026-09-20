import { defineConfig, type Plugin } from "vite";
import { createLlmMiddleware } from "./server/llm";
function localLlm(): Plugin {
  return { name: "local-llm", configureServer(server) { server.middlewares.use(createLlmMiddleware()); server.middlewares.use(createLlmMiddleware(fetch, "jev")); },
    configurePreviewServer(server) { server.middlewares.use(createLlmMiddleware()); server.middlewares.use(createLlmMiddleware(fetch, "jev")); } };
}
export default defineConfig({ plugins: [localLlm()] });
