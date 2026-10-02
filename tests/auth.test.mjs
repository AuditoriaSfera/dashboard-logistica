import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthHandlers, TEMP_PASSWORD } from "../server/auth.mjs";

const ORIGIN = "https://auth.example.test";
const ADMIN_EMAIL = "admin@sfera.local";
const PERSONAL = "Senha-pessoal-teste-123";
const OTHER_PERSONAL = "Outra-senha-pessoal-456";
const UNIT_PROFILE = { name: "Pessoa Teste", email: "pessoa@example.test", accountType: "unit", stores: ["Loja Teste"] };

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sfera-auth-test-"));
  t.after(() => {
    // Only this test's exact, freshly-created temporary directory is removed.
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("sfera-auth-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const settings = { dataDir: directory, environment: {}, ...options };
  return {
    directory, settings, handlers: createAuthHandlers(settings),
    read: () => JSON.parse(fs.readFileSync(path.join(directory, "access-users.json"), "utf8")),
  };
}

function client(handlers) {
  let cookie = "";
  return {
    get cookie() { return cookie; },
    async send(body, query = "", overrides = {}) {
      const headers = { "content-type": "application/json", origin: ORIGIN, cookie, ...overrides.headers };
      const request = new Request(`${ORIGIN}/api/auth${query}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await handlers[body === undefined ? "GET" : "POST"](request);
      const newCookie = result.headers.get("set-cookie");
      if (newCookie) cookie = newCookie.split(";")[0];
      const data = await result.json();
      assert.equal(result.headers.get("cache-control"), "no-store");
      for (const user of data.users || (data.user ? [data.user] : [])) {
        assert.equal(Object.hasOwn(user, "password"), false);
        assert.equal(Object.hasOwn(user, "passwordHash"), false);
        assert.equal(Object.hasOwn(user, "sessions"), false);
      }
      return { status: result.status, headers: result.headers, data };
    },
  };
}

async function administrator(handlers) {
  const browser = client(handlers);
  assert.equal((await browser.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD })).status, 200);
  assert.equal((await browser.send({ action: "change-password", password: PERSONAL, confirm: PERSONAL })).status, 200);
  return browser;
}

test("temporary login is restricted, personal password rotates session and does not expire", async (t) => {
  let clock = Date.UTC(2026, 0, 1);
  const fx = fixture(t, { now: () => clock });
  const browser = client(fx.handlers);
  assert.deepEqual((await browser.send()).data, { user: null });
  assert.equal((await browser.send(undefined, "?action=users")).status, 401);
  const login = await browser.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Lax/);
  assert.match(login.headers.get("set-cookie"), /Secure/);
  assert.equal((await browser.send(undefined, "?action=users")).status, 403);
  assert.equal((await browser.send({ action: "create-user", user: UNIT_PROFILE })).status, 403);
  assert.equal((await browser.send({ action: "change-password", password: TEMP_PASSWORD, confirm: TEMP_PASSWORD })).status, 400);
  assert.equal((await browser.send({ action: "change-password", password: PERSONAL, confirm: OTHER_PERSONAL })).status, 400);
  assert.equal((await browser.send({ action: "change-password", password: "12345", confirm: "12345" })).status, 400);
  const temporaryCookie = browser.cookie;
  const changed = await browser.send({ action: "change-password", password: PERSONAL, confirm: PERSONAL });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.mustChangePassword, false);
  assert.notEqual(browser.cookie, temporaryCookie);
  assert.deepEqual((await browser.send(undefined, "", { headers: { cookie: temporaryCookie } })).data, { user: null });
  assert.equal((await browser.send(undefined, "?action=users")).status, 200);
  assert.equal((await browser.send({ action: "change-password", password: OTHER_PERSONAL, confirm: OTHER_PERSONAL })).status, 403);
  const stored = JSON.stringify(fx.read());
  assert.ok(!stored.includes(TEMP_PASSWORD));
  assert.ok(!stored.includes(PERSONAL));
  assert.ok(!stored.includes(browser.cookie.split("=")[1]));
  clock += 3650 * 24 * 60 * 60 * 1000;
  const restarted = client(createAuthHandlers(fx.settings));
  assert.deepEqual((await browser.send()).data, { user: null });
  const laterLogin = await restarted.send({ action: "login", email: ADMIN_EMAIL, password: PERSONAL });
  assert.equal(laterLogin.status, 200);
  assert.equal(laterLogin.data.user.mustChangePassword, false);
  assert.equal((await restarted.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD })).status, 401);
});

test("only admins create and reset users; reset revokes all target sessions and restarts the cycle", async (t) => {
  const fx = fixture(t);
  const admin = await administrator(fx.handlers);
  const anon = client(fx.handlers);
  assert.equal((await anon.send({ action: "create-user", user: UNIT_PROFILE })).status, 401);
  const created = await admin.send({ action: "create-user", user: UNIT_PROFILE });
  assert.equal(created.status, 200);
  const target = created.data.users.find((item) => item.email === UNIT_PROFILE.email);
  assert.equal(target.mustChangePassword, true);
  assert.equal(target.status, "approved");
  const unit = client(fx.handlers);
  assert.equal((await unit.send({ action: "login", email: target.email, password: TEMP_PASSWORD })).status, 200);
  assert.equal((await unit.send({ action: "change-password", password: OTHER_PERSONAL, confirm: OTHER_PERSONAL })).status, 200);
  const secondUnit = client(fx.handlers);
  assert.equal((await secondUnit.send({ action: "login", email: target.email, password: OTHER_PERSONAL })).status, 200);
  for (const action of ["create-user", "update-user", "reset-password", "delete-user"]) {
    assert.equal((await unit.send({ action, userId: target.id, user: { ...UNIT_PROFILE, accountType: "admin" } })).status, 403);
  }
  assert.equal((await unit.send(undefined, "?action=users")).status, 403);
  assert.equal((await admin.send({ action: "reset-password", userId: target.id })).status, 200);
  assert.deepEqual((await unit.send()).data, { user: null });
  assert.deepEqual((await secondUnit.send()).data, { user: null });
  assert.equal((await unit.send({ action: "change-password", password: PERSONAL, confirm: PERSONAL })).status, 401);
  assert.equal((await unit.send({ action: "login", email: target.email, password: OTHER_PERSONAL })).status, 401);
  const temporary = await unit.send({ action: "login", email: target.email, password: TEMP_PASSWORD });
  assert.equal(temporary.status, 200);
  assert.equal(temporary.data.user.mustChangePassword, true);
  assert.equal((await unit.send({ action: "change-password", password: PERSONAL, confirm: PERSONAL })).status, 200);
  assert.equal((await unit.send({ action: "logout" })).status, 200);
  assert.deepEqual((await unit.send()).data, { user: null });
});

test("admin mutations preserve credentials, reject bulk overwrite and protect the last admin", async (t) => {
  const fx = fixture(t);
  const admin = await administrator(fx.handlers);
  const initial = fx.read().users[0];
  assert.equal((await admin.send({ users: [] })).status, 400);
  assert.equal((await admin.send({ action: "login", users: [], email: ADMIN_EMAIL, password: PERSONAL })).status, 400);
  assert.equal((await admin.send({ action: "delete-user", userId: initial.id })).status, 409);
  assert.equal((await admin.send({ action: "update-user", userId: initial.id, user: { accountType: "unit", stores: ["A"] } })).status, 409);
  assert.equal((await admin.send({ action: "update-user", userId: initial.id, user: { status: "inactive" } })).status, 409);
  assert.equal((await admin.send({ action: "create-user", user: { ...UNIT_PROFILE, password: PERSONAL } })).status, 400);
  assert.equal((await admin.send({ action: "create-user", user: { ...UNIT_PROFILE, stores: [] } })).status, 400);
  const created = await admin.send({ action: "create-user", user: UNIT_PROFILE });
  const target = created.data.users.find((item) => item.email === UNIT_PROFILE.email);
  assert.equal((await admin.send({ action: "create-user", user: { ...UNIT_PROFILE, email: UNIT_PROFILE.email.toUpperCase() } })).status, 409);
  const credential = fx.read().users.find((item) => item.id === target.id).passwordHash;
  assert.equal((await admin.send({ action: "update-user", userId: target.id, user: { name: "Nome Atualizado", stores: ["Nova Loja"] } })).status, 200);
  assert.equal(fx.read().users.find((item) => item.id === target.id).passwordHash, credential);
  assert.equal((await admin.send({ action: "update-user", userId: target.id, user: { mustChangePassword: false } })).status, 400);
  assert.equal((await admin.send({ action: "delete-user", userId: target.id })).status, 200);
  assert.equal(fx.read().users.length, 1);
  assert.equal(fx.read().users[0].passwordHash, initial.passwordHash);
});

test("legacy migration preserves personal credentials and profile and creates a hash-only backup", async (t) => {
  const fx = fixture(t);
  const legacy = {
    users: [{ id: "existing-admin", name: "Admin Existente", email: "existente@example.test", accountType: "admin", stores: ["A"], password: PERSONAL, mustChangePassword: false, status: "approved", active: true, phone: "telefone-teste", company: "Empresa Teste", requestedAt: "2025-01-01" }],
    resetRequests: [{ id: "old-request", userId: "existing-admin", status: "rejected" }],
  };
  fs.writeFileSync(path.join(fx.directory, "access-users.json"), JSON.stringify(legacy));
  const browser = client(fx.handlers);
  assert.deepEqual((await browser.send()).data, { user: null });
  const login = await browser.send({ action: "login", email: "existente@example.test", password: PERSONAL });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, false);
  assert.equal(login.data.user.phone, "telefone-teste");
  assert.equal(login.data.user.company, "Empresa Teste");
  assert.deepEqual(login.data.user.stores, ["A"]);
  assert.equal(fx.read().users.length, 1);
  assert.equal(fx.read().users[0].id, "existing-admin");
  assert.equal(fx.read().resetRequests.length, 1);
  const backupDir = path.join(fx.directory, "auth-backups");
  const backups = fs.readdirSync(backupDir);
  assert.equal(backups.length, 1);
  const snapshotText = fs.readFileSync(path.join(backupDir, backups[0]), "utf8");
  assert.ok(!snapshotText.includes(PERSONAL));
  assert.ok(!snapshotText.includes('"password":'));
  assert.match(JSON.parse(snapshotText).users[0].passwordHash, /^scrypt:/);
  const restarted = client(createAuthHandlers(fx.settings));
  assert.equal((await restarted.send({ action: "login", email: "existente@example.test", password: PERSONAL })).status, 200);
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal((await restarted.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD })).status, 401);
});

test("migration to a volume preserves the source and refuses to replace a corrupt destination", async (t) => {
  const source = fixture(t);
  await administrator(source.handlers);
  const original = fs.readFileSync(path.join(source.directory, "access-users.json"), "utf8");
  const volume = fixture(t, { legacyDataDir: source.directory, environment: { RAILWAY_PROJECT_ID: "test-project" } });
  const browser = client(volume.handlers);
  assert.equal((await browser.send({ action: "login", email: ADMIN_EMAIL, password: PERSONAL })).status, 200);
  assert.equal(fs.readFileSync(path.join(source.directory, "access-users.json"), "utf8"), original);
  fs.writeFileSync(path.join(volume.directory, "access-users.json"), "{corrupt");
  assert.equal((await browser.send()).status, 503);
  assert.equal(fs.readFileSync(path.join(volume.directory, "access-users.json"), "utf8"), "{corrupt");
});

test("corrupt or missing existing stores fail closed without creating replacement accounts", async (t) => {
  const fx = fixture(t);
  const browser = client(fx.handlers);
  const file = path.join(fx.directory, "access-users.json");
  for (const value of ["{broken", JSON.stringify({ users: [] }), JSON.stringify({ version: 2, users: [] })]) {
    fs.writeFileSync(file, value);
    assert.equal((await browser.send()).status, 503);
    assert.equal(fs.readFileSync(file, "utf8"), value);
  }
  fs.unlinkSync(file);
  fs.mkdirSync(path.join(fx.directory, "auth-backups"));
  assert.equal((await browser.send()).status, 503);
  assert.equal(fs.existsSync(file), false);
});

test("Railway without a volume stays online in temporary mode unless a volume is required", async (t) => {
  const temporary = fixture(t);
  const browser = client(createAuthHandlers({ ephemeralDataDir: temporary.directory, environment: { RAILWAY_PROJECT_ID: "test-project" } }));
  assert.equal((await browser.send()).status, 200);
  const login = await browser.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.mustChangePassword, true);
  assert.ok(fs.existsSync(path.join(temporary.directory, "access-users.json")));
});

test("Railway requires explicit persistent storage when configured and never silently bootstraps an empty volume", async (t) => {
  const missingVolume = client(createAuthHandlers({ environment: { RAILWAY_PROJECT_ID: "test-project", ACCESS_REQUIRE_VOLUME: "true" } }));
  const denied = await missingVolume.send();
  assert.equal(denied.status, 503);
  assert.match(denied.data.error, /volume persistente/);
  const emptyVolume = fixture(t, { environment: { RAILWAY_PROJECT_ID: "test-project" } });
  assert.equal((await client(emptyVolume.handlers).send()).status, 503);
  assert.equal(fs.existsSync(path.join(emptyVolume.directory, "access-users.json")), false);
  const newInstallation = createAuthHandlers({ ...emptyVolume.settings, environment: { RAILWAY_PROJECT_ID: "test-project", ACCESS_ALLOW_INITIAL_SETUP: "true" } });
  assert.equal((await client(newInstallation).send()).status, 200);
});

test("login failures do not enumerate accounts and rate limits persist across handler restarts", async (t) => {
  let clock = Date.UTC(2026, 0, 1);
  const fx = fixture(t, { now: () => clock });
  const browser = client(fx.handlers);
  const unknown = await browser.send({ action: "login", email: "unknown@example.test", password: "wrong-password" });
  const known = await browser.send({ action: "login", email: ADMIN_EMAIL, password: "wrong-password" });
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.data, known.data);
  for (let index = 1; index < 10; index++) assert.equal((await browser.send({ action: "login", email: ADMIN_EMAIL, password: "wrong-password" })).status, 401);
  const restarted = client(createAuthHandlers(fx.settings));
  assert.equal((await restarted.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD })).status, 429);
  clock += 15 * 60 * 1000 + 1;
  assert.equal((await restarted.send({ action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD })).status, 200);
});

test("origin, body format and body size protections apply before any mutation", async (t) => {
  const fx = fixture(t);
  const browser = client(fx.handlers);
  const login = { action: "login", email: ADMIN_EMAIL, password: TEMP_PASSWORD };
  assert.equal((await browser.send(login, "", { headers: { origin: "https://attacker.example.test" } })).status, 403);
  assert.equal((await browser.send(login, "", { headers: { origin: "null" } })).status, 403);
  assert.equal((await browser.send(login, "", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await browser.send(login, "", { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await browser.send({ ...login, padding: "x".repeat(70_000) })).status, 413);
  const malformed = await fx.handlers.POST(new Request(`${ORIGIN}/api/auth`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{broken" }));
  assert.equal(malformed.status, 400);
  assert.equal(fs.existsSync(path.join(fx.directory, "access-users.json")), false);
});

test("accepts the configured Railway public origin behind its HTTPS proxy", async (t) => {
  const fx = fixture(t, {
    environment: {
      RAILWAY_PROJECT_ID: "test-project",
      RAILWAY_PUBLIC_DOMAIN: "dashboard.example.test",
      ACCESS_ALLOW_INITIAL_SETUP: "true",
    },
  });
  const request = new Request("http://service.internal:3000/api/auth", {
    method: "POST",
    headers: {
      origin: "https://dashboard.example.test",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "login", email: "unknown@example.test", password: "wrong" }),
  });
  const accepted = await fx.handlers.POST(request);
  assert.equal(accepted.status, 401, "valid Railway origin should reach credential verification");

  const forged = new Request("http://service.internal:3000/api/auth", {
    method: "POST",
    headers: {
      origin: "https://attacker.example.test",
      "x-forwarded-proto": "https",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "login", email: "unknown@example.test", password: "wrong" }),
  });
  assert.equal((await fx.handlers.POST(forged)).status, 403);
});

test("concurrent creates are serialized without losing users and permissions invalidate sessions", async (t) => {
  const fx = fixture(t);
  const admin = await administrator(fx.handlers);
  const created = await Promise.all([0, 1, 2].map((index) => admin.send({ action: "create-user", user: { ...UNIT_PROFILE, email: `person${index}@example.test` } })));
  assert.ok(created.every((item) => item.status === 200));
  assert.equal(fx.read().users.length, 4);
  const target = fx.read().users.find((item) => item.email === "person0@example.test");
  const unit = client(fx.handlers);
  await unit.send({ action: "login", email: target.email, password: TEMP_PASSWORD });
  await unit.send({ action: "change-password", password: PERSONAL, confirm: PERSONAL });
  assert.equal((await admin.send({ action: "update-user", userId: target.id, user: { stores: ["Other Store"] } })).status, 200);
  assert.deepEqual((await unit.send()).data, { user: null });
  assert.equal((await admin.send({ action: "update-user", userId: target.id, user: { status: "inactive" } })).status, 200);
  assert.equal((await unit.send({ action: "login", email: target.email, password: PERSONAL })).status, 401);
});

test("a busy file lock retries and never deletes a lock still owned by another writer", async (t) => {
  const fx = fixture(t, { lockTimeoutMs: 150 });
  const lockFile = path.join(fx.directory, "access-users.lock");
  fs.writeFileSync(lockFile, "test-writer");
  const timer = setTimeout(() => fs.unlinkSync(lockFile), 60);
  t.after(() => clearTimeout(timer));
  assert.equal((await client(fx.handlers).send()).status, 200);
  fs.writeFileSync(lockFile, "another-writer");
  const locked = await client(fx.handlers).send();
  assert.equal(locked.status, 503);
  assert.match(locked.data.error, /ocupada/);
  assert.equal(fs.readFileSync(lockFile, "utf8"), "another-writer");
});
