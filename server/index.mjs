import fs from "node:fs";
import chokidar from "chokidar";
import cors from "cors";
import express from "express";
import { findDefaultWorkbook, parseWorkbook } from "./parser.mjs";

const PORT = Number(process.env.OPERATIONS_API_PORT || 8788);
const workbookPath = findDefaultWorkbook();
const app = express();
let cache = null;
let loading = null;
let lastError = null;

app.use(cors({ origin: true }));
app.post("/api/orders/upload", express.raw({ type: () => true, limit: "300mb" }), async (request, response) => {
  try {
    const originalName = String(request.headers["x-file-name"] || "pedidos-importados.xlsx").replace(/[^\w.\- ]/g, "_");
    const extension = originalName.toLowerCase().endsWith(".csv") ? "csv" : "xlsx";
    const target = new URL(`../data/pedidos-importados.${extension}`, import.meta.url);
    fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
    const previousOrders = cache?.orders;
    if (fs.existsSync(target)) {
      const archive = new URL(`../data/pedidos-importados-historico-${Date.now()}.${extension}`, import.meta.url);
      fs.copyFileSync(target, archive);
    }
    fs.writeFileSync(target, request.body);
    const previous = new URL(`../data/pedidos-importados.${extension === "csv" ? "xlsx" : "csv"}`, import.meta.url);
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    // Durante um upload, sempre usamos somente o lote recém-escrito.
    // O acumulado persistido é carregado apenas no ciclo normal de leitura;
    // carregá-lo aqui faria o lote anterior ser somado novamente.
    const next = await refresh("orders-upload", { usePersistedOrders: false });
    if (previousOrders && next.orders && !next.orders.error) {
      next.orders = mergeOrderSummaries(previousOrders, next.orders);
      cache.orders = next.orders;
    }
    if (next.orders && !next.orders.error) fs.writeFileSync(new URL("../data/pedidos-cumulativos.json", import.meta.url), JSON.stringify(next.orders));
    fs.writeFileSync(new URL("../data/ultima-importacao-pedidos.json", import.meta.url), JSON.stringify({ importedAt: new Date().toISOString(), fileName: originalName }));
    if (next.orders?.error) return response.status(400).json({ error: next.orders.error });
    response.json({ ok: true, fileName: next.orders?.source?.fileName || "pedidos-importados.xlsx" });
  } catch (error) {
    response.status(400).json({ error: `Falha ao importar planilha de pedidos: ${error.message}` });
  }
});

function mergeOrderSummaries(previous, current) {
  const stores = new Map((previous.stores || []).map((item) => [item.storeCode, { ...item, revendedorCategorias: { ...(item.revendedorCategorias || {}) }, cancelamentoMotivos: { ...(item.cancelamentoMotivos || {}) }, cancelamentoFiscal: { ...(item.cancelamentoFiscal || {}) } }]));
  for (const item of current.stores || []) {
    const target = stores.get(item.storeCode) || { ...item, total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, itens: 0, retiradaCancelados: 0, entregaCancelados: 0, revendedorCategorias: {}, cancelamentoMotivos: {}, cancelamentoFiscal: {} };
    for (const key of ["total", "retirada", "entrega", "revendedor", "omni", "itens", "retiradaCancelados", "entregaCancelados"]) target[key] = Number(target[key] || 0) + Number(item[key] || 0);
    for (const [key, value] of Object.entries(item.revendedorCategorias || {})) target.revendedorCategorias[key] = Number(target.revendedorCategorias[key] || 0) + Number(value || 0);
    for (const field of ["cancelamentoMotivos", "cancelamentoFiscal"]) for (const [key, value] of Object.entries(item[field] || {})) { const pair = value; const prev = target[field][key] || [0, 0]; target[field][key] = [prev[0] + Number(pair[0] || 0), prev[1] + Number(pair[1] || 0)]; }
    stores.set(item.storeCode, target);
  }
  const days = Math.max(1, new Set([...(previous.daily || []), ...(current.daily || [])].map((item) => item.date)).size);
  const mergedStores = [...stores.values()].map((item) => ({ ...item, pctEntrega: item.total ? item.entrega / item.total : 0, pctRetirada: item.total ? item.retirada / item.total : 0, mediaRetirada: item.retirada / days, mediaEntrega: item.entrega / days, mediaOmni: item.omni / days, mediaItens: item.itens / days })).sort((a, b) => b.total - a.total);
  const recordMap = new Map();
  for (const record of [...(previous.records || []), ...(current.records || [])]) {
    const key = String(record.orderCode || `${record.storeCode || record.store}|${record.date || ""}|${record.reseller || ""}|${record.value || 0}`);
    if (!recordMap.has(key)) recordMap.set(key, record);
  }
  return { ...current, source: { ...current.source, lastImportAt: new Date().toISOString() }, period: { start: [previous.period?.start, current.period?.start].filter(Boolean).sort()[0] || null, end: [previous.period?.end, current.period?.end].filter(Boolean).sort().at(-1) || null, days }, stores: mergedStores, daily: [...(previous.daily || []), ...(current.daily || [])], records: [...recordMap.values()] };
}

