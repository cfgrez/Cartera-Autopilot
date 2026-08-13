/**
 * Punto de entrada del Worker.
 *
 * Cloudflare sirve primero los archivos de `public/` (configurados en
 * wrangler.toml como [assets]). Solo cuando la ruta no corresponde a ningún
 * archivo llega hasta acá, y en ese caso enrutamos la API.
 */

import { handleQuotes } from "./quotes.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/quotes") {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, OPTIONS",
          },
        });
      }
      if (request.method !== "GET") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      return handleQuotes(request, env, ctx);
    }

    // Cualquier otra cosa: que responda el servidor de assets.
    return env.ASSETS.fetch(request);
  },
};
