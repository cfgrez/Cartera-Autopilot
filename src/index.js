/**
 * Punto de entrada del Worker.
 *
 * Cloudflare sirve primero los archivos de `public/` (configurados en
 * wrangler.toml como [assets]). Solo cuando la ruta no corresponde a ningún
 * archivo llega hasta acá, y en ese caso enrutamos la API.
 */

import { handleQuotes } from "./quotes.js";
import { handlePortfolio } from "./portfolio.js";
import { handleSave, saveStatus } from "./save.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/quotes") {
      if (request.method === "OPTIONS") return preflight("GET");
      if (request.method !== "GET") return notAllowed("GET");
      return handleQuotes(request, env, ctx);
    }

    if (pathname === "/api/portfolio") {
      if (request.method === "OPTIONS") return preflight("GET");
      if (request.method !== "GET") return notAllowed("GET");
      return handlePortfolio(request, env, ctx);
    }

    if (pathname === "/api/save") {
      if (request.method === "OPTIONS") return preflight("GET, POST");
      if (request.method === "GET") return saveStatus(env);
      if (request.method === "POST") return handleSave(request, env);
      return notAllowed("GET, POST");
    }

    // Cualquier otra cosa: que responda el servidor de assets.
    return env.ASSETS.fetch(request);
  },
};

const preflight = (methods) =>
  new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": `${methods}, OPTIONS`,
      "access-control-allow-headers": "content-type, x-edit-token",
    },
  });

const notAllowed = (allow) =>
  new Response("Method Not Allowed", { status: 405, headers: { allow } });
