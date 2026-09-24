import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { INDICATORS, findDefaultWorkbook, parseWorkbook } from "../server/parser.mjs";

const workbookPath = findDefaultWorkbook();
const before = fs.statSync(workbookPath);
const data = parseWorkbook(workbookPath);
const cyclePeriods = JSON.parse(fs.readFileSync(new URL("../config/cycles.json", import.meta.url), "utf8"));

test("resolve exatamente as 11 fontes solicitadas", () => {
  assert.equal(Object.keys(data.source.resolvedSheets).length, 11);
  assert.deepEqual(Object.keys(data.indicators).sort(), INDICATORS.map((item) => item.id).sort());
});

test("normaliza a dimensão de lojas sem duplicar variações de grafia", () => {
  assert.equal(data.meta.storeCount, 14);
  assert.equal(new Set(data.filters.stores.map((store) => store.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase())).size, 14);
  assert.ok(data.filters.stores.includes("Além Paraíba"));
  assert.ok(data.filters.stores.includes("Leopoldina"));
});

test("seleciona o ciclo numérico mais recente, não a ordem lexicográfica", () => {
  assert.equal(data.indicators.medallia.latestKey, 12);
  assert.equal(data.indicators["pec-omni"].latestKey, 12);
  assert.ok(data.indicators.medallia.current.value >= 0 && data.indicators.medallia.current.value <= 1);
});

test("calcula quebra ponderada pelos itens vendidos", () => {
  const current = data.indicators["quebra-estoque"].current;
  assert.ok(current.value > 0 && current.value < 0.02);
  assert.equal(current.count, 10);
});

test("avalia o SLA agregado de recebimento pela meta, não pelo primeiro registro", () => {
  const current = data.indicators.recebimento.current;
  assert.equal(current.target, 1);
  assert.ok(current.value < current.target);
  assert.equal(current.status, "bad");
});

test("aplica as metas operacionais aprovadas sem faixa de tolerância inventada", () => {
  const expected = {
    "pec-omni": [0.99, "bad"], medallia: [0.93, "good"],
    "plataforma-logistica": [0.93, "good"], arruamento: [0.92, "bad"],
    retirada: [3, "unknown"], trilogo: [2, "bad"], "quebra-estoque": [0.01, "good"],
  };
  for (const [id, [target, status]] of Object.entries(expected)) {
    assert.ok(Math.abs(data.indicators[id].current.target - target) < 1e-9, `${id}: meta incorreta`);
    assert.equal(data.indicators[id].current.status, status, `${id}: status incorreto`);
  }
});

test("contabiliza Retirada como pedidos e Trilogo como chamados", () => {
  const retirada = data.indicators.retirada;
  const trilogo = data.indicators.trilogo;
  assert.equal(retirada.current.value, null);
  assert.equal(retirada.current.status, "unknown");
  const latestScores = retirada.records.filter((row) => row.cycle === retirada.latestKey);
  for (const store of retirada.ranking) {
    assert.equal(store.value, latestScores.filter((row) => row.store === store.store).length, `${store.store}: pontuações divergentes`);
  }
  assert.equal(trilogo.current.value, trilogo.ranking.reduce((sum, row) => sum + Number(row.value || 0), 0));
  assert.ok(retirada.records.every((row) => row.unit === "count" && row.value === 1));
  assert.ok(retirada.records.every((row) => ["sem_separacao_apos_16h", "sem_cancelamento"].includes(row.raw.scoreType)));
  assert.equal(retirada.records.filter((row) => row.store === "Benfica" && row.cycle === 2 && row.date?.startsWith("2026-01-27")).length, 2);
  assert.ok(trilogo.records.every((row) => row.unit === "count" && row.value === 1));
});

test("aplica as metas dos indicadores de saldo e cancelamento", () => {
  assert.equal(data.indicators["saldo-pedidos"].current.target, 1);
  assert.ok(Math.abs(data.indicators["retirada-cancelados"].current.target - 0.02) < 1e-9);
  assert.ok(Math.abs(data.indicators["entrega-cancelados"].current.target - 0.02) < 1e-9);
});

test("lista as 14 lojas em todos os rankings, sempre em ordem decrescente", () => {
  for (const indicator of Object.values(data.indicators)) {
    assert.equal(indicator.ranking.length, 14, `${indicator.id}: ranking incompleto`);
    const values = indicator.ranking.map((row) => row.value).filter((value) => value != null);
    assert.deepEqual(values, [...values].sort((a, b) => b - a), `${indicator.id}: ordem incorreta`);
  }
});

test("trata ausência de Retirada ou Trilogo como zero dentro da meta", () => {
  for (const id of ["retirada", "trilogo"]) {
    const zeros = data.indicators[id].ranking.filter((row) => row.value === 0);
    assert.ok(zeros.length > 0, `${id}: nenhuma loja sem ocorrência`);
    assert.ok(zeros.every((row) => row.target === data.indicators[id].current.target && row.status === "good"), `${id}: zero não ficou dentro da meta`);
  }
});

test("usa Saldo total como percentual direto", () => {
  const saldo = data.indicators["saldo-pedidos"];
  const latestRows = saldo.records.filter((row) => row.date === saldo.latestKey && row.value != null && row.volume > 0);
  const expected = latestRows.reduce((sum, row) => sum + row.value * row.volume, 0) / latestRows.reduce((sum, row) => sum + row.volume, 0);
  assert.ok(Math.abs(saldo.current.value - expected) < 1e-9);
  assert.ok(saldo.records.every((row) => row.value >= 0 && row.value <= 1 && row.raw.sourceSaldoTotal != null));
  for (const id of ["retirada-cancelados", "entrega-cancelados"]) {
    const indicator = data.indicators[id];
    assert.ok(indicator.records.every((row) => Math.abs(row.value - row.raw.sourceSaldoTotal) < 1e-9));
    assert.ok(indicator.current.value >= 0 && indicator.current.value <= 1);
  }
});

test("expõe o código ao lado de todas as lojas", () => {
  assert.ok(data.stores.every((row) => /^\d{5}$/.test(row.storeCode)));
  for (const indicator of Object.values(data.indicators)) {
    assert.ok(indicator.ranking.every((row) => /^\d{5}$/.test(row.storeCode)), `${indicator.id}: código ausente`);
  }
});

test("mapeia os 17 ciclos para os intervalos oficiais de 2026", () => {
  assert.equal(Object.keys(cyclePeriods).length, 17);
  assert.deepEqual(cyclePeriods["12"], { start: "2026-08-10", end: "2026-08-30" });
  assert.deepEqual(cyclePeriods["17"], { start: "2026-11-30", end: "2026-12-25" });
  for (let cycle = 2; cycle <= 17; cycle += 1) {
    const previousEnd = new Date(`${cyclePeriods[String(cycle - 1)].end}T00:00:00Z`);
    previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
    assert.equal(previousEnd.toISOString().slice(0, 10), cyclePeriods[String(cycle)].start, `lacuna entre ciclos ${cycle - 1} e ${cycle}`);
  }
});

test("não altera a planilha original durante a leitura", () => {
  const after = fs.statSync(workbookPath);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});
