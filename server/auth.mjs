import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

export const TEMP_PASSWORD = "Sfera@2026";
export const SESSION_COOKIE = "sfera_session";
const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const TEMP_SESSION_AGE = 30 * 60 * 1000;
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const VALID_STATUSES = new Set(["pending", "approved", "rejected", "inactive"]);
const ADMIN_ACTIONS = new Set(["create-user", "update-user", "reset-password", "delete-user"]);

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function validHash(value) { return typeof value === "string" && /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value); }
function passwordMatches(password, encoded) {
  if (!validHash(encoded)) return false;
  const [, salt, expected] = encoded.split(":");
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, "hex"));
}
const DUMMY_PASSWORD_HASH = `scrypt:${"0".repeat(32)}:${"0".repeat(128)}`;

function safeUser(user) {
  const result = {
    id: user.id, name: user.name, email: user.email, accountType: user.accountType,
    stores: [...user.stores], status: user.status, active: user.active,
    mustChangePassword: user.mustChangePassword,
  };
  for (const key of ["phone", "company", "requestedAt"]) {
    if (typeof user[key] === "string") result[key] = user[key];
  }
  return result;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new AuthError(503, "A base de usuários está indisponível. Nenhuma conta foi redefinida. Contate o administrador."); }
}

function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function corruptStore() {
  throw new AuthError(503, "A base de usuários precisa de verificação. Nenhuma conta foi redefinida. Contate o administrador.");
}

function validateStore(store) {
  if (!store || store.version !== 2 || !Array.isArray(store.users) || !store.users.length || !Array.isArray(store.sessions) || !store.loginAttempts || typeof store.loginAttempts !== "object" || Array.isArray(store.loginAttempts)) corruptStore();
  const ids = new Set();
  const emails = new Set();
  for (const user of store.users) {
    if (!user || typeof user.id !== "string" || !user.id || ids.has(user.id) || typeof user.name !== "string" || !user.name || typeof user.email !== "string" || !user.email || emails.has(user.email.toLowerCase()) || !["admin", "unit"].includes(user.accountType) || !Array.isArray(user.stores) || user.stores.some((item) => typeof item !== "string") || !VALID_STATUSES.has(user.status) || typeof user.active !== "boolean" || typeof user.mustChangePassword !== "boolean" || !validHash(user.passwordHash) || Object.hasOwn(user, "password")) corruptStore();
    ids.add(user.id); emails.add(user.email.toLowerCase());
  }
  for (const session of store.sessions) {
    if (!session || !/^[a-f0-9]{64}$/.test(session.tokenHash) || typeof session.userId !== "string" || !Number.isFinite(session.expiresAt)) corruptStore();
  }
  for (const attempt of Object.values(store.loginAttempts)) {
    if (!attempt || !Number.isInteger(attempt.count) || attempt.count < 0 || !Number.isFinite(attempt.expiresAt)) corruptStore();
  }
  return store;
}

function migrateLegacy(legacy) {
  if (!legacy || !Array.isArray(legacy.users) || !legacy.users.length || (legacy.version !== undefined && legacy.version !== 1)) corruptStore();
  const users = legacy.users.map((user) => {
    if (!user || typeof user !== "object" || typeof user.email !== "string" || typeof user.name !== "string" || typeof user.id !== "string" || !["admin", "unit"].includes(user.accountType) || !Array.isArray(user.stores) || !VALID_STATUSES.has(user.status)) corruptStore();
    // Missing credentials stay inaccessible until an administrator resets them.
    // Existing personal credentials are never replaced by a deployment/migration.
    const credential = typeof user.password === "string" && user.password.length ? user.password : null;
    return {
      ...safeUser({ ...user, active: user.active !== false, mustChangePassword: user.mustChangePassword === true || credential === TEMP_PASSWORD }),
      passwordHash: credential ? passwordHash(credential) : validHash(user.passwordHash) ? user.passwordHash : passwordHash(randomBytes(48).toString("hex")),
    };
  });
  return validateStore({ version: 2, users, sessions: [], loginAttempts: {}, resetRequests: Array.isArray(legacy.resetRequests) ? legacy.resetRequests : [] });
}

