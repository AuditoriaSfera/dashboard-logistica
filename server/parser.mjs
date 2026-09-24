import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import XLSX from "xlsx";

const metricConfig = JSON.parse(fs.readFileSync(new URL("../config/metrics.json", import.meta.url), "utf8"));
let ordersMemo = null;
const ZERO_WHEN_ABSENT = new Set(["retirada", "trilogo"]);
export const INDICATORS = Object.entries(metricConfig).map(([id, config]) => ({
  id, label: config.label, direction: config.direction, alias: config.sheetAlias,
  configuredTarget: config.target, scoreWeight: config.scoreWeight, unit: config.unit ?? "percent",
}));

export const normalizeText = (value) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();

const number = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\s/g, "").replace("%", "");
  if (!raw) return null;
  const parsed = Number(raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const ratio = (value) => {
  const n = number(value);
  return n == null ? null : Math.abs(n) > 1.5 ? n / 100 : n;
};

const excelDate = (value) => {
  if (value == null || value === "") return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === "number" && value > 20000 && value < 80000) {
    const d = XLSX.SSF.parse_date_code(value);
    if (d) return new Date(Date.UTC(d.y, d.m - 1, d.d)).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};

const storeParts = (value, explicitCode) => {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4,6})\s+(.+)$/);
  const codeOnly = text.match(/^\d{4,6}$/)?.[0] ?? null;
  return {
    code: explicitCode != null && String(explicitCode).trim() ? String(explicitCode).trim() : match?.[1] ?? codeOnly,
    name: (match?.[2] ?? text).replace(/^ER\s+/i, "").trim() || "Loja não identificada",
  };
};

const rowsOf = (sheet) => XLSX.utils.sheet_to_json(sheet, {
  header: 1, defval: null, raw: true, blankrows: false,
});

const findHeader = (rows, terms, limit = 35) => {
  let winner = { index: 0, score: -1 };
  rows.slice(0, limit).forEach((row, index) => {
    const values = row.map(normalizeText);
    const score = terms.filter((term) => values.some((value) => value.includes(term))).length;
    if (score > winner.score) winner = { index, score };
  });
  return winner.index;
};

const findColumn = (headers, terms) => headers.map(normalizeText)
  .findIndex((header) => terms.some((term) => header.includes(term)));

const record = (indicator, data) => ({
  indicator: indicator.id,
  indicatorLabel: indicator.label,
  direction: indicator.direction,
  storeCode: data.storeCode ?? null,
  store: data.store || "Loja não identificada",
  cycle: data.cycle ?? null,
  periodStart: data.periodStart ?? null,
  periodEnd: data.periodEnd ?? null,
  date: data.date ?? data.periodEnd ?? data.periodStart ?? null,
  value: data.value ?? null,
  target: indicator.configuredTarget ?? data.target ?? null,
  unit: data.unit ?? "percent",
  numerator: data.numerator ?? null,
  denominator: data.denominator ?? null,
  volume: data.volume ?? null,
  statusSource: data.statusSource ?? null,
  notes: data.notes ?? null,
  complaints: data.complaints ?? null,
  raw: data.raw ?? {},
});

function parseMedallia(rows, indicator) {
  const headerIndex = findHeader(rows, ["ciclo", "loja", "nps"]);
  const headers = rows[headerIndex];
  const col = {
    cycle: findColumn(headers, ["ciclo"]),
    start: findColumn(headers, ["data inicio"]),
    end: findColumn(headers, ["data final"]),
    store: findColumn(headers, ["loja"]),
    responses: findColumn(headers, ["resposta"]),
    nps: findColumn(headers, ["nps"]),
    notes: findColumn(headers, ["observ"]),
    complaints: findColumn(headers, ["reclam"]),
  };
  const generalByCycle = new Map();
  let activeCycle = null;
  rows.slice(headerIndex + 1).forEach((row) => {
    const rowCycle = col.cycle >= 0 ? number(row[col.cycle]) : null;
    if (rowCycle != null) activeCycle = rowCycle;
    const labelIndex = row.findIndex((cell) => normalizeText(cell).includes("nps total"));
    if (labelIndex < 0) return;
    const total = row.slice(labelIndex + 1).map(number).find((item) => item != null);
    if (activeCycle != null && total != null) generalByCycle.set(String(activeCycle), total);
  });
  return rows.slice(headerIndex + 1).flatMap((row) => {
    if (!row[col.store] || normalizeText(row[col.store]).includes("nps total")) return [];
    const store = storeParts(row[col.store]);
    return [record(indicator, {
      storeCode: store.code, store: store.name, cycle: number(row[col.cycle]),
      periodStart: excelDate(row[col.start]), periodEnd: excelDate(row[col.end]),
      value: ratio(row[col.nps]), volume: number(row[col.responses]),
      notes: row[col.notes] || null, complaints: row[col.complaints] || null,
      raw: {
        responses: number(row[col.responses]),
        resultadoGeral: generalByCycle.get(String(col.cycle >= 0 ? number(row[col.cycle]) : "")) ?? null,
      },
    })];
  });
}

