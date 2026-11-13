const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const count = (value) => Math.round(Number(value) || 0);

function indicatorResult(result = {}) {
  return {
    value: finite(result.value),
    target: finite(result.target),
    status: typeof result.status === "string" ? result.status : "unknown",
    count: count(result.count),
  };
}

export function createIndicatorHistorySnapshot(dashboard) {
  const definitions = dashboard?.indicators || {};
  const indicators = Object.fromEntries(Object.entries(definitions).map(([id, item]) => [id, {
    label: String(item?.label || id),
    unit: item?.unit === "count" ? "count" : "percent",
    ...indicatorResult(item?.current),
  }]));
  const stores = (dashboard?.stores || []).map((store) => ({
    store: String(store?.store || ""),
    storeCode: store?.storeCode == null ? null : String(store.storeCode),
    indicators: Object.fromEntries(Object.keys(definitions).map((id) => [id, indicatorResult(store?.indicators?.[id])])),
  }));
  return { indicators, stores };
}

function orderStore(item = {}) {
  const retiradaRaw = Number(item.retirada) || 0;
  const entregaRaw = Number(item.entrega) || 0;
  const total = Math.round(retiradaRaw + entregaRaw);
  const retirada = Math.round(retiradaRaw);
  const entrega = total - retirada;
  return {
    store: String(item.store || ""),
    storeCode: item.storeCode == null ? null : String(item.storeCode),
    total,
    retirada,
    entrega,
    omni: count(item.omni),
    revendedor: count(item.revendedor),
    retiradaCancelados: count(item.retiradaCancelados),
    entregaCancelados: count(item.entregaCancelados),
    itens: count(item.itens),
    pctRetirada: total ? retirada / total : 0,
    pctEntrega: total ? entrega / total : 0,
  };
}

export function createOrdersHistorySnapshot(orders) {
  const stores = (orders?.stores || []).map(orderStore);
  const totals = stores.reduce((result, item) => {
    for (const key of ["total", "retirada", "entrega", "omni", "revendedor", "retiradaCancelados", "entregaCancelados", "itens"]) result[key] += item[key];
    return result;
  }, { total: 0, retirada: 0, entrega: 0, omni: 0, revendedor: 0, retiradaCancelados: 0, entregaCancelados: 0, itens: 0 });
  totals.pctRetirada = totals.total ? totals.retirada / totals.total : 0;
  totals.pctEntrega = totals.total ? totals.entrega / totals.total : 0;
  return {
    total: totals.total,
    retirada: totals.retirada,
    entrega: totals.entrega,
    omni: totals.omni,
    revendedor: totals.revendedor,
    retiradaCancelados: totals.retiradaCancelados,
    entregaCancelados: totals.entregaCancelados,
    itens: totals.itens,
    pctRetirada: totals.pctRetirada,
    pctEntrega: totals.pctEntrega,
    period: orders?.period || null,
    stores,
  };
}
