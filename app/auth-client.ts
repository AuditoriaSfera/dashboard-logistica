export type AccessUser = {
  id: string;
  name: string;
  email: string;
  phone?: string;
  company?: string;
  accountType: "admin" | "unit";
  stores: string[];
  mustChangePassword: boolean;
  status: "pending" | "approved" | "rejected" | "inactive";
  requestedAt?: string;
  active: boolean;
};

export class AuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function authRequest<T>(payload?: Record<string, unknown>, action?: string): Promise<T> {
  const response = await fetch(`/api/auth${action ? `?action=${encodeURIComponent(action)}` : ""}`, {
    method: payload ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    const error = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : null;
    throw new AuthError(error || "Não foi possível conectar ao serviço de acesso. Tente novamente.", response.status);
  }
  return body as T;
}
