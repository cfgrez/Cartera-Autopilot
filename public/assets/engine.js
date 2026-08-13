/**
 * Motor de cálculo del fondo. Funciones puras: reciben datos, devuelven datos.
 * No toca el DOM, así que se puede probar por separado.
 *
 * Una operación puede venderse en varias tandas. Cada venta vive en `sells`:
 *
 *   { "ticker": "ARDX", "qty": 11, "buyPrice": 5.035,
 *     "sells": [ { "date": "2026-08-14", "qty": 6, "price": 4.10 } ] }
 *
 * El estado (abierta / parcial / cerrada) se deduce de cuánto queda, no se declara.
 * El formato antiguo —`status`, `sellDate`, `sellPrice`— se sigue leyendo como una
 * venta única por la cantidad completa.
 *
 * Identidad que siempre debe cumplirse:
 *   patrimonio = caja + valor de mercado
 *   patrimonio = capital aportado + resultado realizado + resultado no realizado
 */

const EPS = 1e-9;

export function computeFund(doc, priceMap = {}) {
  const initial = Number(doc.fund?.initialCapital ?? 0);
  const flows = (doc.cashFlows ?? []).reduce((a, f) => a + Number(f.amount || 0), 0);
  const capital = initial + flows;

  const trades = (doc.trades ?? []).map((t) => enrich(normalize(t), priceMap));

  const open = trades.filter((t) => t.openQty > EPS);
  const exits = trades.flatMap((t) => t.exits);

  // Toda compra sale de la caja por su cantidad completa; toda venta vuelve a ella.
  const bought = trades.reduce((a, t) => a + t.costTotal, 0);
  const proceeds = trades.reduce((a, t) => a + t.proceeds, 0);
  const cash = capital - bought + proceeds;

  const marketValue = open.reduce((a, t) => a + t.marketValue, 0);
  const openCost = open.reduce((a, t) => a + t.costOpen, 0);

  const realized = trades.reduce((a, t) => a + t.realized, 0);
  const unrealized = trades.reduce((a, t) => a + t.unrealized, 0);

  const total = cash + marketValue;
  const pnl = realized + unrealized;

  return {
    fund: doc.fund ?? {},
    capital,
    cash,
    marketValue,
    openCost,
    total,
    realized,
    unrealized,
    pnl,
    returnPct: capital ? pnl / capital : 0,
    cashWeight: total ? cash / total : 0,
    trades,
    open: [...open].sort((a, b) => b.marketValue - a.marketValue),
    exits: [...exits].sort((a, b) => b.pnl - a.pnl),
    byContribution: [...trades].sort((a, b) => b.pnl - a.pnl),
    metrics: metrics(trades, exits, doc, cash, marketValue),
    timeline: timeline(doc, trades, capital),
    stale: open.filter((t) => t.priceSource === "fallback").map((t) => t.ticker),
  };
}

/** Lleva cualquiera de los dos formatos a uno solo: cantidad comprada + lista de ventas. */
export function normalize(t) {
  const qty = Number(t.qty);
  let sells;

  if (Array.isArray(t.sells)) {
    sells = t.sells.map((s) => ({ date: s.date, qty: Number(s.qty), price: Number(s.price) }));
  } else if (t.sellPrice != null || t.status === "closed") {
    sells = [{ date: t.sellDate, qty, price: Number(t.sellPrice) }];
  } else {
    sells = [];
  }

  sells.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { ...t, qty, buyPrice: Number(t.buyPrice), sells };
}

