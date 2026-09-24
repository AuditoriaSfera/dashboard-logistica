# Dashboard de Operações

Dashboard local e responsivo conectado à planilha `Novas Premiações.xlsx`. A aplicação lê as 11 abas operacionais, normaliza lojas e períodos, recalcula os indicadores e atualiza a interface quando o arquivo é salvo.

## Como iniciar

1. Dê duplo clique em `INICIAR_DASHBOARD.cmd`.
2. Aguarde aparecerem os endereços da API e do dashboard.
3. Abra `http://localhost:3000` no navegador.
4. Para encerrar, feche a janela do inicializador ou pressione `Ctrl+C`.

O caminho padrão da fonte é:

`C:\Users\carlos.saraiva\OneDrive - Sfera Multifranquias\Novas Premiações.xlsx`

Para usar outro arquivo, defina `OPERATIONS_EXCEL_PATH` antes de iniciar:

```powershell
$env:OPERATIONS_EXCEL_PATH = 'C:\caminho\Nova Planilha.xlsx'
.\INICIAR_DASHBOARD.cmd
```

## Componentes

- API local: `http://127.0.0.1:8788`
- Interface: `http://localhost:3000`
- Configuração de metas: `config/metrics.json`
- Parser e normalização: `server/parser.mjs`
- Servidor e monitor do arquivo: `server/index.mjs`
- Interface: `app/page.tsx`
- Testes: `tests/parser.test.mjs`

Ao abrir qualquer indicador, o ranking mostra todas as 14 lojas em ordem decrescente, incluindo resultado e status da meta. Em Retirada e Trilogo, uma loja sem ocorrência registrada no período recebe resultado zero e fica dentro do limite de até 3. Retirada é apurada exclusivamente por loja e cada célula marcada nas colunas de pontuação conta uma vez; sem loja selecionada, a situação geral permanece em branco.

O código da loja aparece junto ao nome nos filtros, rankings, matriz, alertas e visão 360°. Os filtros de data inicial e final recalculam os indicadores usando somente registros com data dentro do intervalo inclusivo selecionado. O filtro de ciclo oferece os 17 intervalos oficiais de 2026; selecionar um ciclo aplica automaticamente suas datas sem preencher ou alterar os dois campos de data manual. Quando ciclo e datas manuais são usados juntos, vale a interseção dos intervalos.

## Atualização dos dados

O servidor mantém os dados em memória e monitora a planilha. Ao salvar o Excel, o cache é reconstruído. O botão **Atualizar dados** força uma nova leitura imediata.

O arquivo original é somente leitura para esta aplicação: os testes verificam que tamanho e data de modificação não mudam durante o processamento.

## Metas e score

As metas operacionais aprovadas são: PEC / OMNI 99%, Medallia 93%, Plataforma Logística 93%, Recebimento 100% no prazo, Arruamento 92%, Retirada até 3 pedidos, Trilogo até 3 chamados e Quebra de Estoque até 1%. Qualquer recebimento atrasado deixa o indicador fora da meta. Saldo de Pedidos, Retirada Cancelados e Entrega Cancelados são apenas informativos e permanecem sem meta.

Nos três indicadores informativos, o painel usa o fechamento `Saldo total`: Saldo de Pedidos mostra o percentual faturado, limitado a 100%; os dois indicadores de cancelamento mostram `100% − taxa cancelada`. Assim, valores mais próximos de 100% representam melhor desempenho.

O Score Operacional permanece desativado até que pesos sejam aprovados e inseridos em `config/metrics.json`.

## Verificação técnica

```powershell
$node = 'C:\Users\carlos.saraiva\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $node --test tests\parser.test.mjs
```

O projeto também passou por lint, build de produção e testes reais no navegador em 1440×900 e 390×844.
