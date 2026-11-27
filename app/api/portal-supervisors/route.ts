import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, ensureSchema, getSql, logAuditEvent } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, private", Vary: "Cookie" };
const REGIONALS = new Set(["Regional Regilane", "Regional Guilherme", "Regional Luanna"]);
const LOCAL_FILE = path.join(process.env.ACCESS_DATA_DIR || path.join(process.cwd(), "data"), "portal-supervisor-contacts.json");
type Contact = { regional: string; supervisorName: string; phone: string; updatedAt?: string };

async function localContacts(): Promise<Contact[]> {
  try { return JSON.parse(await fs.readFile(LOCAL_FILE, "utf8")) as Contact[]; }
  catch { return []; }
}

async function saveLocal(contact: Contact) {
  const list = await localContacts();
  const next = [...list.filter((item) => item.regional !== contact.regional), { ...contact, updatedAt: new Date().toISOString() }];
  await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
  const temp = `${LOCAL_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(next));
  await fs.rename(temp, LOCAL_FILE);
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (access.user.accountType !== "admin") return NextResponse.json({ error: "Apenas administradores podem acessar as mensagens para supervisores." }, { status: 403, headers });
  try {
    if (databaseConfigured()) {
      const sql = getSql();
      await ensureSchema(sql);
      const rows: Array<{ regional: string; supervisor_name: string; phone: string; updated_at: Date }> = await sql`select regional, supervisor_name, phone, updated_at from public.portal_supervisor_contacts order by regional`;
      return NextResponse.json({ contacts: rows.map((row) => ({ regional: row.regional, supervisorName: row.supervisor_name, phone: row.phone, updatedAt: row.updated_at?.toISOString?.() })) }, { headers });
    }
    return NextResponse.json({ contacts: await localContacts() }, { headers });
  } catch {
    return NextResponse.json({ error: "Não foi possível carregar os contatos dos supervisores." }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (access.user.accountType !== "admin") return NextResponse.json({ error: "Apenas administradores podem atualizar contatos de supervisores." }, { status: 403, headers });
  if (request.headers.get("x-sfera-supervisor-contact") !== "save" || request.headers.get("sec-fetch-site") === "cross-site" || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) {
    return NextResponse.json({ error: "Origem da solicitação não permitida." }, { status: 403, headers });
  }
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { return NextResponse.json({ error: "Envie os dados do contato." }, { status: 400, headers }); }
  const regional = String(input.regional || "").trim();
  const supervisorName = String(input.supervisorName || "").trim().slice(0, 100);
  const digits = String(input.phone || "").replace(/\D/g, "");
  const phone = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
  if (!REGIONALS.has(regional) || !supervisorName || phone.length < 12 || phone.length > 13) {
    return NextResponse.json({ error: "Informe uma regional, o nome do supervisor e um WhatsApp com DDD válido." }, { status: 400, headers });
  }
  const contact = { regional, supervisorName, phone };
  try {
    if (databaseConfigured()) {
      const sql = getSql();
      await ensureSchema(sql);
      await sql`insert into public.portal_supervisor_contacts (regional, supervisor_name, phone, updated_by, updated_at)
        values (${regional}, ${supervisorName}, ${phone}, ${access.user.id || access.user.email || null}, now())
        on conflict (regional) do update set supervisor_name = excluded.supervisor_name, phone = excluded.phone, updated_by = excluded.updated_by, updated_at = now()`;
      await logAuditEvent(sql, { actor: access.user, action: "portal-supervisor-contact-save", entityType: "portal-supervisor-contact", entityId: regional, metadata: { regional, supervisorName }, request });
    } else await saveLocal(contact);
    return NextResponse.json({ ok: true, contact }, { headers });
  } catch {
    return NextResponse.json({ error: "Não foi possível salvar o contato do supervisor." }, { status: 503, headers });
  }
}
