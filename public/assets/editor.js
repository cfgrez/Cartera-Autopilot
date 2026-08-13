import { computeFund, todayISO } from "./engine.js";

const money = new Intl.NumberFormat("es-CL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 4 });
const EPS = 1e-9;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const usd = (n) => (n < 0 ? "−" : "") + money.format(Math.abs(n));
const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + money.format(Math.abs(n));

let original = null; // documento tal como está en el repositorio
let draft = null;    // documento con los cambios de esta sesión
let log = [];

boot();

async function boot() {
  try {
    original = await (await fetch("data/portfolio.json", { cache: "no-store" })).json();
  } catch (err) {
    $("#status").textContent = `No se pudo leer data/portfolio.json: ${err.message}`;
    $("#status").className = "status warn";
    return;
  }

  draft = structuredClone(original);
  const restored = restore();

  $("#status").className = "status ok";
  $$("input[type=date]").forEach((i) => (i.value = todayISO()));

  wireTabs();
  wireBuy();
  wireSell();
  wireFlow();
  wireOutput();
  wireSave();

  refresh();
  if (restored) note(`Se recuperaron ${log.length} movimientos sin guardar de esta sesión.`);
}

/* ===================== pestañas ===================== */
function wireTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((t) => t.classList.toggle("is-on", t === tab));
      $$(".panel").forEach((p) => p.classList.toggle("is-on", p.id === `panel-${tab.dataset.panel}`));
    });
  });
}

/* ===================== compra ===================== */
function wireBuy() {
  const form = $("#panel-buy");

  form.addEventListener("input", () => {
    const { qty, price } = read(form);
    $("#buy-calc").textContent =
      qty > 0 && price > 0
        ? `Sale de caja US$ ${money.format(qty * price)} · quedarían US$ ${money.format(cashNow() - qty * price)}`
        : "—";
  });

  form.querySelector("[data-autostop]").addEventListener("click", () => {
    const price = Number(form.price.value);
    if (price > 0) form.stop.value = (price * 0.99).toFixed(4);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const { ticker, qty, price, date, stop } = read(form);

    if (!ticker) return fail("#buy-err", "Falta el ticker.");
    if (!(qty > 0)) return fail("#buy-err", "La cantidad debe ser mayor que cero.");
    if (!(price > 0)) return fail("#buy-err", "El precio debe ser mayor que cero.");
    if (!date) return fail("#buy-err", "Falta la fecha.");

    const cost = qty * price;
    if (cost > cashNow() + EPS) {
      return fail("#buy-err",
        `No alcanza la caja: la compra cuesta US$ ${money.format(cost)} y hay US$ ${money.format(cashNow())}. ` +
        `Si aportaste plata, regístrala primero en «Aporte o retiro».`);
    }

    const trade = {
      id: nextId(),
      ticker,
      qty,
      buyDate: date,
      buyPrice: price,
      status: "open",
      lastPrice: price,
    };
    if (stop > 0) trade.stop = stop;

    draft.trades.push(trade);
    record(`Compra · ${qtyFmt.format(qty)} ${ticker} a ${money.format(price)} el ${date} · −US$ ${money.format(cost)}`);
    form.reset();
    form.date.value = todayISO();
    $("#buy-calc").textContent = "—";
    clear("#buy-err");
    refresh();
  });
}