function enrich(t, priceMap) {
  const { qty, buyPrice, sells } = t;

  const soldQty = sells.reduce((a, s) => a + s.qty, 0);
  const openQty = qty - soldQty;
  const state = openQty <= EPS ? "closed" : soldQty > EPS ? "partial" : "open";

  let price, priceSource, quoteTime = null;
  const live = priceMap[t.ticker];
  if (live && typeof live.price === "number" && openQty > EPS) {
    price = live.price;
    priceSource = "live";
    quoteTime = live.quoteTime ?? null;
  } else {
    price = Number(t.lastPrice ?? sells[sells.length - 1]?.price ?? buyPrice);
    priceSource = state === "closed" ? "closed" : "fallback";
  }

  const costTotal = qty * buyPrice;
  const costOpen = openQty * buyPrice;
  const costSold = soldQty * buyPrice;
  const proceeds = sells.reduce((a, s) => a + s.qty * s.price, 0);

  const realized = proceeds - costSold;
  const marketValue = openQty * price;
  const unrealized = marketValue - costOpen;
  const pnl = realized + unrealized;

  const exits = sells.map((s, i) => ({
    tradeId: t.id,
    ticker: t.ticker,
    leg: sells.length > 1 ? `${i + 1} de ${sells.length}` : null,
    date: s.date,
    qty: s.qty,
    buyDate: t.buyDate,
    buyPrice,
    price: s.price,
    cost: s.qty * buyPrice,
    proceeds: s.qty * s.price,
    pnl: s.qty * (s.price - buyPrice),
    pnlPct: buyPrice ? (s.price - buyPrice) / buyPrice : 0,
    days: daysBetween(t.buyDate, s.date),
  }));

  const lastDate = sells.length ? sells[sells.length - 1].date : null;

  return {
    ...t,
    state,
    status: state, // compatibilidad con quien lea `status`
    soldQty,
    openQty,
    price,
    priceSource,
    quoteTime,
    costTotal,
    costOpen,
    costSold,
    proceeds,
    realized,
    unrealized,
    marketValue,
    pnl,
    pnlPct: costTotal ? pnl / costTotal : 0,
    exits,
    stopDistPct: t.stop ? (price - Number(t.stop)) / Number(t.stop) : null,
    belowStop: t.stop && openQty > EPS ? price < Number(t.stop) : false,
    days: daysBetween(t.buyDate, state === "closed" ? lastDate : todayISO()),
  };
}

function metrics(trades, exits, doc, cash, marketValue) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = losses.reduce((a, t) => a - t.pnl, 0);

  const start = doc.fund?.startDate ?? trades[0]?.buyDate;
  const days = Math.max(1, daysBetween(start, todayISO()));

  return {
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    hitRate: trades.length ? wins.length / trades.length : 0,
    exitCount: exits.length,
    exitHitRate: exits.length ? exits.filter((e) => e.pnl > 0).length / exits.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    grossWin,
    grossLoss,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    avgHoldExits: exits.length ? exits.reduce((a, e) => a + e.days, 0) / exits.length : 0,
    best: trades.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null),
    worst: trades.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null),
    days,
    avgDeployed: avgDeployed(doc, trades, days),
    exposure: cash + marketValue ? marketValue / (cash + marketValue) : 0,
  };
}

/** Capital promedio realmente invertido, ponderado por los días que estuvo invertido. */
function avgDeployed(doc, trades, days) {
  const events = [];
  for (const t of trades) {
    events.push({ date: t.buyDate, delta: t.costTotal });
    for (const s of t.sells) events.push({ date: s.date, delta: -s.qty * t.buyPrice });
  }
  events.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let deployed = 0;
  let acc = 0;
  let cursor = doc.fund?.startDate ?? events[0]?.date;
  for (const e of events) {
    acc += deployed * daysBetween(cursor, e.date);
    deployed += e.delta;
    cursor = e.date;
  }
  acc += deployed * daysBetween(cursor, todayISO());
  return days ? acc / days : 0;
}

/** Serie escalonada de caja vs. costo invertido: un punto por día con movimiento. */
function timeline(doc, trades, capital) {
  const flows = doc.cashFlows ?? [];
  const map = new Map();
  const push = (date, delta, pnl) => {
    const cur = map.get(date) ?? { date, delta: 0, pnl: 0 };
    cur.delta += delta;
    cur.pnl += pnl;
    map.set(date, cur);
  };

  for (const t of trades) {
    push(t.buyDate, t.costTotal, 0);
    for (const s of t.sells) push(s.date, -s.qty * t.buyPrice, s.qty * (s.price - t.buyPrice));
  }
  for (const f of flows) push(f.date, 0, Number(f.amount || 0));

  const days = [...map.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let invested = 0;
  let cash = capital - flows.reduce((a, f) => a + Number(f.amount || 0), 0);
  const out = [];
  for (const d of days) {
    invested += d.delta;
    cash += -d.delta + d.pnl;
    out.push({ date: d.date, invested, cash, book: invested + cash });
  }
  return out;
}

export function daysBetween(a, b) {
  if (!a || !b) return 0;
  return Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