function findReceivingChatFile() {
  const candidates = [
    process.env.OPERATIONS_RECEIVING_CHAT_PATH,
    fileURLToPath(new URL("../data/chat.txt", import.meta.url)),
    path.resolve("chat.txt"),
    path.resolve("data/chat.txt"),
    "C:/Users/carlos.saraiva/Downloads/chat.txt",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function parseReceivingChatVolumes() {
  const chatPath = findReceivingChatFile();
  if (!chatPath) return new Map();
  const volumes = new Map();
  const pendingInvoices = [];
  const cleanInvoice = (value) => {
    const token = String(value ?? "").trim().replace(/[.,]/g, "").split("-")[0].replace(/\D/g, "");
    return token.length >= 4 ? token : null;
  };
  const add = (invoice, volume) => {
    const key = cleanInvoice(invoice);
    const parsed = number(volume);
    if (key && parsed != null) volumes.set(key, Math.round(parsed));
  };
  for (const line of fs.readFileSync(chatPath, "utf8").split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) pendingInvoices.length = 0;
    const explicitText = line.match(/\bnf(?:'s|s)?\b\s*[.:#\-]*\s*(.*)/i);
    const explicitInvoices = explicitText
      ? [...explicitText[1].split(/\b(?:quantidade|qtd|qtde|qnt)\b/i)[0].matchAll(/\d[\d.]*/g)]
        .map((match) => cleanInvoice(match[0])).filter(Boolean)
      : [];
    for (const key of [...new Set(explicitInvoices)]) pendingInvoices.push(key);
    // Aceita tanto "23 Volumes" quanto "Volumes 23". Quando a palavra
    // vem depois da NF ("NF 644396 volumes 10"), priorizamos o número
    // depois de "volumes" para não confundir o número da própria NF com
    // a quantidade de caixas.
    const volumeAfterLabel = line.match(/(?:volumes?|vol\.?|vls?\.?|caixas?|cx\.?)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)(?:\b|$)/i);
    const volumeBeforeLabel = line.match(/(\d+(?:[.,]\d+)?)\s*(?:volumes?|vol\.?|vls?\.?|caixas?|cx\.?)\b/i);
    const volumeMatch = volumeAfterLabel || volumeBeforeLabel;
    const quantityMatch = line.match(/\b(?:quantidade|qtd|qtde|qnt)\s*[:\-]?\s*(\d+(?:[.,]\d+)?)/i);
    // Quando a mensagem informa uma quantidade para várias NFs, a regra
    // operacional é que cada nota recebeu essa mesma quantidade.
    if (quantityMatch && (explicitInvoices.length > 1 || (!volumeMatch && pendingInvoices.length > 1))) {
      const quantity = number(quantityMatch[1]);
      const targets = [...new Set(explicitInvoices.length ? explicitInvoices : pendingInvoices)];
      targets.forEach((invoice) => add(invoice, quantity));
      pendingInvoices.length = 0;
      continue;
    }
    const matchedUnit = volumeMatch || (quantityMatch && pendingInvoices.length === 1 ? quantityMatch : null);
    if (!matchedUnit) {
      if (quantityMatch && pendingInvoices.length > 1) pendingInvoices.length = 0;
      continue;
    }
    const volume = number(matchedUnit[1]);
    let invoice = explicitInvoices[0] || null;
    if (!invoice) {
      const beforeVolume = line.slice(0, matchedUnit.index || 0);
      const candidates = [...beforeVolume.matchAll(/\b\d[\d.\-]*\b/g)]
        .map((match) => cleanInvoice(match[0])).filter(Boolean);
      invoice = candidates.at(-1) || null;
    }
    if (!invoice) invoice = pendingInvoices.shift() || null;
    else if (pendingInvoices[0] === invoice) pendingInvoices.shift();
    if (invoice) add(invoice, volume);
  }
  return volumes;
}

function parseRecebimento(rows, indicator) {
  const h = findHeader(rows, ["codigo", "loja", "recebimento", "retaguarda", "status"]);
  const headers = rows[h];
  const c = {
    cycle: findColumn(headers, ["ciclo"]), code: findColumn(headers, ["codigo"]),
    store: findColumn(headers, ["loja"]), received: findColumn(headers, ["data de recebimento"]),
    entered: findColumn(headers, ["data de entrada"]), days: findColumn(headers, ["tempo de conferencia"]),
    status: findColumn(headers, ["status"]), notes: findColumn(headers, ["observ"]),
    invoice: findColumn(headers, ["numero da nota fiscal", "nota fiscal"]), volumes: findColumn(headers, ["quantidade de volumes", "volumes"]),
  };
  const chatVolumes = parseReceivingChatVolumes();
  const parsed = rows.slice(h + 1).flatMap((row) => {
    if (!row[c.store]) return [];
    const store = storeParts(row[c.store], row[c.code]);
    const start = excelDate(row[c.received]);
    const end = excelDate(row[c.entered]);
    let days = number(row[c.days]);
    if (days == null && start && end) days = Math.max(0, Math.round((new Date(end) - new Date(start)) / 86400000));
    const statusSource = String(row[c.status] ?? "");
    const invoiceKey = String(row[c.invoice] ?? "").replace(/\D/g, "") || null;
    const spreadsheetVolumes = c.volumes >= 0 ? number(row[c.volumes]) : null;
    const receivingVolumes = invoiceKey ? (chatVolumes.get(invoiceKey) ?? spreadsheetVolumes) : spreadsheetVolumes;
    const within = statusSource ? normalizeText(statusSource).includes("dentro") : days == null ? null : days <= 2;
    return [record(indicator, {
      storeCode: store.code, store: store.name, cycle: number(row[c.cycle]),
      // A competência do Recebimento é determinada pela data em que a carga
      // foi recebida. A data de entrada/conferência serve para apurar o SLA,
      // mas não deve mover a linha para outro ciclo.
      date: start, periodStart: start, periodEnd: end, value: within == null ? null : within ? 1 : 0,
      target: 1, numerator: within ? 1 : 0, denominator: 1,
      statusSource: statusSource || null, notes: row[c.notes] || null,
      raw: { conferenceDays: days, slaDays: 2, invoice: invoiceKey, receivingVolumes },
    })];
  });
  const seenInvoices = new Set();
  return parsed.filter((item) => {
    const invoice = item.raw?.invoice;
    if (!invoice) return true;
    const key = `${item.storeCode || item.store}\u0000${invoice}`;
    if (seenInvoices.has(key)) return false;
    seenInvoices.add(key);
    return true;
  });
}

function parseRetirada(rows, indicator) {
  const h = findHeader(rows, ["data da verificacao", "ciclo", "loja", "sem separacao"]);
  const headers = rows[h];
  const c = {
    date: findColumn(headers, ["data da verificacao"]), cycle: findColumn(headers, ["ciclo"]),
    store: findColumn(headers, ["loja"]), separation: findColumn(headers, ["sem separacao"]),
    cancellation: findColumn(headers, ["sem cancelamento"]), notes: findColumn(headers, ["observ"]),
  };
  return rows.slice(h + 1).flatMap((row, rowIndex) => {
    if (!row[c.store]) return [];
    const store = storeParts(row[c.store]);
    const separationIssue = Boolean(row[c.separation]);
    const cancellationIssue = Boolean(row[c.cancellation]);
    if (!separationIssue && !cancellationIssue) return [];
    return [
      separationIssue ? record(indicator, {
        storeCode: store.code, store: store.name, cycle: number(row[c.cycle]), date: excelDate(row[c.date]),
        value: 1, unit: "count", notes: row[c.notes] || null,
        raw: { scoreType: "sem_separacao_apos_16h", sourceMark: row[c.separation], orderKey: rowIndex },
      }) : null,
      cancellationIssue ? record(indicator, {
        storeCode: store.code, store: store.name, cycle: number(row[c.cycle]), date: excelDate(row[c.date]),
        value: 1, unit: "count", notes: row[c.notes] || null,
        raw: { scoreType: "sem_cancelamento", sourceMark: row[c.cancellation], orderKey: rowIndex },
      }) : null,
    ].filter(Boolean);
  });
}

function parseCancellation(rows, indicator) {
  const result = [];
  for (let h = 0; h < rows.length - 2; h += 1) {
    const headerText = normalizeText(rows[h].filter(Boolean).join(" "));
    if (!headerText.includes("captados") || normalizeText(rows[h + 1]?.[0]) !== "loja") continue;
    const summaryColumn = rows[h].findIndex((value) => normalizeText(value) === "saldo total");
    if (summaryColumn < 0) continue;
    const dates = rows[h + 1].slice(0, summaryColumn).map(excelDate).filter(Boolean).sort();
    const periodEnd = dates.at(-1) ?? excelDate(rows[h]?.[0]);
    let end = h + 2;
    while (end < rows.length && normalizeText(rows[end]?.[0]) !== "loja"
      && !normalizeText(rows[end].filter(Boolean).join(" ")).includes("captados")) end += 1;
    for (let r = h + 2; r < end; r += 1) {
      if (!rows[r]?.[0]) continue;
      const store = storeParts(rows[r][0]);
      const sourceSaldoTotal = ratio(rows[r][summaryColumn]);
      const totalCaptured = number(rows[r][summaryColumn + 1]);
      const totalCancelled = number(rows[r][summaryColumn + 2]);
      if (sourceSaldoTotal == null && totalCaptured == null) continue;
      const cancellationRate = sourceSaldoTotal ?? (totalCaptured ? (totalCancelled || 0) / totalCaptured : null);
      // Para cancelamentos, o valor exibido é o próprio Saldo Total da planilha:
      // quanto menor, melhor (meta abaixo de 2%).
      const performance = cancellationRate == null ? null : Math.max(0, Math.min(1, cancellationRate));
      result.push(record(indicator, {
        storeCode: store.code, store: store.name, date: periodEnd, value: performance,
        numerator: totalCaptured == null ? null : totalCancelled || 0,
        denominator: totalCaptured, volume: totalCaptured,
        raw: { sourceSaldoTotal, cancellationRate, performance, totalCaptured, totalCancelled },
      }));
    }
  }
  return result;
}

function parseTrilogo(rows, indicator) {
  const h = findHeader(rows, ["ciclo", "data da verificacao", "loja", "ticket", "status"]);
  const headers = rows[h];
  const c = {
    cycle: findColumn(headers, ["ciclo"]), verifyDate: findColumn(headers, ["data da verificacao"]),
    store: findColumn(headers, ["loja"]), openedAt: findColumn(headers, ["data abertura"]),
    ticket: findColumn(headers, ["ticket", "chamado"]), status: findColumn(headers, ["status"]),
    notes: findColumn(headers, ["observ"]),
  };
  return rows.slice(h + 1).flatMap((row) => {
    if (!row[c.store] || (c.ticket >= 0 && !row[c.ticket])) return [];
    const store = storeParts(row[c.store]);
    return [record(indicator, {
      storeCode: store.code, store: store.name, cycle: number(row[c.cycle]),
      // O ciclo do chamado é definido pela data em que ele foi aberto.
      // A data de verificação permanece disponível no raw para auditoria,
      // mas não deve determinar a competência do ciclo.
      date: excelDate(c.openedAt >= 0 ? row[c.openedAt] : row[c.verifyDate]), value: 1, unit: "count",
      statusSource: c.status >= 0 ? row[c.status] : null,
      notes: c.notes >= 0 ? row[c.notes] || null : null,
      raw: Object.fromEntries(headers.map((header, index) => [String(header ?? `column_${index + 1}`), row[index]])),
    })];
  });
}

function parseQuebra(rows, indicator) {
  const h = findHeader(rows, ["ciclo", "periodo", "loja", "quebra", "vendidos"]);
  const headers = rows[h];
  const c = {
    cycle: findColumn(headers, ["ciclo"]), start: 1, end: 2, store: findColumn(headers, ["loja"]),
    broken: findColumn(headers, ["quebra de itens"]), sold: findColumn(headers, ["itens vendidos"]),
    value: findColumn(headers, ["sem quebra", "%"]),
  };
  return rows.slice(h + 1).flatMap((row) => {
    if (!row[c.store]) return [];
    const store = storeParts(row[c.store]);
    const broken = number(row[c.broken]);
    const sold = number(row[c.sold]);
    const value = sold ? (broken || 0) / sold : ratio(row[c.value]);
    return [record(indicator, {
      storeCode: store.code, store: store.name, cycle: number(row[c.cycle]),
      periodStart: excelDate(row[c.start]), periodEnd: excelDate(row[c.end]), value,
      numerator: broken, denominator: sold, volume: sold, raw: { brokenItems: broken, soldItems: sold },
    })];
  });
}

function parseSaldo(rows, indicator) {
  const result = [];
  for (let h = 0; h < rows.length - 2; h += 1) {
    const text = normalizeText(rows[h].filter(Boolean).join(" "));
    if (!text.includes("captados") || !text.includes("faturados") || normalizeText(rows[h + 1]?.[0]) !== "loja") continue;
    const summaryColumn = rows[h].findIndex((value) => normalizeText(value) === "saldo total");
    if (summaryColumn < 0) continue;
    const dates = rows[h + 1].slice(0, summaryColumn).map(excelDate).filter(Boolean).sort();
    const periodEnd = dates.at(-1) ?? excelDate(rows[h]?.[0]);
    let end = h + 2;
    while (end < rows.length && normalizeText(rows[end]?.[0]) !== "loja" && !normalizeText(rows[end].filter(Boolean).join(" ")).includes("captados")) end += 1;
    for (let r = h + 2; r < end; r += 1) {
      if (!rows[r]?.[0]) continue;
      const store = storeParts(rows[r][0]);
      const sourceSaldoTotal = ratio(rows[r][summaryColumn]);
      const totalCaptured = number(rows[r][summaryColumn + 1]);
      const totalBilled = number(rows[r][summaryColumn + 2]);
      if (sourceSaldoTotal == null && totalCaptured == null) continue;
      const fulfillmentRate = sourceSaldoTotal ?? (totalCaptured ? (totalBilled || 0) / totalCaptured : null);
      const performance = fulfillmentRate == null ? null : Math.max(0, Math.min(1, fulfillmentRate));
      result.push(record(indicator, {
        storeCode: store.code, store: store.name, date: periodEnd,
        value: performance, volume: totalCaptured,
        raw: { sourceSaldoTotal, fulfillmentRate, performance, totalCaptured, totalBilled },
      }));
    }
  }
  return result;
}

function parseGeneric(rows, indicator) {
  const h = findHeader(rows, ["loja", "ciclo", "codigo", "resultado", "percentual", "meta"]);
  const headers = rows[h] ?? [];
  const c = {
    cycle: findColumn(headers, ["ciclo"]), code: findColumn(headers, ["codigo", "cod loja"]),
    store: findColumn(headers, ["loja", "filial"]), start: findColumn(headers, ["data inicio", "inicio"]),
    end: findColumn(headers, ["data final", "fim"]), date: findColumn(headers, ["data"]),
    target: findColumn(headers, ["meta", "limite"]), status: findColumn(headers, ["status", "situacao"]),
    volume: findColumn(headers, ["volume", "quantidade", "qtd", "pedidos"]),
    value: findColumn(headers, ["percentual", "atingido", "resultado", "realizado", "utilizacao", "aderencia", "performance", "conformidade", "d 1", "nps", "%", "saldo", "quebra"]),
  };
  if (c.store < 0) c.store = 0;
  if (c.value < 0) c.value = headers.findIndex((header) => String(header ?? "").includes("%"));
  const generalByCycle = new Map();
  let activeCycle = null;
  rows.slice(h + 1).forEach((row) => {
    const rowCycle = c.cycle >= 0 ? number(row[c.cycle]) : null;
    if (rowCycle != null) activeCycle = rowCycle;
    const labelIndex = row.findIndex((cell) => normalizeText(cell).includes("resultado geral"));
    if (labelIndex < 0 || activeCycle == null) return;
    const general = row.slice(labelIndex + 1).map(number).find((item) => item != null);
    if (general != null) generalByCycle.set(String(activeCycle), ratio(general));
  });
  return rows.slice(h + 1).flatMap((row) => {
    if (!row || row.every((cell) => cell == null || cell === "")) return [];
    const storeCell = row[c.store];
    if (!storeCell || /total|media|resultado geral|nps total/i.test(String(storeCell))) return [];
    const store = storeParts(storeCell, c.code >= 0 ? row[c.code] : null);
    let value = c.value >= 0 ? number(row[c.value]) : null;
    if (value != null && indicator.id !== "saldo-pedidos") value = ratio(value);
    const statusSource = c.status >= 0 ? row[c.status] : null;
    if (value == null && statusSource) {
      const status = normalizeText(statusSource);
      if (status.includes("dentro") || status.includes("conforme")) value = 1;
      else if (status.includes("fora") || status.includes("nao conforme")) value = 0;
    }
    if (value == null) {
      const candidate = row.map(number).findLast((item) => item != null);
      if (candidate == null) return [];
      value = indicator.id === "saldo-pedidos" ? candidate : ratio(candidate);
    }
    return [record(indicator, {
      storeCode: store.code, store: store.name,
      cycle: c.cycle >= 0 ? number(row[c.cycle]) : null,
      periodStart: c.start >= 0 ? excelDate(row[c.start]) : null,
      periodEnd: c.end >= 0 ? excelDate(row[c.end]) : null,
      date: c.date >= 0 ? excelDate(row[c.date]) : null,
      value, target: c.target >= 0 ? ratio(row[c.target]) : null,
      volume: c.volume >= 0 ? number(row[c.volume]) : null,
      statusSource: statusSource || null,
      raw: {
        ...Object.fromEntries(headers.map((header, index) => [String(header ?? `column_${index + 1}`), row[index]])),
        resultadoGeral: generalByCycle.get(String(c.cycle >= 0 ? number(row[c.cycle]) : "")) ?? null,
      },
    })];
  });
}

const resolveSheet = (workbook, indicator) => {
  const sheets = workbook.SheetNames.map((name) => ({ name, normalized: normalizeText(name) }));
  return sheets.find((sheet) => sheet.normalized === indicator.alias)
    ?? sheets.find((sheet) => sheet.normalized.includes(indicator.alias) || indicator.alias.includes(sheet.normalized));
};

const statusFor = (value, target, direction, sourceStatus) => {
  if (value == null) return "unknown";
  if (target != null) {
    const delta = direction === "lower" ? target - value : value - target;
    return delta >= 0 ? "good" : "bad";
  }
  const source = normalizeText(sourceStatus);
  if (source.includes("fora") || source.includes("nao conforme")) return "bad";
  if (source.includes("dentro") || source.includes("conforme")) return "good";
  return "unknown";
};

const invalidDateText = (value) => {
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return false;
  const [, day, month, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;
};

const aggregate = (rows, indicator) => {
  const valid = rows.filter((row) => row.value != null);
  const weighted = valid.filter((row) => row.numerator != null && row.denominator);
  let value = null;
  if (weighted.length) {
    const denominator = weighted.reduce((sum, row) => sum + row.denominator, 0);
    value = denominator ? weighted.reduce((sum, row) => sum + row.numerator, 0) / denominator : null;
  } else if (valid[0]?.unit === "count") value = valid.reduce((sum, row) => sum + row.value, 0);
  else if (!valid.length && ZERO_WHEN_ABSENT.has(indicator.id)) value = 0;
  else if (valid.length) {
    const byVolume = valid.filter((row) => row.volume > 0);
    value = byVolume.length
      ? byVolume.reduce((sum, row) => sum + row.value * row.volume, 0) / byVolume.reduce((sum, row) => sum + row.volume, 0)
      : valid.reduce((sum, row) => sum + row.value, 0) / valid.length;
  }
  const targets = valid.map((row) => row.target).filter((item) => item != null);
  const target = targets.length
    ? targets.reduce((sum, item) => sum + item, 0) / targets.length
    : indicator.configuredTarget ?? null;
  return {
    value, target, count: valid.length,
    status: statusFor(value, target, indicator.direction, valid.map((row) => row.statusSource).find(Boolean)),
  };
};

function quality(records, workbook, resolvedSheets) {
  const issues = [];
  const issueKeys = new Set();
  const add = (severity, code, message, extra = {}) => {
    const key = [severity, code, message, extra.indicator || "", extra.store || "", extra.key || ""].join("|");
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push({ severity, code, message, ...extra });
  };
  INDICATORS.forEach((indicator) => {
    if (!resolvedSheets[indicator.id]) add("critical", "missing_sheet", `Aba não encontrada para ${indicator.label}`, { indicator: indicator.id });
  });
  const keys = new Map();
  records.forEach((item) => {
    if (item.raw.dataQualityCorrection) add("medium", "corrected_store_identity", item.raw.dataQualityCorrection, { indicator: item.indicator, store: item.store });
    for (const [field, value] of Object.entries(item.raw)) {
      const normalizedField = normalizeText(field);
      if (normalizedField.includes("data") && !normalizedField.includes("dataqualitycorrection") && value != null && value !== "" && (invalidDateText(value) || !excelDate(value))) {
        add("high", "invalid_date", `Data inválida em ${field}: ${String(value)}`, { indicator: item.indicator, store: item.store });
      }
    }
    if (!item.storeCode) add("medium", "missing_store_code", `Loja sem código: ${item.store}`, { indicator: item.indicator });
    if (item.value == null) add("medium", "missing_value", `Indicador vazio: ${item.store}`, { indicator: item.indicator });
    if (item.unit === "percent" && item.value != null && (item.value < 0 || item.value > 1.2)) add("high", "invalid_percent", `Percentual fora do intervalo: ${item.value}`, { indicator: item.indicator, store: item.store });
    if (!["recebimento", "retirada", "retirada-cancelados", "entrega-cancelados"].includes(item.indicator)) {
      const key = [item.indicator, item.storeCode || normalizeText(item.store), item.cycle, item.date].join("|");
      keys.set(key, (keys.get(key) || 0) + 1);
    }
  });
  [...keys.entries()].filter(([, count]) => count > 1).slice(0, 50)
    .forEach(([key, count]) => add("medium", "duplicate_grain", `Possível duplicidade (${count} registros)`, { key }));
  return {
    workbookSheets: workbook.SheetNames, issues,
    summary: issues.reduce((acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] || 0) + 1 }), {}),
  };
}