/* ===================== venta ===================== */
function wireSell() {
  const form = $("#panel-sell");

  form.tradeId.addEventListener("change", () => {
    const t = selected();
    if (!t) return;
    form.qty.value = qtyFmt.format(t.openQty).replace(",", ".");
    form.price.value = t.price;
    sellPreview();
  });

  form.addEventListener("input", sellPreview);

  $("#sell-quick").addEventListener("click", (e) => {
    const share = Number(e.target.dataset.share);
    if (!share) return;
    const t = selected();
    if (!t) return;
    const q = share === 1 ? t.openQty : round(t.openQty * share, 4);
    form.qty.value = String(q);
    sellPreview();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const t = selected();
    const { qty, price, date } = read(form);

    if (!t) return fail("#sell-err", "Elige una posición.");
    if (!(qty > 0)) return fail("#sell-err", "La cantidad debe ser mayor que cero.");
    if (qty > t.openQty + EPS) {
      return fail("#sell-err",
        `Solo quedan ${qtyFmt.format(t.openQty)} de ${t.ticker} sin vender.`);
    }
    if (!(price > 0)) return fail("#sell-err", "El precio debe ser mayor que cero.");
    if (!date) return fail("#sell-err", "Falta la fecha.");
    if (date < t.buyDate) {
      return fail("#sell-err", `La venta no puede ser anterior a la compra (${t.buyDate}).`);
    }

    const raw = draft.trades.find((x) => String(x.id) === String(t.id));
    migrate(raw);
    raw.sells.push({ date, qty, price });
    raw.sells.sort((a, b) => a.date.localeCompare(b.date));

    const rest = raw.qty - raw.sells.reduce((a, s) => a + s.qty, 0);
    raw.status = rest <= EPS ? "closed" : "open";
    if (rest <= EPS) delete raw.lastPrice;
    else raw.lastPrice = price;

    const partial = rest > EPS;
    record(
      `Venta${partial ? " parcial" : ""} · ${qtyFmt.format(qty)} ${t.ticker} a ${money.format(price)} el ${date} · ` +
      `+US$ ${money.format(qty * price)}${partial ? ` · quedan ${qtyFmt.format(rest)}` : ""}`
    );
    clear("#sell-err");
    refresh();
  });
}

function sellPreview() {
  const form = $("#panel-sell");
  const t = selected();
  const { qty, price } = read(form);

  if (!t) return ($("#sell-calc").textContent = "Elige una posición.");
  if (!(qty > 0) || !(price > 0)) {
    return ($("#sell-calc").textContent =
      `${t.ticker}: quedan ${qtyFmt.format(t.openQty)} a un costo de ${money.format(t.buyPrice)}.`);
  }

  const pnl = qty * (price - t.buyPrice);
  const rest = t.openQty - qty;
  $("#sell-calc").innerHTML =
    `Entra a caja US$ ${money.format(qty * price)} · resultado <b class="${pnl >= 0 ? "g" : "r"}">${signed(pnl)}</b> ` +
    `(${signed(((price - t.buyPrice) / t.buyPrice) * 100)}%) · ` +
    (rest > EPS
      ? `quedan ${qtyFmt.format(rest)} abiertas — <b>venta parcial</b>`
      : `cierra la posición completa`);
}

function selected() {
  const id = $("#panel-sell").tradeId.value;
  return computeFund(draft).open.find((t) => String(t.id) === id);
}

/** Lleva un trade del formato antiguo al de `sells` antes de agregarle una venta. */
function migrate(raw) {
  if (Array.isArray(raw.sells)) return;
  raw.sells = raw.sellPrice != null
    ? [{ date: raw.sellDate, qty: raw.qty, price: raw.sellPrice }]
    : [];
  delete raw.sellDate;
  delete raw.sellPrice;
}

