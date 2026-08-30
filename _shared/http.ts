import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import type { JsonObject } from "./types.ts";

function normalizeOrigin(request: Request) {
  const configured = (Deno.env.get("KIMO_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("Origin") ?? "";
  if (!configured.length) return "*";
  return configured.includes(requestOrigin) ? requestOrigin : configured[0];
}

export function corsHeaders(request: Request) {
  return {
    "Access-Control-Allow-Origin": normalizeOrigin(request),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-request-id",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  };
}

export function json(request: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function errorResponse(request: Request, code: string, status: number, details?: JsonObject) {
  return json(request, { error: code, ...(details ?? {}) }, status);
}

export async function verifyUser(request: Request) {
  const authorization = request.headers.get("Authorization")?.trim() ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) return null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error("SUPABASE_CONFIGURATION_MISSING");
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser();
  if (error || !data.user) return null;
  return {
    userId: data.user.id,
    service: createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } }),
  };
}