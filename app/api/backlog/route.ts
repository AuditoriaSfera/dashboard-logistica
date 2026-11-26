import { NextResponse } from 'next/server';
import { authorize } from '../../../server/auth.mjs';
import { loadBacklog, saveBacklog, scopeBacklog, storeDirectory } from '../../../server/backlog.mjs';
import { listRetiradaOverdueEvents, recordNewlyOverdueOrders } from '../../../server/retirada-overdue.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = {'Cache-Control':'no-store, private',Vary:'Cookie'};
const normalizeStore = (value: unknown) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function scopeOverdueEvents(events: any[], user: { accountType: string; stores: string[] }) {
  if (user.accountType === 'admin') return events;
  const allowed = new Set((user.stores || []).map(normalizeStore));
  return events.filter((event) => allowed.has(normalizeStore(event.store)) || allowed.has(normalizeStore(`${event.storeCode} ${event.store}`)));
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  try {
    const base = await loadBacklog();
    await recordNewlyOverdueOrders(base);
    const [directory, overdueEvents] = await Promise.all([storeDirectory(), listRetiradaOverdueEvents()]);
    return NextResponse.json({ ...scopeBacklog(base,access.user,directory), overdueEvents: scopeOverdueEvents(overdueEvents,access.user) },{headers});
  } catch { return NextResponse.json({error:'Não foi possível consultar a base compartilhada. Tente novamente.'},{status:503,headers}); }
}

export async function POST(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (access.user.accountType !== 'admin') return NextResponse.json({error:'Somente administradores podem importar a base compartilhada.'},{status:403,headers});
  if (request.headers.get('x-sfera-backlog') !== 'import' || request.headers.get('sec-fetch-site') === 'cross-site' || !/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return NextResponse.json({error:'Solicitação de importação não permitida.'},{status:403,headers});
  const limit = 80 * 1024 * 1024;
  if (Number(request.headers.get('content-length')) > limit) return NextResponse.json({error:'A base excede 80 MB.'},{status:413,headers});
  let input;
  try {
    const reader = request.body?.getReader(); if (!reader) throw new Error();
    let size=0; const chunks: Uint8Array[]=[];
    while (true) { const {done,value}=await reader.read(); if(done) break; size+=value.byteLength; if(size>limit) {await reader.cancel(); return NextResponse.json({error:'A base excede 80 MB.'},{status:413,headers});} chunks.push(value); }
    input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return NextResponse.json({error:'Envie uma base JSON válida.'},{status:400,headers}); }
  try {
    const base = await saveBacklog(input);
    await recordNewlyOverdueOrders(base);
    const [directory, overdueEvents] = await Promise.all([storeDirectory(), listRetiradaOverdueEvents()]);
    return NextResponse.json({ ...scopeBacklog(base,access.user,directory), overdueEvents: scopeOverdueEvents(overdueEvents,access.user) },{headers});
  } catch (error) { return NextResponse.json({error:error instanceof Error && /pedidos|base válida/.test(error.message)?error.message:'Não foi possível salvar a importação. A base anterior foi preservada.'},{status:503,headers}); }
}
