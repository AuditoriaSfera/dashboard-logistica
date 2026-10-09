import { NextResponse } from "next/server";
import { authorize } from "../../../../server/auth.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A importação da planilha de PEDIDOS depende do leitor em Python (openpyxl) do servidor local, que o Railway
// não tem. Até existir um leitor em Node, esta rota explica o caminho suportado em vez de devolver um 404 em HTML
// (que a tela mostrava como "Não foi possível importar o arquivo").
export async function POST(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  return NextResponse.json({
    error: "A importação de pedidos ainda não está disponível na versão online. Importe a planilha pelo servidor local (INICIAR_DASHBOARD.cmd) com a DATABASE_URL do banco configurada: os pedidos são gravados no banco e aparecem aqui automaticamente.",
  }, { status: 501 });
}
