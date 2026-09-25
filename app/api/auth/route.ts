import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TEMP_PASSWORD = "Sfera@2026";
const storePath = path.join(process.cwd(), "data", "access-users.json");

type AccessUser = {
  id: string;
  name: string;
  email: string;
  accountType: "admin" | "unit";
  stores: string[];
  password?: string;
  mustChangePassword?: boolean;
  resetNotice?: string;
  status: "pending" | "approved" | "rejected" | "inactive";
  requestedAt?: string;
  active: boolean;
  [key: string]: unknown;
};

type AuthStore = { users: AccessUser[]; resetRequests: unknown[] };

function defaultStore(): AuthStore {
  return {
    users: [{ id: "admin-inicial", name: "Administrador Sfera", email: "admin@sfera.local", accountType: "admin", stores: [], password: TEMP_PASSWORD, mustChangePassword: true, status: "approved", active: true }],
    resetRequests: [],
  };
}

function readStore(): AuthStore {
  try {
    if (!fs.existsSync(storePath)) {
      const initial = defaultStore();
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(initial, null, 2));
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8")) as Partial<AuthStore>;
    const users = Array.isArray(parsed.users) ? parsed.users as AccessUser[] : [];
    if (!users.some((user) => user.email?.toLowerCase() === "admin@sfera.local")) users.unshift(defaultStore().users[0]);
    return { users, resetRequests: Array.isArray(parsed.resetRequests) ? parsed.resetRequests : [] };
  } catch {
    return defaultStore();
  }
}

function writeStore(store: AuthStore) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tempPath = `${storePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(store, null, 2));
  fs.renameSync(tempPath, storePath);
}

export async function GET() {
  return NextResponse.json(readStore());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Partial<AuthStore>;
    const current = readStore();
    const next: AuthStore = {
      users: Array.isArray(body.users) ? body.users as AccessUser[] : current.users,
      resetRequests: Array.isArray(body.resetRequests) ? body.resetRequests : current.resetRequests,
    };
    if (!next.users.some((user) => user.email?.toLowerCase() === "admin@sfera.local")) next.users.unshift(defaultStore().users[0]);
    writeStore(next);
    return NextResponse.json(next);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível salvar os usuários." }, { status: 400 });
  }
}
