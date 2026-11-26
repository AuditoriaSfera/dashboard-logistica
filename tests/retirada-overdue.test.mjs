import test from 'node:test';
import assert from 'node:assert/strict';
import { filterRetiradaOverdueEvents, isRetiradaDeliveryType } from '../server/retirada-overdue.mjs';

test('Retirada contabilizada inclui somente pedidos de retirada na Central', () => {
  assert.equal(isRetiradaDeliveryType('Retirada na Central'), true);
  assert.equal(isRetiradaDeliveryType('Retirar na Central de Serviços'), true);
  assert.equal(isRetiradaDeliveryType('No endereço de entrega'), false);

  const events = [
    { orderCode: 'R-1', deliveryType: 'Retirada na Central' },
    { orderCode: 'E-1', deliveryType: 'No endereço de entrega' },
    { orderCode: 'R-2', deliveryType: 'Retirar na Central de Serviços' },
  ];
  assert.deepEqual(filterRetiradaOverdueEvents(events).map((event) => event.orderCode), ['R-1', 'R-2']);
});
