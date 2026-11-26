import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFromRow, filterRetiradaOverdueEvents, isRetiradaDeliveryType } from '../server/retirada-overdue.mjs';

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
