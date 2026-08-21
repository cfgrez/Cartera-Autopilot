/**
 * Carga la cartera. Primero intenta /api/portfolio, que lee directo de GitHub
 * y por lo tanto refleja lo recién guardado sin esperar el redespliegue.
 * Si eso no está disponible, cae al archivo empaquetado con el sitio.
 */
export async function loadPortfolio({ fresh = false } = {}) {
  try {
    const res = await fetch(`/api/portfolio${fresh ? "?fresh=1" : ""}`, { cache: "no-store" });
    if (res.ok) {
      const doc = await res.json();
      if (Array.isArray(doc?.trades)) return { doc, source: "github" };
    }
  } catch { /* sin API: seguimos con el archivo empaquetado */ }

  const res = await fetch("data/portfolio.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`no se pudo leer data/portfolio.json (${res.status})`);
  return { doc: await res.json(), source: "bundle" };
}