function response(body, status = 200, cookie) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" };
  if (cookie) headers["Set-Cookie"] = cookie;
  return new Response(JSON.stringify(body), { status, headers });
}

function cookieValue(request) {
  const cookies = request.headers.get("cookie") || "";
  const token = cookies.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function sessionCookie(request, token, age, environment) {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || environment.NODE_ENV === "production";
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(age / 1000)}${secure ? "; Secure" : ""}`;
}

function requireSameOrigin(request, environment) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const allowed = new Set([url.origin]);
  // Railway terminates TLS before forwarding HTTP to the Node server.
  if (request.headers.get("x-forwarded-proto") === "https") allowed.add(`https://${url.host}`);
  // The Node server may see Railway's internal host after TLS termination,
  // while Origin still contains the public service domain.
  if (environment.RAILWAY_PUBLIC_DOMAIN) {
    try {
      const publicUrl = /^https?:\/\//i.test(environment.RAILWAY_PUBLIC_DOMAIN)
        ? environment.RAILWAY_PUBLIC_DOMAIN
        : `https://${environment.RAILWAY_PUBLIC_DOMAIN}`;
      allowed.add(new URL(publicUrl).origin);
    } catch { /* An invalid platform value grants no origin. */ }
  }
  if (environment.ACCESS_APP_ORIGIN) {
    try { allowed.add(new URL(environment.ACCESS_APP_ORIGIN).origin); } catch { /* Invalid configuration grants no origin. */ }
  }
  if (!origin || !allowed.has(origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new AuthError(403, "Origem da solicitação não permitida.");
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) throw new AuthError(415, "Envie a solicitação no formato JSON.");
}

function profileInput(value, existing) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AuthError(400, "Informe os dados do usuário.");
  const forbidden = ["password", "passwordHash", "mustChangePassword", "sessions", "active", "id"];
  if (forbidden.some((key) => Object.hasOwn(value, key))) throw new AuthError(400, "Senha e estado de acesso só podem ser alterados pelas ações específicas.");
  const input = { ...existing, ...value };
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new AuthError(400, "Informe um nome válido.");
  if (typeof input.email !== "string" || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) throw new AuthError(400, "Informe um e-mail válido.");
  if (!["admin", "unit"].includes(input.accountType)) throw new AuthError(400, "Perfil inválido.");
  if (!Array.isArray(input.stores) || input.stores.length > 2000 || input.stores.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) throw new AuthError(400, "Informe as lojas permitidas.");
  if (input.accountType === "unit" && !input.stores.length) throw new AuthError(400, "Vincule pelo menos uma loja ao usuário da unidade.");
  const status = existing ? input.status : "approved";
  if (!VALID_STATUSES.has(status)) throw new AuthError(400, "Status inválido.");
  return {
    name: input.name.trim(), email: input.email.trim().toLowerCase(), accountType: input.accountType,
    stores: [...new Set(input.stores.map((item) => item.trim()))], status, active: status === "approved",
  };
}

function approved(user) { return Boolean(user && user.status === "approved" && user.active); }
function isAdmin(user) { return approved(user) && user.accountType === "admin"; }

