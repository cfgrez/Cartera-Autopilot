import { computeFund } from "./engine.js";

const REFRESH_MS = 60_000;
const PALETTE = [
  "#12634A", "#7FA3C4", "#1E7F63", "#8F6115", "#35997B",
  "#B08A3E", "#5CB09A", "#CBAE73", "#88C6AF", "#6E7F76",
  "#A8523A", "#4E8FB0",
];
const CASH_COLOR = "#2E5B87";

const money = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const pctFmt = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

const usd = (n) => (n < 0 ? "−" : "") + money.format(Math.abs(n));
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + money.format(Math.abs(n));
const pct = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + pctFmt.format(Math.abs(n) * 100) + "%";
const cls = (n) => (n > 0 ? "g" : n < 0 ? "r" : "m");

let doc = null;
let live = true;

boot();

async function boot() {
  $("#toggle-live").addEventListener("click", () => {
    live = !live;
    $("#toggle-live").setAttribute("aria-pressed", String(live));
    $("#toggle-live").textContent = live ? "Precios en vivo" : "Precios de la planilla";
    render();
  });
  $("#refresh").addEventListener("click", () => render());

  try {
    doc = await (await fetch("data/portfolio.json", { cache: "no-store" })).json();
  } catch (err) {
    $("#app").innerHTML =
      `<p class="error">No se pudo leer <code>data/portfolio.json</code>: ${err.message}</p>`;
    return;
  }

  await render();
  setInterval(() => live && render(), REFRESH_MS);
}

