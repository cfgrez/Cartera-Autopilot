/**
 * GET /api/quotes?symbols=QXO,ARDX,VST
 *
 * Devuelve el último precio de cada símbolo. Corre como Pages Function
 * (Cloudflare Workers) para evitar CORS y para poder cachear en el borde.
 *
 * Fuente primaria: endpoint público de gráficos de Yahoo Finance (sin API key).
 * Fuente alternativa: Finnhub, si defines la variable de entorno FINNHUB_API_KEY.
 */

const CACHE_SECONDS = 60;
const MAX_SYMBOLS = 40;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const symbols = (url.searchParams.get("symbols") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, MAX_SYMBOLS);

  if (symbols.length === 0) {
    return json({ error: "Falta el parámetro ?symbols=" }, 400);
  }

  // Cache en el borde: una misma lista de símbolos se sirve desde caché 60s.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const settled = await Promise.all(
    symbols.map((sym) => fetchQuote(sym, env).catch((err) => ({ symbol: sym, error: String(err) })))
  );

  const quotes = {};
  for (const q of settled) quotes[q.symbol] = q;

  const body = {
    fetchedAt: new Date().toISOString(),
    ok: settled.filter((q) => typeof q.price === "number").length,
    failed: settled.filter((q) => typeof q.price !== "number").map((q) => q.symbol),
    quotes,
  };

  const response = json(body, 200, {
    "cache-control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
  });
  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function fetchQuote(symbol, env) {
  if (env && env.FINNHUB_API_KEY) {
    try {
      return await fromFinnhub(symbol, env.FINNHUB_API_KEY);
    } catch (_) {
      /* si falla, se intenta Yahoo */
    }
  }
  return await fromYahoo(symbol);
}

async function fromYahoo(symbol) {
  const endpoint =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&range=5d`;

  const res = await fetch(endpoint, {
    headers: {
      // Yahoo rechaza peticiones sin user-agent de navegador.
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "application/json",
    },
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  });

  if (!res.ok) throw new Error(`Yahoo respondió ${res.status}`);

  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") {
    throw new Error("Respuesta de Yahoo sin precio");
  }

  return {
    symbol,
    price: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? null,
    quoteTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    source: "yahoo",
  };
}

async function fromFinnhub(symbol, apiKey) {
  const endpoint =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`;
  const res = await fetch(endpoint, { cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
  if (!res.ok) throw new Error(`Finnhub respondió ${res.status}`);

  const d = await res.json();
  if (typeof d.c !== "number" || d.c === 0) throw new Error("Respuesta de Finnhub sin precio");

  return {
    symbol,
    price: d.c,
    previousClose: d.pc ?? null,
    currency: "USD",
    marketState: null,
    quoteTime: d.t ? new Date(d.t * 1000).toISOString() : null,
    source: "finnhub",
  };
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}
