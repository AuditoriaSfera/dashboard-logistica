# Dashboard Logística

As regras de commit, deploy (Railway via push no GitHub), verificação e armadilhas conhecidas estão em
[AGENTS.md](AGENTS.md). **Leia antes de alterar ou publicar.**

Resumo: rode `npm run verify` antes de qualquer `git push origin main`; o Railway publica sozinho e o status
do deploy se consulta pela API do GitHub (sem acesso ao Railway).
