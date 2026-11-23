import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { databaseConfigured, getSql, ensureSchema, loadDashboardFromDatabase } from './db.mjs';

const KEY = 'backlog-portal';
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const codes = {19826:'Partage',20740:'Madureira',21044:'Alcântara',21469:'Juiz de Fora',21470:'Benfica',21483:'Três Rios',22552:'Raul Soares',22554:'Além Paraíba',22555:'Manhuaçu',22588:'Leopoldina',23318:'Santos Dumont',25195:'Caratinga',23433:'Caratinga',23443:'Caratinga',23441:'Carangola',24064:'Aimorés'};
export const channelCode = value => String(value ?? '').match(/^\s*(\d+)(?:\s*[-–—]|\s*$)/)?.[1] || '';
const empty = () => ({name:'Nenhuma base compartilhada importada',rows:[],importedAt:null,version:null,history:[]});
const filePath = () => path.join(process.env.ACCESS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(),'data'), 'backlog-shared.json');

export function validateBacklog(input) {
  if (!input || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 500000) throw new Error('Envie uma base válida de até 500.000 pedidos.');
  const fields = ['id','channel','status','date','delivery','external','fiscal','segment','payment','time','cycle'];
  const seen = new Set();
  const rows = input.rows.map(raw => {
    const row = Object.fromEntries(fields.map(key => [key, String(raw?.[key] ?? '').trim().slice(0,500)]));
    if (!row.id || !channelCode(row.channel) || !row.status || !row.fiscal || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new Error('Há pedidos sem código, canal, situação ou data válida.');
    if (seen.has(row.id)) throw new Error('Há pedidos duplicados na base enviada.');
    seen.add(row.id); return row;
  });
  return { name:String(input.name || 'Planilha de pedidos').slice(0,255), rows };
}

function withImport(previous, input) {
  const importedAt = new Date().toISOString();
  const byStore = {};
  for (const row of input.rows) {
    if (!['naofaturado','dispfaturamento'].includes(normalize(row.fiscal))) continue;
    const code = channelCode(row.channel); byStore[code] = (byStore[code] || 0) + 1;
  }
  return {...input, importedAt, version:randomUUID(), history:[...(previous?.history || []), {importedAt,byStore}].slice(-1000)};
}

export async function loadBacklog() {
  if (databaseConfigured()) {
    const sql = getSql(); await ensureSchema(sql);
    const [row] = await sql`select data from public.dashboard_snapshots where key=${KEY}`;
    return row?.data || empty();
  }
  try { return JSON.parse(await fs.readFile(filePath(),'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
}

let fileWrite = Promise.resolve();
export async function saveBacklog(input) {
  const validated = validateBacklog(input);
  if (databaseConfigured()) {
    const sql = getSql(); await ensureSchema(sql);
    return sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(727011)`;
      const [previous] = await tx`select data from public.dashboard_snapshots where key=${KEY}`;
      const next = withImport(previous?.data, validated);
      await tx`insert into public.dashboard_snapshots (key,data,source_file,source_modified_at) values (${KEY},${tx.json(next)},${next.name},${next.importedAt}) on conflict (key) do update set data=excluded.data,source_file=excluded.source_file,source_modified_at=excluded.source_modified_at,updated_at=now()`;
      return next;
    });
  }
  const write = fileWrite.catch(()=>{}).then(async () => {
    const next = withImport(await loadBacklog(),validated);
    const file = filePath(); await fs.mkdir(path.dirname(file),{recursive:true});
    const temp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temp,JSON.stringify(next),{flag:'wx',mode:0o600}); await fs.rename(temp,file);
    return next;
  });
  fileWrite = write; return write;
}

export async function storeDirectory() {
  let dashboard;
  if (databaseConfigured()) dashboard = await loadDashboardFromDatabase(getSql());
  else { try { dashboard = JSON.parse(await fs.readFile(path.join(process.cwd(),'data/dashboard-snapshot.json'),'utf8')); } catch {} }
  return {...codes,...Object.fromEntries((dashboard?.stores || []).filter(row=>row.storeCode&&row.store).map(row=>[String(row.storeCode),row.store]))};
}

export function scopeBacklog(base, user, directory = codes) {
  const admin = user.accountType === 'admin';
  const allowedNames = new Set((user.stores || []).map(normalize));
  const allowedCodes = Object.keys(directory).filter(code=>admin || allowedNames.has(normalize(directory[code])));
  const allowed = new Set(allowedCodes);
  const rows = admin ? base.rows : base.rows.filter(row=>allowed.has(channelCode(row.channel)));
  const countHistory = (base.history || []).map(item=>({importedAt:item.importedAt,total:Object.entries(item.byStore).reduce((sum,[code,count])=>sum+(admin||allowed.has(code)?Number(count):0),0)}));
  return {name:base.name,importedAt:base.importedAt,version:base.version,rows,countHistory,canImport:admin,stores:Object.fromEntries(allowedCodes.map(code=>[code,directory[code]]))};
}