function buildModel(records, source, qualityReport) {
  const byIndicator = {};
  const stores = [...new Set(records.map((item) => item.store).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  const storeCodeByName = new Map(records.filter((item) => item.store && item.storeCode).map((item) => [item.store, String(item.storeCode)]));
  const cycles = [...new Set(records.map((item) => item.cycle).filter((value) => value != null))].sort((a, b) => a - b);
  for (const indicator of INDICATORS) {
    const all = records.filter((item) => item.indicator === indicator.id);
    const cycleKeys = all.map((item) => item.cycle).filter((value) => value != null);
    const latestKey = cycleKeys.length
      ? Math.max(...cycleKeys)
      : all.map((item) => item.date ?? item.periodEnd ?? "").filter(Boolean).sort().at(-1) ?? null;
    const latest = latestKey == null ? all : all.filter((item) => (item.cycle ?? item.date ?? item.periodEnd ?? "") === latestKey);
    const groups = new Map();
    latest.forEach((item) => groups.set(item.store, [...(groups.get(item.store) || []), item]));
    const ranking = stores.map((store) => ({ store, storeCode: storeCodeByName.get(store) ?? null, ...aggregate(groups.get(store) || [], indicator) }))
      .sort((a, b) => a.value == null ? 1 : b.value == null ? -1 : b.value - a.value || a.store.localeCompare(b.store, "pt-BR"));
    const generalByCycle = Object.fromEntries(all
      .filter((item) => item.raw?.resultadoGeral != null && item.cycle != null)
      .map((item) => [String(item.cycle), item.raw.resultadoGeral]));
    const generalKeys = Object.keys(generalByCycle).sort((a, b) => Number(a) - Number(b));
    const latestGeneral = generalByCycle[String(latestKey)]
      ?? generalByCycle[generalKeys.filter((key) => Number(key) <= Number(latestKey)).at(-1)]
      ?? null;
    const current = indicator.id === "retirada"
      ? {
        value: null,
        target: indicator.configuredTarget ?? null,
        count: latest.length,
        status: "unknown",
      }
      : { ...aggregate(latest, indicator), value: latestGeneral ?? aggregate(latest, indicator).value };
    const periods = [...new Set(all.map((item) => item.cycle ?? item.date ?? item.periodEnd).filter(Boolean))]
      .sort((a, b) => typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)));
    byIndicator[indicator.id] = {
      ...indicator, latestKey, current, ranking, generalByCycle,
      trend: indicator.id === "retirada" ? [] : periods.map((period) => ({ period: String(period), ...aggregate(all.filter((item) => (item.cycle ?? item.date ?? item.periodEnd) === period), indicator) })),
      records: all,
    };
  }
  const matrix = stores.map((store) => ({
    store, storeCode: storeCodeByName.get(store) ?? null,
    indicators: Object.fromEntries(INDICATORS.map((indicator) => {
      const all = byIndicator[indicator.id].records.filter((item) => item.store === store);
      const storeCycles = all.map((item) => item.cycle).filter((value) => value != null);
      const latest = storeCycles.length
        ? Math.max(...storeCycles)
        : all.map((item) => item.date ?? item.periodEnd ?? "").filter(Boolean).sort().at(-1);
      return [indicator.id, aggregate(all.filter((item) => (item.cycle ?? item.date ?? item.periodEnd ?? "") === latest), indicator)];
    })),
  }));
  const alerts = matrix.flatMap((entry) => Object.entries(entry.indicators)
    .filter(([, result]) => result.status === "bad")
    .map(([indicator, result]) => ({ store: entry.store, storeCode: entry.storeCode, indicator, ...result })));
  return {
    source,
    meta: { generatedAt: new Date().toISOString(), storeCount: stores.length, recordCount: records.length },
    filters: { stores, cycles, indicators: INDICATORS.map(({ id, label }) => ({ id, label })) },
    indicators: byIndicator, stores: matrix, alerts, quality: qualityReport,
  };
}

