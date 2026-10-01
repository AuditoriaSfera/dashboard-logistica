// Shared Node handlers keep credentials on the server and allow isolated tests.
export const runtime = "nodejs";
import { GET as authGet, POST as authPost } from "../../../server/auth.mjs";

async function proxyToLocalApi(request: Request) {
  const target = new URL(request.url);
  target.protocol = "http:";
  target.hostname = "127.0.0.1";
  target.port = process.env.OPERATIONS_API_PORT || "8788";
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  const response = await fetch(target, {
    method: request.method,
    headers,
    ...(request.method === "GET" ? {} : { body: await request.text() }),
    cache: "no-store",
  });
  return new Response(response.body, { status: response.status, headers: response.headers });
}

export async function GET(request: Request) {
  return process.env.NODE_ENV === "development" ? proxyToLocalApi(request) : authGet(request);
}

export async function POST(request: Request) {
  return process.env.NODE_ENV === "development" ? proxyToLocalApi(request) : authPost(request);
}
