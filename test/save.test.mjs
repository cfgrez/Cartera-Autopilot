import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate } from "../src/save.js";

const doc = JSON.parse(readFileSync(new URL("../public/data/portfolio.json", import.meta.url)));
const clone = () => JSON.parse(JSON.stringify(doc));

test("la cartera actual pasa la validación", () => {
  assert.equal(validate(doc), null);
});

test("rechaza un cuerpo que no es una cartera", () => {
  assert.match(validate(null), /portfolio/);
  assert.match(validate({ fund: {}, trades: [] }), /initialCapital/);
  assert.match(validate({ fund: { initialCapital: 1000 } }), /trades/);
});

test("rechaza una operación sin ticker o con cantidad inválida", () => {
  const d = clone();
  d.trades[0].ticker = "";
  assert.match(validate(d), /ticker/);

  const e = clone();
  e.trades[0].qty = 0;
  assert.match(validate(e), /cantidad/);
});

test("rechaza vender más de lo comprado", () => {
  const d = clone();
  const t = d.trades.find((x) => x.ticker === "ARDX"); // 11 unidades
  t.sells = [{ date: "2026-08-14", qty: 12, price: 4 }];
  assert.match(validate(d), /suman más unidades/);
});

test("rechaza una venta anterior a la compra", () => {
  const d = clone();
  const t = d.trades.find((x) => x.ticker === "ARDX");
  t.sells = [{ date: "2026-07-01", qty: 2, price: 4 }];
  assert.match(validate(d), /anterior a la compra/);
});

test("rechaza una compra que deja la caja negativa", () => {
  const d = clone();
  d.trades.push({ id: 99, ticker: "BRK.A", qty: 1, buyDate: "2026-08-14", buyPrice: 700000, status: "open" });
  assert.match(validate(d), /caja quedaría/);
});

test("acepta una venta parcial legítima", () => {
  const d = clone();
  const t = d.trades.find((x) => x.ticker === "ARDX");
  t.sells = [{ date: "2026-08-14", qty: 6, price: 4.1 }];
  assert.equal(validate(d), null);
});