export function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true, cellFormula: true, cellNF: true });
  const records = [];
  const resolvedSheets = {};
  for (const indicator of INDICATORS) {
    const resolved = resolveSheet(workbook, indicator);
    if (!resolved) continue;
    resolvedSheets[indicator.id] = resolved.name;
    const rows = rowsOf(workbook.Sheets[resolved.name]);
    const parsed = indicator.id === "medallia" ? parseMedallia(rows, indicator)
      : indicator.id === "recebimento" ? parseRecebimento(rows, indicator)
        : indicator.id === "retirada" ? parseRetirada(rows, indicator)
          : indicator.id === "trilogo" ? parseTrilogo(rows, indicator)
            : indicator.id === "quebra-estoque" ? parseQuebra(rows, indicator)
            : indicator.id === "saldo-pedidos" ? parseSaldo(rows, indicator)
        : indicator.id.endsWith("cancelados") ? parseCancellation(rows, indicator)
          : parseGeneric(rows, indicator);
    records.push(...parsed);
  }
  const canonicalStores = new Map([
    ["19826", "Partage"], ["20740", "Madureira"], ["21044", "Alcântara"],
    ["21469", "Juiz de Fora"], ["21740", "Benfica"], ["21483", "Três Rios"],
    ["22552", "Raul Soares"], ["22554", "Além Paraíba"], ["22555", "Manhuaçu"],
    ["22588", "Leopoldina"], ["23318", "Santos Dumont"], ["23433", "Caratinga"],
    ["23441", "Carangola"], ["24064", "Aimorés"],
  ]);
  const codeToName = new Map(canonicalStores);
  const nameToCode = new Map();
  records.forEach((item) => {
    if (item.storeCode && !/^\d+$/.test(item.store)) {
      if (!codeToName.has(String(item.storeCode))) codeToName.set(String(item.storeCode), item.store);
      nameToCode.set(normalizeText(item.store), String(item.storeCode));
    }
  });
  for (const [code, name] of canonicalStores) nameToCode.set(normalizeText(name), code);
  records.forEach((item) => {
    const normalizedStore = normalizeText(item.store);
    if (String(item.storeCode) === "23554" || normalizedStore === "alem paraiba") {
      item.raw.dataQualityCorrection = "Código/nome normalizado para 22554 - Além Paraíba";
      item.storeCode = "22554";
    }
    if (normalizedStore === "leopldina") {
      item.raw.dataQualityCorrection = "Nome normalizado para Leopoldina";
      item.storeCode = "22588";
    }
    if (!item.storeCode && nameToCode.has(normalizeText(item.store))) item.storeCode = nameToCode.get(normalizeText(item.store));
    if (item.storeCode && codeToName.has(String(item.storeCode))) item.store = codeToName.get(String(item.storeCode));
  });
  const stat = fs.statSync(filePath);
  const source = {
    path: path.resolve(filePath), fileName: path.basename(filePath),
    modifiedAt: stat.mtime.toISOString(), size: stat.size, resolvedSheets,
  };
  const model = buildModel(records, source, quality(records, workbook, resolvedSheets));
  const ordersPath = findOrdersWorkbook();
  let orders = null;
  if (ordersPath && fs.existsSync(ordersPath)) {
    const orderStat = fs.statSync(ordersPath);
    const orderModifiedAt = orderStat.mtime.toISOString();
    if (ordersMemo?.path === path.resolve(ordersPath) && ordersMemo.modifiedAt === orderModifiedAt) orders = ordersMemo.value;
    else {
      try { orders = orderStat.size > 50 * 1024 * 1024 ? parseOrdersLargeWorkbook(ordersPath) : parseOrdersWorkbook(ordersPath); }
      catch (error) {
        try { orders = orderStat.size > 50 * 1024 * 1024 ? parseOrdersWorkbook(ordersPath) : parseOrdersLargeWorkbook(ordersPath); }
        catch (largeError) { orders = { error: largeError.message || error.message, source: { fileName: path.basename(ordersPath), modifiedAt: orderModifiedAt }, period: { start: null, end: null, days: 0 }, stores: [] }; }
      }
      if (orders && !orders.error) ordersMemo = { path: path.resolve(ordersPath), modifiedAt: orderModifiedAt, value: orders };
    }
  }
  if (!orders) {
    const pivotPath = "C:/Users/carlos.saraiva/.codex/attachments/847fa707-dee0-45d1-82ef-a6c88f6eaaf3/pasted-text.txt";
    if (fs.existsSync(pivotPath)) orders = parseOrdersPivotSummary(pivotPath);
  }
  return { ...model, orders };
}

