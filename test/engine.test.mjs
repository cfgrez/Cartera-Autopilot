import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeFund } from "../public/assets/engine.js";

const doc = JSON.parse(readFileSync(new URL("../public/data/portfolio.json", import.meta.url)));
const near = (a, b, tol = 0.005) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

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
  const below = f.open.filter((t) => t.belowStop).map((t) => t.ticker).sort();
  assert.deepEqual(below, ["ARDX", "VST"]);
});

test("profit factor y aciertos", () => {
  const { metrics } = computeFund(doc);
  near(metrics.profitFactor, 3.842, 0.01);
  assert.equal(metrics.winCount, 10);
  assert.equal(metrics.tradeCount, 15);
});
