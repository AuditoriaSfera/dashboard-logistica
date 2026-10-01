"use client";

import { useCallback, useEffect, useState } from "react";
import { AccessUser, AuthError, authRequest } from "./auth-client";

const TEMP_PASSWORD = "Sfera@2026";
const statusLabel = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Não foi possível salvar. Tente novamente.";
const searchable = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function AuthScreen({ onLogin }: { onLogin: (user: AccessUser) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await authRequest<{user: AccessUser}>({ action: "login", email: email.trim(), password });
      setPassword(""); onLogin(result.user);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><img src="/dashboard-logo.png" alt="Sfera Operações" /></div>
    <p className="eyebrow">Plataforma de Logística</p><h1>Bem-vindo à Sfera</h1>
    <p className="auth-subtitle">Acesse sua operação e acompanhe o desempenho das unidades.</p>
    <form className="auth-form" onSubmit={submit}>
      <label>E-mail<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy} /></label>
      <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
    </form>
    {message && <p className="auth-message access-error" role="alert">{message}</p>}
    <small className="auth-note">Para criar uma conta ou resetar sua senha, entre em contato com o administrador: carlos.saraiva@sferamultifranquias.com</small>
  </section></main>;
}

export function PasswordChangeScreen({ user, onComplete, onLogout, sessionError }: { user: AccessUser; onComplete: (user: AccessUser) => void; onLogout: () => Promise<void>; sessionError: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password.length < 6) return setMessage("A nova senha deve ter pelo menos 6 caracteres.");
    if (password === TEMP_PASSWORD) return setMessage("Escolha uma senha pessoal diferente da senha temporária.");
    if (password !== confirm) return setMessage("As senhas não coincidem.");
    setBusy(true); setMessage("");
    try {
      const result = await authRequest<{user: AccessUser}>({ action: "change-password", password, confirm });
      setPassword(""); setConfirm(""); onComplete(result.user);
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell"><section className="auth-card">
    <div className="auth-brand"><img src="/dashboard-logo.png" alt="Sfera Operações" /></div>
    <p className="eyebrow">Troca obrigatória</p><h1>Defina sua senha</h1>
    <p className="auth-subtitle">{user.name}, crie sua senha pessoal para continuar. Ela será usada nos próximos acessos e só será redefinida se um administrador resetar sua senha.</p>
    <form className="auth-form" onSubmit={submit}>
      <label>Nova senha<input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} maxLength={128} required autoFocus disabled={busy} /></label>
      <label>Confirmação de senha<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={6} maxLength={128} required disabled={busy} /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Salvando…" : "Salvar nova senha"}</button>
    </form>
    {message && <p className="auth-message access-error" role="alert">{message}</p>}
    {sessionError && <p className="auth-message access-error" role="alert">{sessionError}</p>}
    <button className="auth-back access-back" onClick={async () => { setBusy(true); try { await onLogout(); } finally { setBusy(false); } }} disabled={busy}>Voltar ao login</button>
  </section></main>;
}

type StoreOption = { store: string; storeCode: string | null };
type UserDraft = { name: string; email: string; accountType: AccessUser["accountType"]; stores: string[]; status: AccessUser["status"] };
const newDraft = (): UserDraft => ({ name: "", email: "", accountType: "unit", stores: [], status: "approved" });

