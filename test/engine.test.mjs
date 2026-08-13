import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeFund, normalize } from "../public/assets/engine.js";

const doc = JSON.parse(readFileSync(new URL("../public/data/portfolio.json", import.meta.url)));
const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const clone = (o) => JSON.parse(JSON.stringify(o));

test("sin cotizaciones en vivo usa los precios de respaldo", () => {
  const f = computeFund(doc);
  near(f.cash, 414.0814);
  near(f.marketValue, 679.32);
  near(f.total, 1093.4014);
  near(f.realized, 90.41);
  near(f.unrealized, 2.9914);
});

test("la identidad contable se cumple", () => {
  const f = computeFund(doc);
  near(f.cash + f.marketValue, f.capital + f.realized + f.unrealized);
});

test("las cotizaciones en vivo reemplazan el respaldo", () => {
  const f = computeFund(doc, { VST: { price: 150, quoteTime: null } });
  const vst = f.open.find((t) => t.ticker === "VST");
  assert.equal(vst.price, 150);
  assert.equal(vst.priceSource, "live");
  near(f.total, 1093.4014 + (150 - 145.16));
});

test("detecta posiciones bajo el stop", () => {
  const f = computeFund(doc);
  assert.deepEqual(f.open.filter((t) => t.belowStop).map((t) => t.ticker).sort(), ["ARDX", "VST"]);
});

test("profit factor y aciertos", () => {
  const { metrics } = computeFund(doc);
  near(metrics.profitFactor, 3.842, 0.01);
  assert.equal(metrics.winCount, 10);
  assert.equal(metrics.tradeCount, 15);
});

test("el formato antiguo se lee como una venta única", () => {
  const t = normalize({ ticker: "X", qty: 4, buyPrice: 10, status: "closed", sellDate: "2026-08-01", sellPrice: 12 });
  assert.equal(t.sells.length, 1);
  assert.deepEqual(t.sells[0], { date: "2026-08-01", qty: 4, price: 12 });
});

test("una venta parcial deja la posición abierta por el saldo", () => {
  const d = clone(doc);
  const ardx = d.trades.find((t) => t.ticker === "ARDX"); // 11 unidades a 5,035
  ardx.sells = [{ date: "2026-08-13", qty: 6, price: 4.10 }];

  const f = computeFund(d);
  const pos = f.open.find((t) => t.ticker === "ARDX");

  assert.equal(pos.state, "partial");
  near(pos.openQty, 5);
  near(pos.costOpen, 5 * 5.035);
  near(pos.realized, 6 * (4.1 - 5.035));
  near(pos.unrealized, 5 * (3.9 - 5.035));
  near(f.cash, 414.0814 + 6 * 4.1);
  near(f.cash + f.marketValue, f.capital + f.realized + f.unrealized);
});

test("varias ventas parciales que agotan la posición la cierran", () => {
  const d = clone(doc);
  const ardx = d.trades.find((t) => t.ticker === "ARDX");
  ardx.sells = [
    { date: "2026-08-13", qty: 6, price: 4.10 },
    { date: "2026-08-14", qty: 5, price: 4.50 },
  ];

  const f = computeFund(d);
  assert.equal(f.open.some((t) => t.ticker === "ARDX"), false);

  const trade = f.trades.find((t) => t.ticker === "ARDX");
  assert.equal(trade.state, "closed");
  near(trade.unrealized, 0);
  near(trade.realized, 6 * 4.1 + 5 * 4.5 - 11 * 5.035);
  assert.equal(f.exits.filter((e) => e.ticker === "ARDX").length, 2);
  near(f.cash + f.marketValue, f.capital + f.realized + f.unrealized);
});

test("los aportes de capital entran a la caja sin tocar el resultado", () => {
  const d = clone(doc);
  d.cashFlows = [{ date: "2026-08-13", amount: 500, note: "aporte" }];

  const f = computeFund(d);
  near(f.capital, 1500);
  near(f.cash, 414.0814 + 500);
  near(f.pnl, 93.4014);
  near(f.cash + f.marketValue, f.capital + f.realized + f.unrealized);
});
