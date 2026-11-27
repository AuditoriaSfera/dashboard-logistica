/** @param {unknown} value */
export const normalizeReceivingHeader = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** @param {unknown[][]} rows */
export function findReceivingColumns(rows) {
  for (let index = 0; index < Math.min(rows.length, 40); index += 1) {
    const values = rows[index].map(normalizeReceivingHeader);
    const invoice = values.findIndex((value) => value === "nf" || value.includes("numerodanotafiscal") || value.includes("notafiscal") || value.includes("numeronf") || value.includes("numerododocumento"));
    const entry = values.findIndex((value) => value.includes("dataentrada") || value.includes("entrada") && value.includes("data"));
    const store = values.findIndex((value) => value === "loja" || value.includes("codigodaloja") || value.includes("codigoloja") || value.includes("storecode"));
    if (invoice >= 0 && entry >= 0) return { headerRow: index, invoice, entry, store };
  }
  return null;
}