async function render() {
  const openTickers = doc.trades.filter((t) => t.status !== "closed").map((t) => t.ticker);
  let quotes = {};
  let quotesError = null;

  if (live && openTickers.length) {
    setStatus("Actualizando cotizaciones…", "loading");
    try {
      const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(openTickers.join(","))}`);
      if (!res.ok) throw new Error(`API devolvió ${res.status}`);
      quotes = (await res.json()).quotes ?? {};
    } catch (err) {
      quotesError = err.message;
    }
  }

  const f = computeFund(doc, quotes);
  paint(f, quotesError);
}

function setStatus(text, kind) {
  const n = $("#status");
  n.textContent = text;
  n.className = "status " + (kind || "");
}

function paint(f, quotesError) {
  document.title = `${money.format(f.total)} · ${f.fund.name ?? "Fondo"}`;

  // ---------- estado ----------
  if (quotesError) {
    setStatus(`Sin conexión a cotizaciones (${quotesError}) — usando precios de la planilla`, "warn");
  } else if (!live) {
    setStatus(`Precios de la planilla · ${f.fund.priceAsOf?.slice(0, 16).replace("T", " ") ?? "—"}`, "");
  } else if (f.stale.length) {
    setStatus(`En vivo, salvo ${f.stale.join(", ")} (sin cotización)`, "warn");
  } else {
    setStatus(`En vivo · actualizado ${new Date().toLocaleTimeString("es-CL")}`, "ok");
  }

  // ---------- encabezado ----------
  $("#fund-name").textContent = f.fund.name ?? "Fondo";
  $("#fund-sub").textContent =
    `Capital aportado US$ ${money.format(f.capital)} · inicio ${f.fund.startDate} · ${f.metrics.days} días · ${f.metrics.tradeCount} operaciones`;
  $("#total").textContent = money.format(f.total);
  const d = $("#delta");
  d.textContent = `${signed(f.pnl)}  ${pct(f.returnPct)}`;
  d.className = "delta " + cls(f.pnl);

  // ---------- barra caja / mercado ----------
  const mktW = f.total ? (f.marketValue / f.total) * 100 : 0;
  $("#split").innerHTML =
    `<div class="seg mkt" style="width:${mktW}%">EN MERCADO · US$ ${money.format(f.marketValue)}</div>` +
    `<div class="seg cash" style="width:${100 - mktW}%">CAJA · US$ ${money.format(f.cash)}</div>`;

  // ---------- tarjetas ----------
  $("#cards").innerHTML = "";
  card("Resultado realizado", signed(f.realized), cls(f.realized),
    `${f.closed.length} operaciones cerradas`);
  card("Resultado no realizado", signed(f.unrealized), cls(f.unrealized),
    `${f.open.length} posiciones abiertas`);
  card("Caja", money.format(f.cash), "cashc",
    `${pctFmt.format(f.cashWeight * 100)}% del patrimonio`);
  card("Costo de lo abierto", money.format(f.openCost), "",
    `vale ${money.format(f.marketValue)} en mercado`);

  function card(label, value, klass, sub) {
    const n = el("div", "card");
    n.append(el("dt", null, label), el("dd", klass, `${value}<small>${sub}</small>`));
    $("#cards").append(n);
  }

  // ---------- gráficos ----------
  const colors = colorMap(f);
  $("#donut").innerHTML = donut(f, colors);
  $("#timeline").innerHTML = timelineChart(f);
  $("#contrib").innerHTML = "";
  contribution(f);

  // ---------- tablas ----------
  openTable(f, colors);
  closedTable(f);
  metricsTable(f);
}

function colorMap(f) {
  const m = { __cash: CASH_COLOR };
  f.open.forEach((t, i) => (m[t.ticker] = PALETTE[i % PALETTE.length]));
  return m;
}

/* ============================ DONA ============================ */
function donut(f, colors) {
  const slices = [
    { name: "Caja", value: f.cash, color: CASH_COLOR },
    ...f.open.map((t) => ({ name: t.ticker, value: t.marketValue, color: colors[t.ticker] })),
  ].filter((s) => s.value > 0.005);

  const total = slices.reduce((a, s) => a + s.value, 0);
  const cx = 170, cy = 170, r = 150, ri = 88;
  let angle = -90;
  const arcs = [], inner = [], outer = [];

  for (const s of slices) {
    const sweep = (s.value / total) * 360;
    const b = angle + sweep;
    const [x1, y1] = pt(cx, cy, r, angle), [x2, y2] = pt(cx, cy, r, b);
    const [x3, y3] = pt(cx, cy, ri, b), [x4, y4] = pt(cx, cy, ri, angle);
    const laf = sweep > 180 ? 1 : 0;
    arcs.push(
      `<path d="M${x1},${y1} A${r},${r} 0 ${laf} 1 ${x2},${y2} L${x3},${y3} A${ri},${ri} 0 ${laf} 0 ${x4},${y4} Z" fill="${s.color}"><title>${s.name}: US$ ${money.format(s.value)} (${pctFmt.format((s.value / total) * 100)}%)</title></path>`
    );

    const mid = (angle + b) / 2;
    const share = pctFmt.format((s.value / total) * 100) + "%";
    if (sweep >= 22) {
      const [lx, ly] = pt(cx, cy, (r + ri) / 2, mid);
      inner.push(
        `<text x="${lx}" y="${ly - 3}" text-anchor="middle" class="slice-k">${s.name}</text>` +
        `<text x="${lx}" y="${ly + 12}" text-anchor="middle" class="slice-v">${share}</text>`
      );
    } else {
      const [ax, ay] = pt(cx, cy, r + 2, mid);
      const [bx, by] = pt(cx, cy, r + 22, mid);
      const right = bx > cx;
      outer.push(
        `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" class="lead"/>` +
        `<text x="${bx + (right ? 6 : -6)}" y="${by + 4}" text-anchor="${right ? "start" : "end"}" class="outl"><tspan class="k">${s.name}</tspan> ${share}</text>`
      );
    }
    angle = b;
  }

  return `<svg viewBox="-46 -30 432 400" role="img" aria-label="Composición del patrimonio">
    <g stroke="var(--card)" stroke-width="1.6">${arcs.join("")}</g>
    ${inner.join("")}${outer.join("")}
    <text x="${cx}" y="${cy - 16}" text-anchor="middle" class="c-l">PATRIMONIO</text>
    <text x="${cx}" y="${cy + 10}" text-anchor="middle" class="c-v">${money.format(f.total)}</text>
    <text x="${cx}" y="${cy + 28}" text-anchor="middle" class="c-s">dólares</text>
  </svg>`;
}

const pt = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [round(cx + r * Math.cos(a)), round(cy + r * Math.sin(a))];
};
const round = (n) => Math.round(n * 100) / 100;

