import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Per-request client that acts as the signed-in operator, so every query goes through RLS.
// App code uses this one only; the service-role client in admin.ts is for scripts.
export async function serverClient() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Called from a Server Component, where cookies are read-only; proxy.ts refreshes the session.
        }
      },
    },
  });
}

export const PHOTO_BUCKET = "receiving-photos";
