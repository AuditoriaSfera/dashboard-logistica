# Análise técnica da planilha e do dashboard

## Fonte utilizada

Foi selecionada a cópia mais recente encontrada:

`C:\Users\carlos.saraiva\OneDrive - Sfera Multifranquias\Novas Premiações.xlsx`

A cópia em OneDrive estava mais atualizada que a cópia em Downloads. O processamento é somente leitura.

## Estrutura das 11 fontes

| Indicador | Aba real | Estrutura e cálculo adotado |
|---|---|---|
| PEC / OMNI | `PEC - OMNI` | Linhas por ciclo e loja; usa `% atingida`. |
| Medallia | `Medallia` | Ciclo, loja, quantidade de respostas, NPS e reclamações; consolidado ponderado pelo volume de respostas. |
| Plataforma Logística | `Plataforma Logística` | Ciclo e loja; resultado de uso/atingimento e informação de entrega no prazo. |
| Recebimento | `Recebimento` | Grão de nota fiscal; SLA recalculado como conferência em até 2 dias. |
| Arruamento | `Arruamento` | Totais de SKU, arruados e sem arruamento; percentual consolidado pelos volumes. |
| Retirada | `Retirada` | Marcações de falha de separação/cancelamento; cada célula marcada representa uma pontuação e o limite é 3 por loja. |
| Trilogo | `Trilogo` | Lista de chamados com abertura, verificação e status; cada ticket representa um chamado e o limite é até 3. |
| Quebra de Estoque | `Quebra` | Itens quebrados e vendidos; taxa ponderada = soma das quebras / soma dos itens vendidos. |
| Saldo de Pedidos | `Saldo de pedidos` | Usa o fechamento `Saldo total` por loja; desempenho = percentual faturado, limitado a 100%. |
| Retirada Cancelados | `Retirada cancelados` | Usa `Saldo total`; desempenho = `100% − cancelados / captados`. |
| Entrega Cancelados | `Entrega Cancelados` | Usa `Saldo total`; desempenho = `100% − cancelados / captados`. |

## Normalização

- 14 lojas canônicas: Aimorés, Alcântara, Além Paraíba, Benfica, Carangola, Caratinga, Juiz de Fora, Leopoldina, Madureira, Manhuaçu, Partage, Raul Soares, Santos Dumont e Três Rios.
- Variações de caixa, acento e espaçamento são unificadas.
- O código incorreto `23554` de Além Paraíba é normalizado para `22554`.
- A grafia `Leopldina` é corrigida para Leopoldina.
- Os nomes reais das abas são resolvidos com tolerância a acentos, espaços e caixa.
- Resumos como `NPS TOTAL` são separados das linhas operacionais.

## Qualidade observada

- Data impossível `30/02/2026` na base Trilogo, registrada como alerta alto.
- Aba Arruamento formatada até mais de um milhão de linhas, embora só cerca de 133 possuam conteúdo; o parser percorre apenas a região útil.
- Bases de cancelamento e saldo usam colunas repetidas por dia e exigem transformação de largo para longitudinal.
- Há nomes/códigos de lojas inconsistentes e células vazias; correções ficam registradas no painel de qualidade.
- Algumas abas contêm linhas de totalização que não podem ser tratadas como loja.
- As metas aprovadas pela liderança são mantidas na configuração da aplicação, independentemente de células inconsistentes nas abas.

## Arquitetura implementada

```text
Excel local/OneDrive
  → resolvedor das 11 abas
  → parsers específicos por estrutura
  → registros normalizados por indicador, loja e período
  → validações de qualidade e cache em memória
  → monitor de alterações do arquivo
  → API Express local
  → dashboard React responsivo
```

Endpoints principais:

- `GET /api/health`: saúde da API e da fonte.
- `GET /api/dashboard`: modelo completo do dashboard.
- `POST /api/refresh`: força releitura da planilha.

## Telas e recursos

- Visão geral executiva com 11 KPIs, evolução, alertas e mapa de performance.
- Página por indicador com resultado, meta, diferença, tendência e ranking.
- Ranking por indicador com todas as 14 lojas, resultado, status e ordenação decrescente.
- Código da loja exibido junto ao nome em todas as superfícies de identificação.
- Visão 360° por loja.
- Ranking comparativo e matriz de performance.
- Reclamações do Medallia e volumes de cancelamento.
- Painel de qualidade dos dados.
- Filtros globais combináveis por ciclo, data inicial, data final, loja, indicador e status, com recálculo de KPIs, séries, rankings e matriz. Os ciclos 1 a 17 seguem os intervalos oficiais de 2026 e aplicam suas datas sem modificar os campos manuais.
- Estados sem informação e sem histórico suficiente tratados explicitamente.

## Metas e governança

As metas ficam centralizadas em `config/metrics.json`:

| Indicador | Meta | Regra de status |
|---|---:|---|
| PEC / OMNI | 99% | Resultado maior ou igual a 99%. |
| Medallia | 93% | Resultado maior ou igual a 93%. |
| Plataforma Logística | 93% | Resultado maior ou igual a 93%. |
| Recebimento | 100% | Todos os recebimentos no SLA de até 2 dias; um atraso já deixa o indicador fora. |
| Arruamento | 92% | Resultado maior ou igual a 92%. |
| Retirada | 3 Pedidos | Contagem das marcações da própria loja menor ou igual a 3; sem loja selecionada, a situação consolidada fica em branco. |
| Trilogo | Até 3 chamados | Soma de tickets menor ou igual a 3. |
| Quebra de Estoque | Até 1% | Taxa menor ou igual a 1%. |
| Saldo de Pedidos | Sem meta | Percentual do fechamento `Saldo total`, limitado a 100%; quanto maior, melhor. |
| Retirada Cancelados | Sem meta | `100% − Saldo total`; quanto maior, menor a taxa de cancelamento. |
| Entrega Cancelados | Sem meta | `100% − Saldo total`; quanto maior, menor a taxa de cancelamento. |

Não existe faixa de tolerância não aprovada: o resultado está dentro ou fora conforme o limite exato. Pesos de score permanecem nulos; portanto, nenhum score composto é apresentado sem aprovação da liderança.

Para Retirada e Trilogo, a base registra somente ocorrências. Por isso, a ausência de uma loja no período representa zero pedidos/chamados em atraso, e a loja fica dentro da meta. Essa imputação não é aplicada aos demais indicadores: ausência continua aparecendo como sem informação.

## Validação realizada

- 11 abas resolvidas.
- 14 lojas canônicas.
- 1.711 registros válidos no modelo atual; os três fechamentos usam uma linha por loja e período, sem repetir as colunas diárias.
- Ciclos ordenados numericamente, garantindo que 12 venha depois de 9.
- Quebra ponderada pelos itens vendidos.
- Saldo e cancelamentos transformados e validados.
- Planilha original preservada durante a leitura.
- 13 testes automatizados aprovados.
- Lint e build de produção aprovados.
- Teste real no navegador em desktop 1440×900 e celular 390×844.
- Navegação validada entre visão geral, indicador Medallia e visão 360°.
- Filtros combinados validados com loja Aimorés e ciclo 11.
