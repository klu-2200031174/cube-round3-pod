import { createClient } from "@supabase/supabase-js";

// Service-role client for scripts only (seed, RLS test). Bypasses RLS — never import from app code
// that runs in the browser, and never use it to serve user requests.
export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)");
  return createClient(url, key, { auth: { persistSession: false } });
}

export const DEMO_USERS = [
  { email: "alpha.operator@demo.test", org_id: "org_demo_alpha", name: "Demo Alpha" },
  { email: "bravo.operator@demo.test", org_id: "org_demo_bravo", name: "Demo Bravo" },
] as const;