function parseOrdersPivotSummary(filePath) {
  const itemTotals = new Map([
    ["19826", 597837], ["20740", 648201], ["21044", 604254], ["21469", 829231], ["21470", 90756],
    ["21483", 200582], ["22552", 74986], ["22554", 56573], ["22555", 414028], ["22588", 50048],
    ["23318", 57281], ["23433", 223498], ["23441", 125831], ["24064", 42335],
  ]);
  const canonical = new Map([
    ["19826", "Partage"], ["20740", "Madureira"], ["21044", "Alcântara"], ["21469", "Juiz de Fora"],
    ["21470", "Captação Juiz de Fora"], ["21483", "Três Rios"], ["22552", "Raul Soares"], ["22554", "Além Paraíba"],
    ["22555", "Manhuaçu"], ["22588", "Leopoldina"], ["23318", "Santos Dumont"], ["23433", "Caratinga"],
    ["23441", "Carangola"], ["24064", "Aimorés"],
  ]);
  // [entrega, retirada] por motivo. Esta base reconcilia com os 35.247
  // cancelados da tabela dinâmica de pedidos.
  const cancellationReasons = new Map([
    ["19826", { usuario: [1091, 2209], analisePagamento: [135, 8], antifraude: [7, 0], inatividade: [6, 3], estoque: [13, 0], prazoPendencia: [191, 24], recusaExterna: [1, 0] }],
    ["20740", { usuario: [1429, 3966], analisePagamento: [117, 5], antifraude: [10, 2], inatividade: [27, 46], estoque: [178, 0], prazoAnalisePagamento: [1, 0], prazoPendencia: [332, 46], recusaExterna: [1, 0] }],
    ["21044", { usuario: [1032, 3664], analisePagamento: [192, 16], antifraude: [5, 0], inatividade: [12, 21], estoque: [7, 0], prazoAnalisePagamento: [1, 0], prazoPendencia: [205, 64], recusaExterna: [1, 0] }],
    ["21469", { usuario: [2244, 4828], analisePagamento: [287, 11], antifraude: [18, 1], inatividade: [28, 3], estoque: [2, 0], prazoAnalisePagamento: [1, 0], prazoPendencia: [546, 33], recusaExterna: [6, 1] }],
    ["21470", { usuario: [0, 1839], analisePagamento: [0, 4], inatividade: [0, 18], prazoPendencia: [0, 49] }],
    ["21483", { usuario: [512, 930], analisePagamento: [40, 2], antifraude: [2, 0], inatividade: [9, 2], inconsistencia: [6, 0], prazoPendencia: [72, 2], recusaExterna: [1, 0] }],
    ["22552", { usuario: [768, 397], analisePagamento: [9, 2], antifraude: [3, 0], inatividade: [1, 0], prazoPendencia: [31, 4], recusaExterna: [1, 1] }],
    ["22554", { usuario: [0, 548], analisePagamento: [0, 7], inatividade: [0, 17], prazoPendencia: [0, 7] }],
    ["22555", { usuario: [868, 384], analisePagamento: [81, 7], antifraude: [13, 0], inatividade: [20, 7], estoque: [12, 0], prazoPendencia: [294, 25], recusaExterna: [2, 0] }],
    ["22588", { usuario: [0, 285], analisePagamento: [0, 3], inatividade: [0, 2], prazoPendencia: [0, 5] }],
    ["23318", { usuario: [0, 526], analisePagamento: [0, 2], inatividade: [0, 5], prazoPendencia: [0, 6] }],
    ["23433", { usuario: [633, 766], analisePagamento: [38, 1], antifraude: [6, 0], inatividade: [9, 5], inconsistencia: [4, 0], prazoPendencia: [115, 29], recusaExterna: [2, 2] }],
    ["23441", { usuario: [796, 687], analisePagamento: [17, 3], inatividade: [2, 5], inconsistencia: [6, 0], prazoPendencia: [199, 13], recusaExterna: [2, 0] }],
    ["24064", { usuario: [230, 695], analisePagamento: [3, 1], inatividade: [0, 6], prazoPendencia: [32, 32] }],
  ]);
  const fiscalSummaryPath = "C:/Users/carlos.saraiva/.codex/attachments/5b8a8c67-bb07-4f07-b54b-540e98f9e17b/pasted-text.txt";
  const fiscalByStore = fs.existsSync(fiscalSummaryPath) ? parseCancellationFiscalSummary(fiscalSummaryPath) : new Map();
  const statuses = new Set(["aprovado", "cancelado", "entregue", "pendente", "separacao", "transporte"]);
  const resellerRoles = new Set(["bronze", "cobre", "diamante", "diamante gb", "esmeralda gb", "ouro", "platina", "prata", "rubi", "revendedor"]);
  const result = [];
  let current = null;
  let currentStatus = "";
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const cells = line.split("\t");
    const label = String(cells[0] || "").trim();
    const storeMatch = label.match(/^(\d{5})\s+-/);
    if (storeMatch) {
      const code = storeMatch[1];
      current = { store: canonical.get(code) || label.replace(/^\d{5}\s+-\s*/, ""), storeCode: code,
        total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, revendedorCategorias: {}, cancelamentoMotivos: cancellationReasons.get(code) || {}, cancelamentoFiscal: fiscalByStore.get(code) || {},
        retiradaCancelados: 0, entregaCancelados: 0, itens: itemTotals.get(code) ?? null,
        mediaRetirada: 0, mediaEntrega: 0, mediaOmni: 0, mediaItens: null };
      const deliveryTotal = Number(cells[10] || 0); const pickupTotal = Number(cells[20] || 0);
      current._deliveryAll = deliveryTotal; current._pickupAll = pickupTotal;
      result.push(current); currentStatus = ""; continue;
    }
    if (!current) continue;
    const normalized = normalizeText(label);
    if (statuses.has(normalized)) {
      currentStatus = normalized;
      if (normalized === "cancelado") {
        current.entregaCancelados = Number(cells[10] || 0);
        current.retiradaCancelados = Number(cells[20] || 0);
      }
      continue;
    }
    if (currentStatus && currentStatus !== "cancelado") {
      const grandTotal = Number(cells[21] || 0);
      if (resellerRoles.has(normalized)) {
        current.revendedor += grandTotal;
        const category = normalized === "diamante gb" ? "diamante" : normalized;
        current.revendedorCategorias[category] = (current.revendedorCategorias[category] || 0) + grandTotal;
      }
      if (normalized === "consumidor final") current.omni += grandTotal;
    }
  }
  for (const item of result) {
    item.entrega = Math.max(0, item._deliveryAll - item.entregaCancelados);
    item.retirada = Math.max(0, item._pickupAll - item.retiradaCancelados);
    item.total = item.entrega + item.retirada;
    item.pctEntrega = item.total ? item.entrega / item.total : 0;
    item.pctRetirada = item.total ? item.retirada / item.total : 0;
    item.mediaEntrega = item.entrega / 254;
    item.mediaRetirada = item.retirada / 254;
    item.mediaOmni = item.omni / 254;
    item.mediaItens = item.itens == null ? null : item.itens / 254;
    delete item._deliveryAll; delete item._pickupAll;
  }
  result.push({ store: "BOTICARIO PRODUTOS DE BELEZA LTDA", storeCode: "21732", total: 0, retirada: 0, entrega: 0,
    revendedor: 0, omni: 0, revendedorCategorias: {}, cancelamentoMotivos: cancellationReasons.get("21732") || {}, cancelamentoFiscal: fiscalByStore.get("21732") || {}, retiradaCancelados: 0, entregaCancelados: 0, itens: 5,
    pctEntrega: 0, pctRetirada: 0, mediaRetirada: 0, mediaEntrega: 0, mediaOmni: 0, mediaItens: 5 / 254 });
  const stat = fs.statSync(filePath);
  return { source: { path: path.resolve(filePath), fileName: "Resumo de pedidos informado", modifiedAt: stat.mtime.toISOString() },
    period: { start: "2026-01-01", end: "2026-09-11", days: 254 }, stores: result.sort((a, b) => b.total - a.total) };
}

