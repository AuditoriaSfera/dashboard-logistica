const GRAPH = "https://graph.microsoft.com/v1.0";

const setting = (name) => String(process.env[name] || "").trim();

export function oneDriveConfigured() {
  return Boolean(
    setting("ONEDRIVE_TENANT_ID") &&
    setting("ONEDRIVE_CLIENT_ID") &&
    setting("ONEDRIVE_CLIENT_SECRET") &&
    setting("ONEDRIVE_DRIVE_ID") &&
    (setting("ONEDRIVE_ITEM_ID") || setting("ONEDRIVE_FILE_PATH")),
  );
}

async function graphToken() {
  const body = new URLSearchParams({
    client_id: setting("ONEDRIVE_CLIENT_ID"),
    client_secret: setting("ONEDRIVE_CLIENT_SECRET"),
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const response = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(setting("ONEDRIVE_TENANT_ID"))}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Microsoft Graph recusou a autenticação (${response.status}).`);
  const token = await response.json();
  if (!token.access_token) throw new Error("Microsoft Graph não retornou um token de acesso.");
  return token.access_token;
}

function itemUrl() {
  const drive = encodeURIComponent(setting("ONEDRIVE_DRIVE_ID"));
  const item = setting("ONEDRIVE_ITEM_ID");
  if (item) return `${GRAPH}/drives/${drive}/items/${encodeURIComponent(item)}`;
  const path = setting("ONEDRIVE_FILE_PATH").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `${GRAPH}/drives/${drive}/root:/${path}:`;
}

export async function loadOneDriveWorkbook() {
  if (!oneDriveConfigured()) return null;
  const token = await graphToken();
  const headers = { authorization: `Bearer ${token}` };
  const metadataResponse = await fetch(`${itemUrl()}?$select=id,name,lastModifiedDateTime,size,file`, { headers, cache: "no-store" });
  if (!metadataResponse.ok) throw new Error(`Não foi possível localizar a planilha no OneDrive (${metadataResponse.status}).`);
  const metadata = await metadataResponse.json();
  const contentResponse = await fetch(`${itemUrl()}/content`, { headers, cache: "no-store", redirect: "manual" });
  const downloadUrl = contentResponse.status >= 300 && contentResponse.status < 400
    ? contentResponse.headers.get("location")
    : null;
  const fileResponse = downloadUrl
    ? await fetch(downloadUrl, { cache: "no-store" })
    : contentResponse;
  if (!fileResponse.ok) throw new Error(`Não foi possível baixar a planilha do OneDrive (${fileResponse.status}).`);
  const bytes = Buffer.from(await fileResponse.arrayBuffer());
  return { fileName: metadata.name || "Novas Premiações.xlsx", bytes, modifiedAt: metadata.lastModifiedDateTime || new Date().toISOString() };
}
