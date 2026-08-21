/**
 * GET /api/portfolio
 *
 * Devuelve el portfolio.json tal como está en GitHub, sin esperar a que
 * Cloudflare redespliegue. Así un movimiento guardado desde el editor aparece
 * en el dashboard al recargar, en vez de en dos minutos.
 *
 * Si GitHub no responde —o si el guardado no está configurado— el cliente
 * usa el archivo empaquetado en public/data/portfolio.json como respaldo.
 */

const CACHE_SECONDS = 30;
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "public/data/portfolio.json";
const UA = "cartera-autopilot";

export async function handlePortfolio(request, env, ctx) {
  if (!env?.GITHUB_TOKEN || !env?.GITHUB_REPO) {
    return json({ error: "unconfigured" }, 501);
  }

  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: "GET" });

  // `?fresh=1` salta la caché: lo usa el editor justo después de guardar.
  const skipCache = new URL(request.url).searchParams.get("fresh") === "1";
  if (!skipCache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = env.GITHUB_PATH || DEFAULT_PATH;
  const url =
    `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}` +
    `?ref=${encodeURIComponent(branch)}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github.raw+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": UA,
      },
    });
  } catch (err) {
    return json({ error: `No se pudo contactar a GitHub: ${err.message}` }, 502);
  }

  if (!res.ok) {
    return json({ error: `GitHub respondió ${res.status} al leer el archivo.` }, 502);
  }

  const text = await res.text();

  // Si GitHub devolviera algo que no es la cartera, mejor que el cliente
  // se quede con el archivo empaquetado que romper el dashboard.
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "El archivo en GitHub no es JSON válido." }, 502);
  }
  if (!parsed || !Array.isArray(parsed.trades)) {
    return json({ error: "El archivo en GitHub no parece una cartera." }, 502);
  }

  const response = new Response(text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
      "x-source": "github",
    },
  });

  if (!skipCache) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