function parseCancellationFiscalSummary(filePath) {
  const situations = ["disp faturamento", "nao faturado", "nf cancelada", "nf emitida"];
  const result = new Map();
  let current = null;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const cells = line.split("\t");
    const label = String(cells[0] || "").trim();
    const storeMatch = label.match(/^(\d{5})\s+-/);
    if (storeMatch) {
      current = { code: storeMatch[1], values: Object.fromEntries(situations.map((key) => [key, [0, 0]])) };
      result.set(current.code, current.values);
      continue;
    }
    if (!current || !normalizeText(label).startsWith("cancelado")) continue;
    situations.forEach((key, index) => {
      current.values[key][0] += Number(cells[index + 1] || 0);
      current.values[key][1] += Number(cells[index + 6] || 0);
    });
  }
  return result;
}

// A planilha de pedidos é independente da planilha de metas.  Mantemos a
// leitura separada para que ela possa ser substituída diariamente sem mexer
// na estrutura dos indicadores operacionais.
function parseOrdersLargeWorkbook(filePath) {
  const bundledPython = path.resolve(path.dirname(process.execPath), "../../python/python.exe");
  const python = fs.existsSync(bundledPython) ? bundledPython : "python";
  const script = fileURLToPath(new URL("./parse_orders_large.py", import.meta.url));
  const result = spawnSync(python, [script, filePath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error((result.stderr || "Falha ao processar a planilha grande.").trim());
  return JSON.parse(result.stdout);
}

export function parseOrdersWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const sheetName = workbook.SheetNames.find((name) => normalizeText(name) === "pag") || workbook.SheetNames[0];
  if (!sheetName || !workbook.Sheets[sheetName]) throw new Error("Não foi possível ler a aba Pag. Salve o arquivo novamente como .xlsx pelo Excel antes de importar.");
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });
  if (!rows.length) throw new Error("A aba Pag não contém linhas de dados.");
  const canonical = new Map([
    ["19826", "Partage"], ["20740", "Madureira"], ["21044", "Alcântara"], ["21469", "Juiz de Fora"],
    ["21470", "Benfica"], ["21483", "Três Rios"], ["22552", "Raul Soares"], ["22554", "Além Paraíba"],
    ["22555", "Manhuaçu"], ["22588", "Leopoldina"], ["23318", "Santos Dumont"], ["23433", "Caratinga"],
    ["23441", "Carangola"], ["24064", "Aimorés"],
  ]);
  const buckets = new Map();
  const resellerRoles = new Set(["bronze", "cobre", "diamante", "diamante gb", "esmeralda gb", "ouro", "platina", "prata", "rubi", "revendedor"]);
  const dates = new Set();
  const parseDate = (value) => {
    if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
    const match = String(value ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  };
  const numeric = (value) => Number(String(value ?? "").replace(/\./g, "").replace(",", ".")) || 0;
  for (const row of rows) {
    const source = String(row["CanalDistribuicao"] || "");
    const code = source.match(/\b(\d{4,6})\b/)?.[1] || null;
    if (!code || !canonical.has(code)) continue;
    const store = canonical.get(code);
    const day = parseDate(row["Data Captação"]);
    if (day) dates.add(day);
    const bucket = buckets.get(code) || { store, storeCode: code, total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, revendedorCategorias: {}, cancelamentoMotivos: {}, cancelamentoFiscal: {}, retiradaCancelados: 0, entregaCancelados: 0, itens: 0 };
    const meio = normalizeText(row.MeioCaptacao);
    const papel = normalizeText(row.Papel);
    const tipo = normalizeText(`${row["Tipo de Entrega"] || ""} ${row["Detalhe Entrega"] || ""}`);
    const isRetirada = tipo.includes("retirada") || tipo.includes("retirar na central de servicos") || tipo.includes("loja");
    const isCancelled = normalizeText(row["SituaçãoComercial"]).includes("cancelado");
    if (isCancelled) {
      if (isRetirada) bucket.retiradaCancelados += 1; else bucket.entregaCancelados += 1;
      const detailEntry = Object.entries(row).find(([key]) => normalizeText(key).includes("detalhe situacao"));
      const detail = normalizeText(detailEntry?.[1]);
      const reason = detail.includes("pelo usuario") ? "usuario"
        : detail.includes("analise do pagamento excedido") ? "prazoAnalisePagamento"
          : detail.includes("analise do pagamento") ? "analisePagamento"
            : detail.includes("antifraude") ? "antifraude"
              : detail.includes("inatividade") ? "inatividade"
                : detail.includes("inconsistencia de estoque") ? "estoque"
                  : detail.includes("inconsistencia") ? "inconsistencia"
                    : detail.includes("pendencia excedido") ? "prazoPendencia"
                      : detail.includes("autorizacao externa") ? "recusaExterna" : "outros";
      const reasonCounts = bucket.cancelamentoMotivos[reason] || [0, 0];
      reasonCounts[isRetirada ? 1 : 0] += 1;
      bucket.cancelamentoMotivos[reason] = reasonCounts;
      const fiscalEntry = Object.entries(row).find(([key]) => normalizeText(key).includes("situacao fiscal"));
      const fiscalKey = normalizeText(fiscalEntry?.[1]);
      if (fiscalKey) {
        const fiscalCounts = bucket.cancelamentoFiscal[fiscalKey] || [0, 0];
        fiscalCounts[isRetirada ? 1 : 0] += 1;
        bucket.cancelamentoFiscal[fiscalKey] = fiscalCounts;
      }
    } else {
      bucket.total += 1;
      bucket.itens += numeric(row.QtdeItens);
      if (isRetirada) bucket.retirada += 1; else bucket.entrega += 1;
      if (papel === "consumidor final") {
        bucket.omni += 1;
      } else {
        bucket.revendedor += 1;
        const category = papel === "diamante gb" ? "diamante" : papel;
        bucket.revendedorCategorias[category] = (bucket.revendedorCategorias[category] || 0) + 1;
      }
    }
    buckets.set(code, bucket);
  }
  const dayCount = Math.max(1, dates.size);
  const stores = [...buckets.values()].map((item) => ({ ...item,
    pctEntrega: item.total ? item.entrega / item.total : 0,
    pctRetirada: item.total ? item.retirada / item.total : 0,
    mediaRetirada: item.retirada / dayCount, mediaEntrega: item.entrega / dayCount,
    mediaOmni: item.omni / dayCount, mediaItens: item.itens / dayCount,
  })).sort((a, b) => b.total - a.total || a.store.localeCompare(b.store, "pt-BR"));
  const stat = fs.statSync(filePath);
  return { source: { path: path.resolve(filePath), fileName: path.basename(filePath), modifiedAt: stat.mtime.toISOString() }, period: { start: [...dates].sort()[0] || null, end: [...dates].sort().at(-1) || null, days: dayCount }, stores };
}

export function findOrdersWorkbook() {
  const candidates = [
    process.env.OPERATIONS_ORDERS_EXCEL_PATH,
    path.resolve("data/pedidos-importados.csv"),
    path.resolve("data/pedidos-importados.xlsx"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function findDefaultWorkbook() {
  const candidates = [
    process.env.OPERATIONS_EXCEL_PATH,
    "C:/Users/carlos.saraiva/OneDrive - Sfera Multifranquias/Novas Premiações.xlsx",
    "C:/Users/carlos.saraiva/Downloads/Novas Premiações.xlsx",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
