import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyRetiradaOverdueEvents, eventFromRow, filterRetiradaOverdueEvents, isRetiradaDeliveryType, recordNewlyOverdueOrders } from '../server/retirada-overdue.mjs';

test('Retirada contabilizada inclui somente pedidos de retirada na Central', () => {
  assert.equal(isRetiradaDeliveryType('Retirada na Central'), true);
  assert.equal(isRetiradaDeliveryType('Retirar na Central de Serviços'), true);
  assert.equal(isRetiradaDeliveryType('No endereço de entrega'), false);

  const events = [
    { orderCode: 'R-1', storeCode: '21470', captureDate: '2026-11-22', deliveryType: 'Retirada na Central' },
    { orderCode: 'E-1', storeCode: '21470', captureDate: '2026-11-22', deliveryType: 'No endereço de entrega' },
    { orderCode: 'R-2', storeCode: '21470', captureDate: '2026-11-20', deliveryType: 'Retirar na Central de Serviços' },
    { orderCode: 'R-old', storeCode: '21470', captureDate: '2026-11-18', deliveryType: 'Retirada na Central' },
  ];
  assert.deepEqual(filterRetiradaOverdueEvents(events, '2026-11-26').map((event) => event.orderCode), ['R-1', 'R-2']);
});

test('Retirada contabilizada normaliza datas retornadas pelo PostgreSQL', () => {
  const event = eventFromRow({
    id: 'event-1', store_code: '21470', store_name: 'Benfica', order_code: '123', cycle: 16,
    capture_date: new Date('2026-11-20T00:00:00.000Z'),
    overdue_date: new Date('2026-11-26T00:00:00.000Z'), delivery_type: 'Retirada na Central',
  });
  assert.equal(event.captureDate, '2026-11-20');
  assert.equal(event.overdueDate, '2026-11-26');
});

test('Retirada conta uma unidade de resultado por loja, ciclo e dia, mas preserva cada pedido', () => {
  const snapshot = { stores: [], filters: { stores: [] }, indicators: { retirada: { records: [] } } };
  const events = Array.from({ length: 71 }, (_, index) => ({
    storeCode: '21470', store: 'Benfica', orderCode: `P-${index + 1}`, cycle: 16,
    captureDate: '2026-11-22', overdueDate: '2026-11-26', deliveryType: 'Retirada na Central',
  }));
  const result = applyRetiradaOverdueEvents(snapshot, events);
  const records = result.indicators.retirada.records;
  assert.equal(records.length, 71);
  assert.equal(records.filter((row) => row.notes).length, 71);
  assert.equal(records.reduce((sum, row) => sum + row.value, 0), 1);
});

test('a apuração diária usa somente o primeiro backlog de retirada importado naquele dia', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retirada-diaria-'));
  const previousDirectory = process.env.ACCESS_DATA_DIR;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.ACCESS_DATA_DIR = directory;
  const makeBase = (importedAt, ids) => ({
    importsByType: { pickup: { importedAt } },
    rows: ids.map((id) => ({ id, channel: '21470 - Benfica', fiscal: 'Não faturado', status: 'Aberto', date: '2026-11-23', delivery: 'Retirada na Central', time: '09:00', cycle: '16' })),
  });
  try {
    // O último snapshot de ontem não pode gerar os eventos de hoje.
    await recordNewlyOverdueOrders(makeBase('2026-11-26T12:00:00.000Z', ['ontem']), '2026-11-27');
    await assert.rejects(fs.readFile(path.join(directory, 'retirada-overdue-daily-runs.json'), 'utf8'), { code: 'ENOENT' });

    // A primeira importação de retirada de hoje fecha a apuração, mesmo que não houvesse atrasos.
    await recordNewlyOverdueOrders(makeBase('2026-11-27T12:00:00.000Z', ['primeiro']), '2026-11-27');
    // Uma importação posterior no mesmo dia não substitui a fotografia já apurada.
    await recordNewlyOverdueOrders(makeBase('2026-11-27T15:00:00.000Z', ['primeiro', 'posterior']), '2026-11-27');
    const firstDay = JSON.parse(await fs.readFile(path.join(directory, 'retirada-overdue-events.json'), 'utf8'));
    assert.deepEqual(firstDay.map((event) => event.orderCode), ['primeiro']);

    // A próxima data recebe uma nova apuração a partir do primeiro backlog daquele dia.
    await recordNewlyOverdueOrders(makeBase('2026-11-28T12:00:00.000Z', ['novo-dia']), '2026-11-28');
    const allEvents = JSON.parse(await fs.readFile(path.join(directory, 'retirada-overdue-events.json'), 'utf8'));
    assert.deepEqual(allEvents.map((event) => event.orderCode), ['primeiro', 'novo-dia']);
  } finally {
    if (previousDirectory === undefined) delete process.env.ACCESS_DATA_DIR;
    else process.env.ACCESS_DATA_DIR = previousDirectory;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
