/**
 * POST /api/save   → escribe public/data/portfolio.json en GitHub y hace commit
 * GET  /api/save   → dice si el guardado está configurado (sin exigir clave)
 *
 * El commit lo hace el Worker con un token de GitHub que nunca llega al navegador.
 * Quien guarda solo conoce EDIT_TOKEN, una clave que puedes rotar sin tocar el token
 * de GitHub y que no da acceso a nada más que a este archivo.
 *
 * Variables necesarias (todas como secret, salvo las dos últimas):
 *   EDIT_TOKEN      clave que pide el editor antes de guardar
 *   GITHUB_TOKEN    fine-grained PAT con permiso Contents: read and write
 *   GITHUB_REPO     "usuario/repositorio"
 *   GITHUB_BRANCH   opcional, por defecto "main"
 *   GITHUB_PATH     opcional, por defecto "public/data/portfolio.json"
 */

import { computeFund } from "../public/assets/engine.js";

const MAX_BODY = 512 * 1024; // 512 KB: de sobra para el JSON, y frena payloads absurdos
const DEFAULT_BRANCH = "main";
const DEFAULT_PATH = "public/data/portfolio.json";
const UA = "cartera-autopilot";

export function saveStatus(env) {
  return json({ enabled: isConfigured(env) });
}

export async function handleSave(request, env) {
  if (!isConfigured(env)) {
    return json({ error: "El guardado no está configurado en este Worker." }, 501);
  }

  // ---- autenticación ----
  const given = request.headers.get("x-edit-token") ?? "";
  if (!safeEqual(given, env.EDIT_TOKEN)) {
    // Un poco de latencia para que probar claves a ciegas salga caro.
    await sleep(400);
    return json({ error: "Clave incorrecta." }, 401);
  }

  // ---- lectura y validación del cuerpo ----
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return json({ error: "El archivo es demasiado grande." }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "El cuerpo no es JSON válido." }, 400);
  }

  const portfolio = body?.portfolio;
  const problem = validate(portfolio);
  if (problem) return json({ error: problem }, 422);

  const message = String(body?.message || "Actualizar cartera").slice(0, 200);

  // ---- commit ----
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = env.GITHUB_PATH || DEFAULT_PATH;
  const base = `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`;

  let sha;
  try {
    const head = await gh(`${base}?ref=${encodeURIComponent(branch)}`, env);
    if (head.status === 200) sha = (await head.json()).sha;
    else if (head.status !== 404) return ghError(head, "leer");
  } catch (err) {
    return json({ error: `No se pudo contactar a GitHub: ${err.message}` }, 502);
  }

  const content = JSON.stringify(portfolio, null, 2) + "\n";
  const put = await gh(base, env, {
    method: "PUT",
    body: JSON.stringify({ message, content: toBase64(content), branch, ...(sha ? { sha } : {}) }),
  });

  if (put.status === 409 || put.status === 422) {
    return json({
      error: "El archivo cambió en GitHub desde que abriste el editor. " +
             "Recarga la página y vuelve a aplicar tus movimientos.",
    }, 409);
  }
  if (!put.ok) return ghError(put, "escribir");

  const result = await put.json();
  const f = computeFund(portfolio);

  return json({
    ok: true,
    commit: result.commit?.sha?.slice(0, 7) ?? null,
    url: result.commit?.html_url ?? null,
    total: f.total,
    cash: f.cash,
  });
}

/* ===================== validación ===================== */

export function validate(p) {
  if (!p || typeof p !== "object") return "Falta el objeto `portfolio`.";
  if (typeof p.fund?.initialCapital !== "number") return "`fund.initialCapital` debe ser un número.";
  if (!Array.isArray(p.trades)) return "`trades` debe ser una lista.";
  if (p.cashFlows != null && !Array.isArray(p.cashFlows)) return "`cashFlows` debe ser una lista.";

  for (const [i, t] of p.trades.entries()) {
    const where = `Operación ${i + 1}${t?.ticker ? ` (${t.ticker})` : ""}`;
    if (!t?.ticker || typeof t.ticker !== "string") return `${where}: falta el ticker.`;
    if (!(Number(t.qty) > 0)) return `${where}: la cantidad debe ser mayor que cero.`;
    if (!(Number(t.buyPrice) > 0)) return `${where}: el precio de compra debe ser mayor que cero.`;
    if (!isDate(t.buyDate)) return `${where}: fecha de compra inválida.`;

    const sells = Array.isArray(t.sells) ? t.sells : [];
    let sold = 0;
    for (const s of sells) {
      if (!isDate(s?.date)) return `${where}: una venta tiene fecha inválida.`;
      if (!(Number(s.qty) > 0)) return `${where}: una venta tiene cantidad inválida.`;
      if (!(Number(s.price) > 0)) return `${where}: una venta tiene precio inválido.`;
      if (s.date < t.buyDate) return `${where}: hay una venta anterior a la compra.`;
      sold += Number(s.qty);
    }
    if (sold > Number(t.qty) + 1e-9) {
      return `${where}: las ventas suman más unidades de las compradas.`;
    }
  }

  // Última red: el motor debe poder calcular y la caja no puede quedar negativa.
  let f;
  try {
    f = computeFund(p);
  } catch (err) {
    return `El motor no pudo calcular la cartera: ${err.message}`;
  }
  if (!Number.isFinite(f.total)) return "El patrimonio resultante no es un número.";
  if (f.cash < -0.005) {
    return `La caja quedaría en US$ ${f.cash.toFixed(2)}. Revisa las compras o registra un aporte.`;
  }
  if (Math.abs(f.cash + f.marketValue - (f.capital + f.realized + f.unrealized)) > 0.01) {
    return "El cálculo no cuadra. No se guardó nada.";
  }
  return null;
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/* ===================== utilidades ===================== */

const isConfigured = (env) => Boolean(env?.EDIT_TOKEN && env?.GITHUB_TOKEN && env?.GITHUB_REPO);

function gh(url, env, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": UA,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function ghError(res, verb) {
  let detail = "";
  try {
    detail = (await res.json())?.message ?? "";
  } catch { /* respuesta sin JSON */ }
  const hint = res.status === 401 || res.status === 403
    ? " Revisa que GITHUB_TOKEN siga vigente y tenga permiso Contents: read and write."
    : res.status === 404
      ? " Revisa GITHUB_REPO, GITHUB_BRANCH y GITHUB_PATH."
      : "";
  if (detail && !/[.!?]$/.test(detail)) detail += ".";
  return json({ error: `GitHub rechazó ${verb} el archivo (${res.status}). ${detail}${hint}`.trim() }, 502);
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function safeEqual(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
