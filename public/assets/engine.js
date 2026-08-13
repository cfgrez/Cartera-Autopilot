/**
 * Motor de cálculo del fondo. Funciones puras: reciben datos, devuelven datos.
 * No toca el DOM, así que se puede probar por separado.
 *
 * Identidad que siempre debe cumplirse:
 *   patrimonio = caja + valor de mercado
 *   patrimonio = capital aportado + resultado realizado + resultado no realizado
 */

export function computeFund(doc, priceMap = {}) {
  const initial = Number(doc.fund?.initialCapital ?? 0);
  const flows = (doc.cashFlows ?? []).reduce((a, f) => a + Number(f.amount || 0), 0);
  const capital = initial + flows;

  const trades = (doc.trades ?? []).map((t) => enrich(t, priceMap));

  const open = trades.filter((t) => t.status === "open");
  const closed = trades.filter((t) => t.status === "closed");

  const investedTotal = trades.reduce((a, t) => a + t.cost, 0); // todo lo que salió de caja
  const proceeds = closed.reduce((a, t) => a + t.proceeds, 0); // todo lo que volvió a caja
  const cash = capital - investedTotal + proceeds;

  const marketValue = open.reduce((a, t) => a + t.marketValue, 0);
  const openCost = open.reduce((a, t) => a + t.cost, 0);

  const realized = closed.reduce((a, t) => a + t.pnl, 0);
  const unrealized = open.reduce((a, t) => a + t.pnl, 0);

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
    closed: [...closed].sort((a, b) => b.pnl - a.pnl),
    byContribution: [...trades].sort((a, b) => b.pnl - a.pnl),
    metrics: metrics(trades, closed, capital, doc, cash, marketValue),
    timeline: timeline(doc, trades, capital),
    stale: open.filter((t) => t.priceSource === "fallback").map((t) => t.ticker),
  };
}

function enrich(t, priceMap) {
  const qty = Number(t.qty);
  const buyPrice = Number(t.buyPrice);
  const cost = qty * buyPrice;
  const isOpen = t.status !== "closed";

  let price, priceSource, quoteTime = null;
  if (isOpen) {
    const live = priceMap[t.ticker];
    if (live && typeof live.price === "number") {
      price = live.price;
      priceSource = "live";
      quoteTime = live.quoteTime ?? null;
    } else {
      price = Number(t.lastPrice ?? buyPrice);
      priceSource = "fallback";
    }
  } else {
    price = Number(t.sellPrice);
    priceSource = "closed";
  }

  const value = qty * price;
  const pnl = value - cost;

  return {
    ...t,
    qty,
    buyPrice,
    price,
    priceSource,
    quoteTime,
    cost,
    marketValue: isOpen ? value : 0,
    proceeds: isOpen ? 0 : value,
    pnl,
    pnlPct: cost ? pnl / cost : 0,
    stopDistPct: t.stop ? (price - Number(t.stop)) / Number(t.stop) : null,
    belowStop: t.stop ? price < Number(t.stop) : false,
    days: daysBetween(t.buyDate, t.sellDate ?? todayISO()),
  };
}

function metrics(trades, closed, capital, doc, cash, marketValue) {
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
    closedHitRate: closed.length ? closed.filter((t) => t.pnl > 0).length / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    grossWin,
    grossLoss,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    avgHoldClosed: closed.length ? closed.reduce((a, t) => a + t.days, 0) / closed.length : 0,
    best: trades.reduce((b, t) => (!b || t.pnl > b.pnl ? t : b), null),
    worst: trades.reduce((b, t) => (!b || t.pnl < b.pnl ? t : b), null),
    days,
    avgDeployed: avgDeployed(doc, trades, days),
    exposure: cash + marketValue ? marketValue / (cash + marketValue) : 0,
  };
}

/** Capital promedio realmente invertido, ponderado por tiempo. */
function avgDeployed(doc, trades, days) {
  const events = [];
  for (const t of trades) {
    events.push({ date: t.buyDate, delta: t.cost });
    if (t.status === "closed") events.push({ date: t.sellDate, delta: -t.cost });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  let deployed = 0;
  let acc = 0;
  let cursor = doc.fund?.startDate ?? events[0]?.date;
  for (const e of events) {
    const span = daysBetween(cursor, e.date);
    acc += deployed * span;
    deployed += e.delta;
    cursor = e.date;
  }
  acc += deployed * daysBetween(cursor, todayISO());
  return days ? acc / days : 0;
}

/** Serie escalonada de caja vs. costo invertido, un punto por día con movimiento. */
function timeline(doc, trades, capital) {
  const map = new Map();
  const push = (date, delta, pnl) => {
    const cur = map.get(date) ?? { date, delta: 0, pnl: 0 };
    cur.delta += delta;
    cur.pnl += pnl;
    map.set(date, cur);
  };

  for (const t of trades) {
    push(t.buyDate, t.cost, 0);
    if (t.status === "closed") push(t.sellDate, -t.cost, t.pnl);
  }

  const days = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
  let invested = 0;
  let cash = capital;
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
  const ms = new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z");
  return Math.round(ms / 86400000);
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