export function CadastroView({ stores, currentUser, onSessionChange }: { stores: StoreOption[]; currentUser: AccessUser; onSessionChange: () => Promise<void> }) {
  const [users, setUsers] = useState<AccessUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<string | null>(null);
  const [draft, setDraft] = useState<UserDraft>(newDraft);
  const [filters, setFilters] = useState({ name: "", email: "", type: "", store: "", status: "" });
  const loadUsers = useCallback(async () => {
    try { const result = await authRequest<{users: AccessUser[]}>(undefined, "users"); setUsers(result.users); }
    catch (caught) { setError(errorMessage(caught)); if (caught instanceof AuthError && caught.status === 401) await onSessionChange(); }
    finally { setLoading(false); }
  }, [onSessionChange]);
  // Initial list retrieval is an asynchronous server sync; state changes happen after it resolves.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const mutate = async (payload: Record<string, unknown>, success: string) => {
    if (busy || loading) return false;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await authRequest<{users: AccessUser[]}>(payload);
      setUsers(result.users); setMessage(success);
      if (payload.userId === currentUser.id) await onSessionChange();
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof AuthError && (caught.status === 401 || caught.status === 403)) await onSessionChange();
      return false;
    } finally { setBusy(false); }
  };
  const openEditor = (user?: AccessUser) => {
    setError(""); setMessage("");
    setDraft(user ? { name: user.name, email: user.email, accountType: user.accountType, stores: [...user.stores], status: user.status } : newDraft());
    setEditor(user?.id || "new");
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor) return;
    if (draft.accountType === "unit" && !draft.stores.length) { setError("Selecione ao menos uma loja para o usuário da unidade."); return; }
    const user = { ...draft, name: draft.name.trim(), email: draft.email.trim(), stores: draft.accountType === "admin" ? [] : draft.stores };
    const created = editor === "new";
    if (await mutate(created ? { action: "create-user", user } : { action: "update-user", userId: editor, user }, created ? `Usuário criado. Senha temporária: ${TEMP_PASSWORD}. A troca será obrigatória no primeiro login.` : "Cadastro atualizado. A senha pessoal foi mantida.")) setEditor(null);
  };
  const reset = async (user: AccessUser) => {
    await mutate({ action: "reset-password", userId: user.id }, `Senha de ${user.name} resetada para ${TEMP_PASSWORD}. A senha anterior deixou de funcionar. No próximo login, será obrigatório escolher uma nova senha pessoal.`);
  };
  const remove = async (user: AccessUser) => {
    if (window.confirm(`Remover o cadastro de ${user.name} (${user.email})?`)) await mutate({ action: "delete-user", userId: user.id }, "Usuário removido.");
  };
  const visibleUsers = users.filter((user) => searchable(user.name).includes(searchable(filters.name)) && searchable(user.email).includes(searchable(filters.email)) && (!filters.type || user.accountType === filters.type) && (!filters.status || user.status === filters.status) && searchable(user.accountType === "admin" ? "Todas as lojas" : user.stores.join(" ")).includes(searchable(filters.store)));
  const draftStores = [...stores, ...draft.stores.filter((store) => !stores.some((item) => item.store === store)).map((store) => ({store, storeCode:null}))];

  return <div className="access-admin-page">
    <section className="page-head"><div><span className="eyebrow">Administração</span><h1>Usuários</h1><p>Crie contas, defina as lojas permitidas e resete senhas.</p></div><button className="primary-button cadastro-new-button" onClick={() => openEditor()} disabled={busy || loading}>Cadastrar novo usuário</button></section>
    {message && <p className="auth-message" role="status">{message}</p>}
    {error && <p className="auth-message access-error" role="alert">{error}</p>}
    {editor && <section className="panel access-editor" aria-label={editor === "new" ? "Novo usuário" : "Editar usuário"}>
      <div className="section-title"><div><h2>{editor === "new" ? "Novo usuário" : "Editar usuário"}</h2><p>{editor === "new" ? `Senha inicial: ${TEMP_PASSWORD}. Troca obrigatória no primeiro login.` : "Alterar dados cadastrais não muda a senha do usuário."}</p></div></div>
      <form onSubmit={save}>
        <div className="user-edit-form">
          <label>Nome completo<input value={draft.name} onChange={(event) => setDraft({...draft, name:event.target.value})} required disabled={busy} /></label>
          <label>E-mail<input type="email" autoComplete="off" value={draft.email} onChange={(event) => setDraft({...draft, email:event.target.value})} required disabled={busy} /></label>
          <label>Perfil<select value={draft.accountType} onChange={(event) => setDraft({...draft, accountType:event.target.value as AccessUser["accountType"]})} disabled={busy}><option value="unit">Usuário da Unidade</option><option value="admin">Administrador</option></select></label>
          {editor !== "new" && <label>Status<select value={draft.status} onChange={(event) => setDraft({...draft, status:event.target.value as AccessUser["status"]})} disabled={busy}>{Object.entries(statusLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
        </div>
        {draft.accountType === "unit" ? <fieldset className="store-selector access-store-selector" disabled={busy}><legend>Lojas permitidas</legend>{draftStores.map((item) => <label key={item.store}><input type="checkbox" checked={draft.stores.includes(item.store)} onChange={(event) => setDraft({...draft, stores:event.target.checked ? [...draft.stores, item.store] : draft.stores.filter((store) => store !== item.store)})} /><span>{item.store}{item.storeCode && <small> · {item.storeCode}</small>}</span></label>)}</fieldset> : <p className="muted">Administrador tem acesso a todas as lojas.</p>}
        <div className="user-edit-actions"><button className="table-action" type="button" onClick={() => setEditor(null)} disabled={busy}>Cancelar</button><button className="primary-button" type="submit" disabled={busy || loading}>{busy ? "Salvando…" : editor === "new" ? "Cadastrar usuário" : "Salvar alterações"}</button></div>
      </form>
    </section>}
    <section className="panel access-users-panel">
      <div className="section-title"><div><h2>Usuários cadastrados</h2><p>Senha pessoal permanece válida até um reset feito pelo administrador.</p></div><button className="table-action" onClick={() => { setLoading(true); setError(""); void loadUsers(); }} disabled={loading || busy}>Atualizar lista</button></div>
      <div className="access-filters">
        <label>Nome<input value={filters.name} onChange={(event) => setFilters({...filters, name:event.target.value})} placeholder="Buscar nome" /></label>
        <label>E-mail<input value={filters.email} onChange={(event) => setFilters({...filters, email:event.target.value})} placeholder="Buscar e-mail" /></label>
        <label>Perfil<select value={filters.type} onChange={(event) => setFilters({...filters, type:event.target.value})}><option value="">Todos</option><option value="admin">Administrador</option><option value="unit">Usuário da Unidade</option></select></label>
        <label>Loja<input value={filters.store} onChange={(event) => setFilters({...filters, store:event.target.value})} placeholder="Buscar loja" /></label>
        <label>Status<select value={filters.status} onChange={(event) => setFilters({...filters, status:event.target.value})}><option value="">Todos</option>{Object.entries(statusLabel).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
      {loading ? <p className="muted">Carregando usuários…</p> : <div className="table-wrap"><table className="access-users-table"><thead><tr><th>Nome / e-mail</th><th>Perfil</th><th>Lojas permitidas</th><th>Status</th><th>Senha</th><th>Ações</th></tr></thead><tbody>{visibleUsers.map((user) => <tr key={user.id}>
        <th scope="row"><strong>{user.name}</strong><small>{user.email}</small></th>
        <td>{user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</td>
        <td>{user.accountType === "admin" ? "Todas as lojas" : user.stores.join(", ") || "Nenhuma loja"}</td>
        <td><span className={`access-status ${user.status}`}>{statusLabel[user.status]}</span></td>
        <td><span className={user.mustChangePassword ? "access-password-pending" : "access-password-set"}>{user.mustChangePassword ? "Troca obrigatória" : "Senha pessoal definida"}</span></td>
        <td><div className="access-row-actions"><button type="button" className="table-action" onClick={() => openEditor(user)} disabled={busy} aria-label={`Editar ${user.name}`}>Editar</button><button type="button" className="table-action" onClick={() => void reset(user)} disabled={busy} aria-label={`Resetar senha de ${user.name}`}>Resetar senha</button><button type="button" className="table-action danger" onClick={() => void remove(user)} disabled={busy || user.id === currentUser.id} aria-label={`Remover ${user.name}`}>Remover</button></div></td>
      </tr>)}</tbody></table>{!visibleUsers.length && <p className="muted cadastro-empty">Nenhum usuário encontrado.</p>}</div>}
    </section>
  </div>;
}