function usableOrderTotal(snapshot) {
  return (snapshot?.stores || []).reduce((sum, item) => sum + Number(item.total || 0), 0);
}

function loadPersistedOrders(cumulativeFile, currentOrders) {
  if (!fs.existsSync(cumulativeFile)) return currentOrders;
  try {
    const savedOrders = JSON.parse(fs.readFileSync(cumulativeFile, "utf8"));
    if (!savedOrders?.stores?.length) return currentOrders;
    // Nunca regride para um acumulado menor que o backup de segurança.
    // Isso evita que uma importação parcial substitua todo o histórico.
    const backupFile = new URL("../data/pedidos-cumulativos-duplicado-backup.json", import.meta.url);
    if (fs.existsSync(backupFile)) {
      const backupOrders = JSON.parse(fs.readFileSync(backupFile, "utf8"));
      if (usableOrderTotal(savedOrders) < usableOrderTotal(backupOrders)) {
        return mergeOrderSummaries(backupOrders, currentOrders);
      }
    }
    return savedOrders;
  } catch {
    return currentOrders;
  }
}
app.use(express.json());

async function refresh(reason = "manual", options = {}) {
  if (loading) return loading;
  loading = Promise.resolve().then(() => {
    if (!workbookPath || !fs.existsSync(workbookPath)) {
      throw new Error(`Arquivo Excel não encontrado: ${workbookPath || "caminho não configurado"}`);
    }
    const next = parseWorkbook(workbookPath);
    const cumulativeFile = new URL("../data/pedidos-cumulativos.json", import.meta.url);
    if (options.usePersistedOrders !== false) next.orders = loadPersistedOrders(cumulativeFile, next.orders);
    cache = { ...next, meta: { ...next.meta, refreshReason: reason, loadedAt: new Date().toISOString() } };
    lastError = null;
    return cache;
  }).catch((error) => {
    lastError = { message: error.message, at: new Date().toISOString() };
    throw error;
  }).finally(() => {
    loading = null;
  });
  return loading;
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: Boolean(cache),
    source: workbookPath,
    lastError,
    modifiedAt: cache?.source?.modifiedAt ?? null,
    loadedAt: cache?.meta?.loadedAt ?? null,
  });
});

app.get("/api/dashboard", async (_request, response) => {
  try {
    if (!cache) await refresh("startup");
    response.json(cache);
  } catch (error) {
    response.status(503).json({ error: error.message, lastError });
  }
});

app.post("/api/refresh", async (_request, response) => {
  try {
    response.json(await refresh("manual"));
  } catch (error) {
    response.status(500).json({ error: error.message, lastError });
  }
});

app.get("/api/indicators/:id", async (request, response) => {
  try {
    if (!cache) await refresh("startup");
    const indicator = cache.indicators[request.params.id];
    if (!indicator) return response.status(404).json({ error: "Indicador não encontrado" });
    response.json({ source: cache.source, indicator });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get("/api/stores/:store", async (request, response) => {
  try {
    if (!cache) await refresh("startup");
    const name = decodeURIComponent(request.params.store);
    const store = cache.stores.find((item) => item.store === name);
    if (!store) return response.status(404).json({ error: "Loja não encontrada" });
    const details = Object.fromEntries(Object.entries(cache.indicators).map(([id, indicator]) => [
      id,
      { ...store.indicators[id], records: indicator.records.filter((item) => item.store === name) },
    ]));
    response.json({ source: cache.source, store: name, indicators: details });
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

// Abra a porta imediatamente; o carregamento de uma planilha grande pode levar alguns minutos.
// Assim a interface recebe uma resposta 503 controlada (e pode tentar novamente), em vez de "Failed to fetch".
app.listen(PORT, "127.0.0.1", () => {
  console.log(`API de Operações: http://127.0.0.1:${PORT}`);
  console.log(`Fonte: ${workbookPath}`);
});

refresh("startup").catch((error) => {
  console.error("[dados] Falha inicial:", error.message);
});

if (workbookPath) {
  chokidar.watch(workbookPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 } })
    .on("change", () => refresh("file-change").then(() => console.log("[dados] Cache atualizado após alteração do Excel")).catch((error) => console.error(error)))
    .on("add", () => refresh("file-added").catch((error) => console.error(error)));
}

setInterval(() => {
  if (!workbookPath || !fs.existsSync(workbookPath)) return;
  const modifiedAt = fs.statSync(workbookPath).mtime.toISOString();
  if (modifiedAt !== cache?.source?.modifiedAt) refresh("periodic-check").catch((error) => console.error(error));
}, 5 * 60 * 1000).unref();

