import test from 'node:test';
import assert from 'node:assert/strict';
import { findReceivingColumns } from '../app/receiving-import.mjs';

test('localiza NF, data de entrada e loja no CSV sintético de notas fiscais', () => {
  const rows = [
    ['Código da Loja', 'Código do Fornecedor', 'Nome do Fornecedor', 'Número do Documento', 'codigo da operacao', 'Data de entrada'],
    [19826, 21044, 'BTSG COSMETICOS LTDA', 1551, 4, '19/11/2026'],
  ];
  assert.deepEqual(findReceivingColumns(rows), { headerRow: 0, invoice: 3, entry: 5, store: 0 });
});

test('continua aceitando os cabeçalhos tradicionais de recebimento', () => {
  const rows = [
    ['Loja', 'Número da Nota Fiscal', 'Data da Entrada'],
    ['Partage', '1551', '19/11/2026'],
  ];
  assert.deepEqual(findReceivingColumns(rows), { headerRow: 0, invoice: 1, entry: 2, store: 0 });
});
