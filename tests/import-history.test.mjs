import test from "node:test";
import assert from "node:assert/strict";
import { createIndicatorHistorySnapshot, createOrdersHistorySnapshot } from "../server/import-history.mjs";

test("indicator history keeps headline values and per-store results only", () => {
  const snapshot = createIndicatorHistorySnapshot({
    indicators: { "pec-omni": { label: "PEC / OMNI", unit: "percent", current: { value: 0.99, target: 0.99, status: "good", count: 17 } } },
    stores: [{ store: "Loja A", storeCode: "100", indicators: { "pec-omni": { value: 0.95, target: 0.99, status: "bad", count: 3 } } }],
  });

  assert.equal(snapshot.indicators["pec-omni"].value, 0.99);
  assert.equal(snapshot.stores[0].indicators["pec-omni"].value, 0.95);
  assert.equal(Object.hasOwn(snapshot, "records"), false);
});

test("orders history uses integer non-canceled totals and recalculates shares", () => {
  const snapshot = createOrdersHistorySnapshot({ stores: [
    { store: "Loja A", storeCode: "100", total: 5, retirada: 2, entrega: 3, omni: 2, revendedor: 3, retiradaCancelados: 1, entregaCancelados: 1, itens: 12 },
    { store: "Loja B", storeCode: "200", total: 4, retirada: 1, entrega: 3, omni: 1, revendedor: 3, retiradaCancelados: 0, entregaCancelados: 2, itens: 8 },
  ] });

  assert.equal(snapshot.total, 9);
  assert.equal(snapshot.retirada + snapshot.entrega, snapshot.total);
  assert.equal(snapshot.retiradaCancelados + snapshot.entregaCancelados, 4);
  assert.equal(snapshot.pctRetirada + snapshot.pctEntrega, 1);
  assert.equal(snapshot.stores[0].total, 5);
});
