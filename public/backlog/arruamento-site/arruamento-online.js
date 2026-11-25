(function () {
  'use strict';
  function create(options) {
    const $ = options.$;
    let running = false;
    const status = (message) => { const node = $('cloudStatus'); if (node) node.textContent = message; };
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    };
    async function sync() {
      if (running || document.visibilityState === 'hidden') return;
      running = true;
      const button = $('cloudSync'); if (button) button.disabled = true;
      status('Atualizando dados do Portal de Pedidos…');
      try {
        const response = await fetch('/api/arruamento-portal/snapshots', { credentials: 'same-origin', cache: 'no-store' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Não foi possível consultar o Arruamento online.');
        options.setData(result);
        status(`Dados do portal atualizados · ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
      } catch (error) {
        status(error instanceof Error ? error.message : 'Não foi possível atualizar os dados do portal.');
      } finally {
        running = false;
        if (button) button.disabled = false;
      }
    }
    function exportAll() {
      const snapshots = [...options.getSnapshots().values()].filter(options.validSnapshot);
      if (!snapshots.length) { status('Nenhuma base disponível para exportação.'); return; }
      try {
        const X = options.getReader(), book = X.utils.book_new();
        const products = [['PDV', 'Loja', 'Ano', 'Ciclo', 'Início do ciclo', 'Fim do ciclo', 'SKU', 'Produto', 'Categoria', 'Curva ABC', 'Quantidade vendida', 'Faturamento', 'Estoque', 'Lucro', 'Situação', 'Encontrado no arruamento', 'Endereços cadastrados', 'Importado em']];
        const addresses = [['PDV', 'Loja', 'Ano', 'Ciclo', 'SKU', 'Estação', 'Rack', 'Linha', 'Coluna', 'Endereço original', 'Situação do endereço']];
        const imports = [['PDV', 'Loja', 'Ano', 'Ciclo', 'Início do ciclo', 'Fim do ciclo', 'Importado em', 'Arquivo de arruamento', 'Arquivo de Curva ABC', 'SKUs']];
        for (const snapshot of snapshots) {
          imports.push([snapshot.code, snapshot.store, snapshot.year, snapshot.cycle, snapshot.periodStart, snapshot.periodEnd, snapshot.importedAt, snapshot.sources?.route || '', snapshot.sources?.abc || '', snapshot.rows.length]);
          for (const row of snapshot.rows) {
            products.push([snapshot.code, snapshot.store, snapshot.year, snapshot.cycle, snapshot.periodStart, snapshot.periodEnd, String(row.sku), row.desc || '', row.category || '', row.curve || '', row.qty, row.revenue, row.stock, row.profit, row.arruado ? 'Arruado' : row.partial ? 'Endereço incompleto' : 'Não arruado', row.matched ? 'Sim' : 'Não', (row.locations || []).join(' | '), snapshot.importedAt]);
            for (const location of row.locations || []) {
              const parts = location.split(' / ');
              addresses.push([snapshot.code, snapshot.store, snapshot.year, snapshot.cycle, String(row.sku), ...Array.from({ length: 4 }, (_, index) => parts[index] && parts[index] !== '—' ? parts[index] : ''), location, parts.length === 4 && parts.every((part) => part && part !== '—') ? 'Completo' : 'Incompleto']);
            }
          }
        }
        for (const [name, rows] of [['Produtos', products], ['Endereços', addresses], ['Importações', imports]]) {
          const sheet = X.utils.aoa_to_sheet(rows);
          sheet['!cols'] = rows[0].map((heading) => ({ wch: /Produto|Endere|Arquivo/.test(heading) ? 50 : /Loja|Importado/.test(heading) ? 27 : 20 }));
          sheet['!autofilter'] = { ref: sheet['!ref'] };
          X.utils.book_append_sheet(book, sheet, name);
        }
        download(new Blob([X.write(book, { type: 'array', bookType: 'xlsx', compression: true })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'Arruamento_Completo_Sfera.xlsx');
      } catch (error) { status(`Erro na exportação: ${error instanceof Error ? error.message : 'não foi possível gerar o arquivo.'}`); }
    }
    $('cloudSync')?.addEventListener('click', sync);
    $('cloudExcel')?.addEventListener('click', exportAll);
    $('cloudBackup')?.addEventListener('click', () => {
      const snapshots = [...options.getSnapshots().values()];
      download(new Blob([JSON.stringify(snapshots, null, 2)], { type: 'application/json' }), 'Backup_Arruamento_Sfera.json');
    });
    window.addEventListener('online', sync);
    const timer = setInterval(sync, 10000);
    window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
    return { sync, remove: async () => false, exportAll };
  }
  window.SferaArruamentoOnline = { create };
})();