/* ======================= CAJA VS INVERTIDO ======================= */
function timelineChart(f) {
  const pts = f.timeline;
  if (pts.length < 2) return "";

  const W = 960, H = 250, L = 58, R = 24, T = 22, B = 46;
  const max = Math.max(...pts.map((p) => p.book)) * 1.06;
  const first = pts[0].date, last = pts[pts.length - 1].date;
  const span = Math.max(1, dayDiff(first, last));
  // Un tramo extra al final para que el estado de hoy tenga ancho visible.
  const domain = span * 1.06;
  const x = (dt) => L + (dayDiff(first, dt) / domain) * (W - L - R);
  const y = (v) => H - B - (v / max) * (H - T - B);

  const step = (key) => {
    let d = `M${x(first)},${y(pts[0][key])}`;
    for (let i = 1; i < pts.length; i++) {
      d += ` L${x(pts[i].date)},${y(pts[i - 1][key])} L${x(pts[i].date)},${y(pts[i][key])}`;
    }
    return d + ` L${W - R},${y(pts[pts.length - 1][key])}`;
  };

  const invLine = step("invested");
  const bookLine = step("book");
  const base = `L${W - R},${y(0)} L${L},${y(0)} Z`;
  const bookBack = ` L${W - R},${y(pts[pts.length - 1].invested)}` +
    reverseStep(pts, x, y, "invested") + " Z";

  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((g) => {
      const v = max * g;
      return `<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" class="grid"/>` +
        `<text x="${L - 8}" y="${y(v) + 3}" text-anchor="end" class="ax">${money.format(v).split(",")[0]}</text>`;
    })
    .join("");

  const marks = pts
    .map((p) => `<text x="${x(p.date)}" y="${H - B + 18}" text-anchor="middle" class="ax">${shortDate(p.date)}</text>`)
    .join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Caja e inversión en el tiempo">
    ${grid}
    <path d="${invLine} ${base}" fill="#12634A" fill-opacity=".16"/>
    <path d="${bookLine}${bookBack}" fill="#2E5B87" fill-opacity=".20"/>
    <path d="${invLine}" fill="none" stroke="#12634A" stroke-width="2"/>
    <path d="${bookLine}" fill="none" stroke="#2E5B87" stroke-width="2"/>
    <line x1="${L}" y1="${y(f.total)}" x2="${W - R}" y2="${y(f.total)}" class="mkt-line"/>
    <text x="${W - R}" y="${y(f.total) - 6}" text-anchor="end" class="ax">valor de mercado hoy ${money.format(f.total)}</text>
    ${marks}
  </svg>`;
}

function reverseStep(pts, x, y, key) {
  let d = "";
  for (let i = pts.length - 1; i > 0; i--) {
    d += ` L${x(pts[i].date)},${y(pts[i][key])} L${x(pts[i].date)},${y(pts[i - 1][key])}`;
  }
  return d + ` L${x(pts[0].date)},${y(pts[0][key])}`;
}

const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortDate = (iso) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/* ======================= CONTRIBUCIÓN ======================= */
function contribution(f) {
  const rows = f.byContribution;
  const maxPos = Math.max(0, ...rows.map((t) => t.pnl));
  const maxNeg = Math.max(0, ...rows.map((t) => -t.pnl));
  const range = maxPos + maxNeg || 1;
  const zero = (maxNeg / range) * 100;

  for (const t of rows) {
    const w = (Math.abs(t.pnl) / range) * 100;
    const bar = t.pnl >= 0
      ? `<div class="cbar p" style="left:${zero}%;width:${w}%"></div>`
      : `<div class="cbar n" style="left:${zero - w}%;width:${w}%"></div>`;
    const row = el("div", "crow");
    row.innerHTML =
      `<div class="tk">${t.ticker}<i>${t.status === "open" ? "abierta" : "cerrada"}</i></div>` +
      `<div class="ctrack"><div class="czero" style="left:${zero}%"></div>${bar}</div>` +
      `<div class="amt ${cls(t.pnl)}">${signed(t.pnl)}</div>` +
      `<div class="pc">${pct(t.pnlPct)}</div>`;
    $("#contrib").append(row);
  }
}

/* ======================= TABLAS ======================= */
function openTable(f, colors) {
  const body = $("#open-body");
  body.innerHTML = "";
  for (const t of f.open) {
    const tr = el("tr", t.belowStop ? "alert" : "");
    tr.innerHTML =
      `<td><i class="chip" style="background:${colors[t.ticker]}"></i>${t.ticker}${t.priceSource === "fallback" ? '<i class="badge">planilla</i>' : ""}</td>` +
      `<td>${t.qty}</td>` +
      `<td>${money4.format(t.buyPrice)}</td>` +
      `<td>${money4.format(t.price)}</td>` +
      `<td>${money.format(t.cost)}</td>` +
      `<td>${money.format(t.marketValue)}</td>` +
      `<td class="${cls(t.pnl)}">${signed(t.pnl)}</td>` +
      `<td class="${cls(t.pnl)}">${pct(t.pnlPct)}</td>` +
      `<td>${pctFmt.format((t.marketValue / f.marketValue) * 100)}%</td>` +
      `<td class="${t.belowStop ? "r" : "m"}">${t.stopDistPct == null ? "—" : pct(t.stopDistPct)}</td>`;
    body.append(tr);
  }
  $("#open-total").innerHTML =
    `<td>Total</td><td>${f.open.reduce((a, t) => a + t.qty, 0)}</td><td></td><td></td>` +
    `<td>${money.format(f.openCost)}</td><td>${money.format(f.marketValue)}</td>` +
    `<td class="${cls(f.unrealized)}">${signed(f.unrealized)}</td>` +
    `<td class="${cls(f.unrealized)}">${pct(f.openCost ? f.unrealized / f.openCost : 0)}</td>` +
    `<td>100,0%</td><td></td>`;
  $("#open-count").textContent = `${f.open.length} · US$ ${money.format(f.marketValue)}`;
}

function closedTable(f) {
  const body = $("#closed-body");
  body.innerHTML = "";
  for (const t of f.closed) {
    const tr = el("tr");
    tr.innerHTML =
      `<td>${t.ticker}</td><td class="m">${shortDate(t.sellDate)}</td><td>${t.days}</td>` +
      `<td>${t.qty}</td><td>${money4.format(t.buyPrice)}</td><td>${money4.format(t.price)}</td>` +
      `<td>${money.format(t.cost)}</td><td>${money.format(t.proceeds)}</td>` +
      `<td class="${cls(t.pnl)}">${signed(t.pnl)}</td><td class="${cls(t.pnl)}">${pct(t.pnlPct)}</td>`;
    body.append(tr);
  }
  const cost = f.closed.reduce((a, t) => a + t.cost, 0);
  const proc = f.closed.reduce((a, t) => a + t.proceeds, 0);
  $("#closed-total").innerHTML =
    `<td>Total</td><td></td><td class="m">${pctFmt.format(f.metrics.avgHoldClosed)} prom.</td>` +
    `<td>${f.closed.reduce((a, t) => a + t.qty, 0)}</td><td></td><td></td>` +
    `<td>${money.format(cost)}</td><td>${money.format(proc)}</td>` +
    `<td class="${cls(f.realized)}">${signed(f.realized)}</td>` +
    `<td class="${cls(f.realized)}">${pct(cost ? f.realized / cost : 0)}</td>`;
  $("#closed-count").textContent = `${f.closed.length} · ${signed(f.realized)}`;
}

function metricsTable(f) {
  const m = f.metrics;
  const rows = [
    ["Rentabilidad del período", pct(f.returnPct), `${m.days} días corridos sobre el capital aportado.`, cls(f.pnl)],
    ["Sobre capital desplegado", pct(m.avgDeployed ? f.pnl / m.avgDeployed : 0),
      `El capital promedio realmente invertido fue US$ ${money.format(m.avgDeployed)}.`, cls(f.pnl)],
    ["Aciertos", `${m.winCount} / ${m.tradeCount}`,
      `${pctFmt.format(m.hitRate * 100)}% del total; ${pctFmt.format(m.closedHitRate * 100)}% entre las cerradas.`, ""],
    ["Profit factor", m.profitFactor == null ? "—" : money.format(m.profitFactor),
      `US$ ${money.format(m.grossWin)} ganados contra US$ ${money.format(m.grossLoss)} perdidos.`, m.profitFactor > 1 ? "g" : "r"],
    ["Ganancia media", signed(m.avgWin),
      `Frente a una pérdida media de US$ ${money.format(m.avgLoss)}.`, "g"],
    ["Mejor operación", `${m.best?.ticker ?? "—"} ${signed(m.best?.pnl ?? 0)}`, pct(m.best?.pnlPct ?? 0), "g"],
    ["Peor operación", `${m.worst?.ticker ?? "—"} ${signed(m.worst?.pnl ?? 0)}`, pct(m.worst?.pnlPct ?? 0), "r"],
    ["Duración media (cerradas)", `${pctFmt.format(m.avgHoldClosed)} días`, "Solo operaciones ya liquidadas.", ""],
    ["Exposición a mercado", pct(m.exposure),
      `El resto (${pct(f.cashWeight)}) está en caja.`, "cashc"],
  ];

  const body = $("#metrics-body");
  body.innerHTML = "";
  for (const [k, v, note, klass] of rows) {
    const tr = el("tr");
    tr.innerHTML = `<td>${k}</td><td class="${klass}">${v}</td><td class="note">${note}</td>`;
    body.append(tr);
  }
}