/* ===================== aporte / retiro ===================== */
function wireFlow() {
  const form = $("#panel-flow");

  form.addEventListener("input", () => {
    const { amount, kind } = read(form);
    if (!(amount > 0)) return ($("#flow-calc").textContent = "—");
    const delta = kind === "out" ? -amount : amount;
    $("#flow-calc").textContent =
      `La caja pasaría de US$ ${money.format(cashNow())} a US$ ${money.format(cashNow() + delta)}.`;
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const { amount, kind, date, note: text } = read(form);

    if (!(amount > 0)) return fail("#flow-err", "El monto debe ser mayor que cero.");
    if (!date) return fail("#flow-err", "Falta la fecha.");

    const delta = kind === "out" ? -amount : amount;
    if (kind === "out" && amount > cashNow() + EPS) {
      return fail("#flow-err",
        `No puedes retirar US$ ${money.format(amount)}: hay US$ ${money.format(cashNow())} en caja.`);
    }

    draft.cashFlows = draft.cashFlows ?? [];
    draft.cashFlows.push({ date, amount: delta, note: text || (kind === "out" ? "retiro" : "aporte") });
    draft.cashFlows.sort((a, b) => a.date.localeCompare(b.date));

    record(`${kind === "out" ? "Retiro" : "Aporte"} · US$ ${money.format(amount)} el ${date}`);
    form.reset();
    form.date.value = todayISO();
    $("#flow-calc").textContent = "—";
    clear("#flow-err");
    refresh();
  });
}

/* ===================== salida ===================== */
function wireOutput() {
  $("#copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(json());
      hint("Copiado. Pégalo en public/data/portfolio.json");
    } catch {
      hint("No se pudo copiar: selecciona el texto de abajo y cópialo a mano.");
    }
  });

  $("#download").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([json()], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "portfolio.json";
    a.click();
    URL.revokeObjectURL(url);
    hint("Descargado. Reemplaza el archivo en el repositorio.");
  });

  $("#reset").addEventListener("click", () => {
    if (!log.length) return;
    if (!confirm(`Se descartarán ${log.length} movimientos. ¿Seguro?`)) return;
    draft = structuredClone(original);
    log = [];
    persist();
    refresh();
    hint("Cambios descartados.");
  });
}

/* ===================== guardar en GitHub ===================== */
const TOKEN_KEY = "autopilot-edit-token";

async function wireSave() {
  const btn = $("#save");

  let enabled = false;
  try {
    enabled = (await (await fetch("/api/save")).json())?.enabled === true;
  } catch { /* sin API: queda el flujo manual */ }

  if (!enabled) return;

  btn.hidden = false;
  $("#save-help").innerHTML =
    "Con <b>Guardar en GitHub</b> el Worker hace el commit por ti y Cloudflare " +
    "redespliega solo. Copiar y pegar a mano sigue funcionando igual.";
  syncForget();

  btn.addEventListener("click", () => save());
  $("#forget").addEventListener("click", () => {
    localStorage.removeItem(TOKEN_KEY);
    syncForget();
    hint("Clave olvidada en este dispositivo.");
  });
}

function syncForget() {
  $("#forget").hidden = !localStorage.getItem(TOKEN_KEY);
}