/** Factory keeps integration tests isolated from the live data directory. */
export function createAuthHandlers(options = {}) {
  const environment = options.environment || process.env;
  const now = options.now || Date.now;
  const explicitDataDir = options.dataDir || environment.ACCESS_DATA_DIR || environment.RAILWAY_VOLUME_MOUNT_PATH;
  const railway = Boolean(environment.RAILWAY_PROJECT_ID || environment.RAILWAY_ENVIRONMENT_ID || environment.RAILWAY_ENVIRONMENT || environment.RAILWAY_SERVICE_ID);
  // Sem volume no Railway o serviço continua no ar em modo temporário: a base de usuários fica no disco
  // do container e volta ao administrador inicial a cada deploy. ACCESS_REQUIRE_VOLUME=true restaura o bloqueio.
  const ephemeral = railway && !explicitDataDir && environment.ACCESS_REQUIRE_VOLUME !== "true";
  const dataDir = path.resolve(explicitDataDir || options.ephemeralDataDir || path.join(process.cwd(), "data"));
  const storePath = path.join(dataDir, "access-users.json");
  // Explicit test directories never fall back to the real working directory.
  const legacyDir = path.resolve(options.legacyDataDir || (options.dataDir || options.ephemeralDataDir ? dataDir : path.join(process.cwd(), "data")));
  const legacyPath = path.join(legacyDir, "access-users.json");
  const lockPath = path.join(dataDir, "access-users.lock");
  if (ephemeral) console.warn("[auth] Railway sem volume persistente: usuários em modo temporário (reiniciam a cada deploy). Crie um volume e defina RAILWAY_VOLUME_MOUNT_PATH para preservar as contas.");

  function saveMigration(store) {
    const backupDir = path.join(dataDir, "auth-backups");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    writeJson(path.join(backupDir, `access-users-migration-${now()}-${randomUUID()}.json`), store);
    writeJson(storePath, store);
  }

  async function acquireLock() {
    const deadline = Date.now() + (options.lockTimeoutMs ?? 2500);
    while (true) {
      try { return fs.openSync(lockPath, "wx", 0o600); }
      catch (error) {
        // Windows can report EPERM during a pending unlink even when existsSync is false.
        const contention = error.code === "EEXIST" || error.code === "EPERM";
        if (!contention) throw error;
        if (Date.now() >= deadline) {
          if (error.code === "EPERM" && !fs.existsSync(lockPath)) throw error;
          throw new AuthError(503, "A base de usuários está ocupada. Tente novamente em instantes; se persistir, contate o administrador.");
        }
        await pause(25);
      }
    }
  }

  async function withStore(operation) {
    if (railway && !explicitDataDir && !ephemeral) throw new AuthError(503, "Configure um volume persistente para os usuários (RAILWAY_VOLUME_MOUNT_PATH ou ACCESS_DATA_DIR) antes de liberar o acesso.");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const lock = await acquireLock();
    try {
      let store;
      if (!fs.existsSync(storePath)) {
        // Backups without the primary file indicate data loss, not a fresh install.
        if (fs.existsSync(path.join(dataDir, "auth-backups"))) corruptStore();
        if (legacyPath !== storePath && fs.existsSync(legacyPath)) {
          const legacy = readJson(legacyPath);
          store = legacy?.version === 2 ? validateStore(legacy) : migrateLegacy(legacy);
          // Preserve the source during a move to a volume; only the destination is written.
          saveMigration(store);
        } else {
          if (railway && !ephemeral && environment.ACCESS_ALLOW_INITIAL_SETUP !== "true") throw new AuthError(503, "A base de usuários não está no volume. Restaure a base existente; para uma instalação nova, configure ACCESS_ALLOW_INITIAL_SETUP=true uma única vez.");
          store = {
            version: 2,
            users: [{ id: "admin-inicial", name: "Administrador Sfera", email: "admin@sfera.local", accountType: "admin", stores: [], passwordHash: passwordHash(TEMP_PASSWORD), mustChangePassword: true, status: "approved", active: true }],
            sessions: [], loginAttempts: {}, resetRequests: [],
          };
          saveMigration(store);
        }
      } else {
        const parsed = readJson(storePath);
        if (parsed?.version === 2) store = validateStore(parsed);
        else {
          store = migrateLegacy(parsed);
          // A restorable pre-change snapshot retains hashes, never plaintext.
          saveMigration(store);
        }
      }
      const context = { store, dirty: false };
      try { return operation(context); }
      finally { if (context.dirty) writeJson(storePath, store); }
    } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockPath);
    }
  }

  function currentUser(store, request, required = true) {
    const token = cookieValue(request);
    const session = token && store.sessions.find((item) => item.tokenHash === hash(token) && item.expiresAt > now());
    const user = session && store.users.find((item) => item.id === session.userId);
    if (!approved(user)) {
      if (required) throw new AuthError(401, "Sua sessão terminou. Entre novamente.");
      return null;
    }
    return user;
  }

  function requireAdmin(store, request) {
    const user = currentUser(store, request);
    if (user.mustChangePassword) throw new AuthError(403, "Defina sua senha pessoal antes de continuar.");
    if (!isAdmin(user)) throw new AuthError(403, "Somente administradores podem gerenciar usuários.");
    return user;
  }

  function revokeSessions(store, userId) { store.sessions = store.sessions.filter((session) => session.userId !== userId); }
  function issueSession(context, user, request) {
    const { store } = context;
    const token = randomBytes(32).toString("hex");
    const age = user.mustChangePassword ? TEMP_SESSION_AGE : SESSION_AGE;
    const oldToken = cookieValue(request);
    store.sessions = store.sessions.filter((item) => item.expiresAt > now() && (!oldToken || item.tokenHash !== hash(oldToken)));
    const owned = store.sessions.filter((item) => item.userId === user.id);
    const evicted = new Set(owned.slice(0, Math.max(0, owned.length - 9)).map((item) => item.tokenHash));
    store.sessions = store.sessions.filter((item) => !evicted.has(item.tokenHash));
    store.sessions.push({ tokenHash: hash(token), userId: user.id, expiresAt: now() + age });
    context.dirty = true;
    return sessionCookie(request, token, age, environment);
  }

  function limitLogin(context, request, email) {
    const { store } = context;
    for (const [key, value] of Object.entries(store.loginAttempts)) if (value.expiresAt <= now()) delete store.loginAttempts[key];
    const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
    const limits = [[`email:${hash(email)}`, 10], [`source:${hash(source)}`, 100], ["global", 1000]];
    context.dirty = true;
    for (const [key, limit] of limits) {
      if ((store.loginAttempts[key]?.count || 0) >= limit) throw new AuthError(429, "Muitas tentativas de acesso. Aguarde 15 minutos e tente novamente.");
    }
    for (const [key] of limits) {
      const previous = store.loginAttempts[key];
      store.loginAttempts[key] = { count: (previous?.count || 0) + 1, expiresAt: previous?.expiresAt || now() + ATTEMPT_WINDOW };
    }
  }

  function handlePost(context, request, body) {
    const { store } = context;
    if (body.action === "login") {
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
      limitLogin(context, request, email);
      const user = store.users.find((item) => item.email.toLowerCase() === email);
      const password = typeof body.password === "string" && body.password.length <= 1024 ? body.password : "";
      const matches = passwordMatches(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
      if (!matches || !approved(user)) throw new AuthError(401, "E-mail ou senha inválidos.");
      delete store.loginAttempts[`email:${hash(email)}`];
      return response({ user: safeUser(user) }, 200, issueSession(context, user, request));
    }
    if (body.action === "logout") {
      const token = cookieValue(request);
      store.sessions = store.sessions.filter((item) => !token || item.tokenHash !== hash(token));
      context.dirty = true;
      return response({ user: null }, 200, sessionCookie(request, "", 0, environment));
    }
    if (body.action === "change-password") {
      const user = currentUser(store, request);
      if (!user.mustChangePassword) throw new AuthError(403, "Uma nova troca de senha exige redefinição pelo administrador.");
      if (typeof body.password !== "string" || body.password.length < 6 || body.password.length > 128) throw new AuthError(400, "A senha pessoal deve ter entre 6 e 128 caracteres.");
      if (body.password !== body.confirm) throw new AuthError(400, "As senhas não coincidem.");
      if (body.password === TEMP_PASSWORD || passwordMatches(body.password, user.passwordHash)) throw new AuthError(400, "Defina uma senha pessoal diferente da senha temporária atual.");
      user.passwordHash = passwordHash(body.password);
      user.mustChangePassword = false;
      revokeSessions(store, user.id);
      context.dirty = true;
      return response({ user: safeUser(user) }, 200, issueSession(context, user, request));
    }
    if (!ADMIN_ACTIONS.has(body.action)) throw new AuthError(400, "Ação de acesso inválida.");
    const admin = requireAdmin(store, request);
    if (body.action === "create-user") {
      const profile = profileInput(body.user);
      if (store.users.some((item) => item.email.toLowerCase() === profile.email)) throw new AuthError(409, "Este e-mail já possui um cadastro.");
      store.users.push({ ...profile, id: randomUUID(), requestedAt: new Date(now()).toISOString(), passwordHash: passwordHash(TEMP_PASSWORD), mustChangePassword: true });
    } else {
      const target = store.users.find((item) => item.id === body.userId);
      if (!target) throw new AuthError(404, "Usuário não encontrado.");
      if (body.action === "update-user") {
        const profile = profileInput(body.user, target);
        if (store.users.some((item) => item.id !== target.id && item.email.toLowerCase() === profile.email)) throw new AuthError(409, "Este e-mail já possui um cadastro.");
        if (isAdmin(target) && !isAdmin(profile) && !store.users.some((item) => item.id !== target.id && isAdmin(item))) throw new AuthError(409, "Mantenha pelo menos um administrador ativo.");
        const revoke = target.accountType !== profile.accountType || target.status !== profile.status || target.email !== profile.email || JSON.stringify(target.stores) !== JSON.stringify(profile.stores);
        Object.assign(target, profile);
        if (revoke) revokeSessions(store, target.id);
      } else if (body.action === "reset-password") {
        target.passwordHash = passwordHash(TEMP_PASSWORD);
        target.mustChangePassword = true;
        revokeSessions(store, target.id);
        delete store.loginAttempts[`email:${hash(target.email.toLowerCase())}`];
      } else {
        if (target.id === admin.id) throw new AuthError(409, "Você não pode remover sua própria conta.");
        if (isAdmin(target) && !store.users.some((item) => item.id !== target.id && isAdmin(item))) throw new AuthError(409, "Mantenha pelo menos um administrador ativo.");
        store.users = store.users.filter((item) => item.id !== target.id);
        revokeSessions(store, target.id);
      }
    }
    context.dirty = true;
    return response({ users: store.users.map(safeUser) });
  }

  function failure(error) {
    if (!(error instanceof AuthError)) console.error("[auth] Storage failure:", { code: error?.code || "UNKNOWN", syscall: error?.syscall || "unknown", target: error?.path ? path.basename(error.path) : "unknown" });
    if (["EACCES", "EPERM", "EROFS"].includes(error?.code)) return response({ error: "O serviço não conseguiu gravar a base de usuários. Verifique as permissões e o volume de dados. Nenhuma senha foi redefinida automaticamente." }, 503);
    return response({ error: error instanceof AuthError ? error.message : "Não foi possível acessar a base de usuários. Tente novamente ou contate o administrador." }, error instanceof AuthError ? error.status : 503);
  }

  return {
    async GET(request) {
      try {
        return await withStore(({ store }) => {
          const action = new URL(request.url).searchParams.get("action");
          if (action === "users") { requireAdmin(store, request); return response({ users: store.users.map(safeUser) }); }
          if (action) throw new AuthError(400, "Ação de acesso inválida.");
          const user = currentUser(store, request, false);
          return response({ user: user ? safeUser(user) : null });
        });
      } catch (error) { return failure(error); }
    },
    async POST(request) {
      try {
        requireSameOrigin(request, environment);
        if (Number(request.headers.get("content-length") || 0) > MAX_BODY_BYTES) throw new AuthError(413, "Solicitação muito grande.");
        const reader = request.body?.getReader();
        if (!reader) throw new AuthError(400, "Envie uma ação de acesso válida.");
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new AuthError(413, "Solicitação muito grande."); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new AuthError(400, "Envie uma ação de acesso válida."); }
        if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.action !== "string" || Object.hasOwn(body, "users") || Object.hasOwn(body, "resetRequests")) throw new AuthError(400, "Envie uma ação de acesso válida.");
        return await withStore((context) => handlePost(context, request, body));
      } catch (error) { return failure(error); }
    },
  };
}

const handlers = createAuthHandlers();
export const GET = handlers.GET;
export const POST = handlers.POST;