async function save() {
  if (!log.length) return hint("No hay movimientos que guardar.");

  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = prompt("Clave de edición:");
    if (!token) return;
  }

  const btn = $("#save");
  btn.disabled = true;
  btn.textContent = "Guardando…";
  said("");

  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "content-type": "application/json", "x-edit-token": token },
      body: JSON.stringify({ portfolio: draft, message: commitMessage() }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      syncForget();
      return said("Clave incorrecta. Vuelve a intentar.", true);
    }
    if (!res.ok) return said(data.error ?? `Error ${res.status} al guardar.`, true);

    localStorage.setItem(TOKEN_KEY, token);
    syncForget();

    // El movimiento ya está en el repositorio: pasa a ser el punto de partida.
    original = structuredClone(draft);
    log = [];
    refresh();

    const link = data.url ? ` <a href="${data.url}" target="_blank" rel="noopener">${data.commit}</a>` : "";
    said(
      `Guardado en GitHub${link}. Cloudflare está redesplegando: el dashboard ` +
      `muestra los cambios en un par de minutos.`
    );
  } catch (err) {
    said(`No se pudo contactar al servidor: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Guardar en GitHub";
  }
}

function commitMessage() {
  if (log.length === 1) return log[0].split(" · ").slice(0, 2).join(" · ");
  return `${log.length} movimientos: ` +
    log.map((m) => m.split(" · ")[1] ?? m).join("; ").slice(0, 140);
}

function said(html, isError = false) {
  const n = $("#saved");
  n.hidden = !html;
  n.innerHTML = html;
  n.className = "saved" + (isError ? " bad" : "");
}

/* ===================== render ===================== */
function refresh() {
  const before = computeFund(original);
  const after = computeFund(draft);

  // selector de posiciones abiertas
  const sel = $("#panel-sell").tradeId;
  const keep = sel.value;
  sel.innerHTML = after.open.length
    ? after.open
        .map((t) => `<option value="${t.id}">${t.ticker} — quedan ${qtyFmt.format(t.openQty)} a ${money.format(t.buyPrice)}</option>`)
        .join("")
    : `<option value="">No hay posiciones abiertas</option>`;
  if (after.open.some((t) => String(t.id) === keep)) sel.value = keep;

  $("#sell-quick").innerHTML = after.open.length
    ? `<span>Vender:</span>` +
      [[0.25, "25%"], [0.5, "50%"], [0.75, "75%"], [1, "todo"]]
        .map(([v, l]) => `<button type="button" class="chip-btn" data-share="${v}">${l}</button>`)
        .join("")
    : "";
  sellPreview();

  // diferencias
  const rows = [
    ["Patrimonio", before.total, after.total],
    ["Caja", before.cash, after.cash],
    ["En mercado", before.marketValue, after.marketValue],
    ["Capital aportado", before.capital, after.capital],
    ["Resultado realizado", before.realized, after.realized],
    ["Resultado no realizado", before.unrealized, after.unrealized],
  ];
  $("#diff-body").innerHTML = rows
    .map(([k, a, b]) => {
      const d = b - a;
      const kls = Math.abs(d) < 0.005 ? "m" : d > 0 ? "g" : "r";
      return `<tr><td>${k}</td><td class="m">${usd(a)}</td><td>${usd(b)}</td>` +
        `<td class="${kls}">${Math.abs(d) < 0.005 ? "—" : signed(d)}</td></tr>`;
    })
    .join("");

  // bitácora
  $("#log-section").hidden = log.length === 0;
  $("#log-count").textContent = String(log.length);
  $("#log").innerHTML = log.map((m) => `<li>${m}</li>`).join("");
  $("#pending").textContent = log.length
    ? `${log.length} movimiento${log.length > 1 ? "s" : ""} sin guardar`
    : "sin cambios";
  $("#pending").className = "tag" + (log.length ? " pending" : "");

  $("#json").textContent = json();
  persist();
}

/* ===================== utilidades ===================== */
const cashNow = () => computeFund(draft).cash;
const json = () => JSON.stringify(draft, null, 2) + "\n";
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

function nextId() {
  return draft.trades.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;
}

function read(form) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    o[el.name] = el.type === "number" ? Number(el.value) : el.value.trim();
  }
  if (o.ticker) o.ticker = o.ticker.toUpperCase();
  return o;
}

function record(text) {
  log.push(text);
}

function fail(sel, msg) {
  const n = $(sel);
  n.textContent = msg;
  n.hidden = false;
}

function clear(sel) {
  $(sel).hidden = true;
}

function hint(text) {
  $("#copy-hint").textContent = text;
  setTimeout(() => ($("#copy-hint").textContent = ""), 4000);
}

function note(text) {
  $("#status").textContent = text;
  $("#status").className = "status warn";
}

/* Los cambios sobreviven a un refresco accidental del navegador. */
const KEY = "autopilot-draft";

function persist() {
  try {
    if (!log.length) sessionStorage.removeItem(KEY);
    else sessionStorage.setItem(KEY, JSON.stringify({ draft, log }));
  } catch { /* modo privado: se pierde, no importa */ }
}

function restore() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return false;
    const saved = JSON.parse(raw);
    if (!saved?.draft || !saved?.log?.length) return false;
    draft = saved.draft;
    log = saved.log;
    return true;
  } catch {
    return false;
  }
}
