import type { Metadata } from "next";
import Link from "next/link";
import { signOut } from "./actions";
import { serverClient } from "@/lib/supabase/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Receiving Manager",
  description: "Visual receiving inspection against the PO line, with an evidence record per unit.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const db = await serverClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  const { data: orgs } = user ? await db.from("orgs").select("id, name") : { data: null };

  return (
    <html lang="en">
      <body>
        <header className="top">
          <span className="brand">Receiving Manager</span>
          {user && (
            <>
              <nav>
                <Link href="/">Inspect</Link>
                <Link href="/queue">Review queue</Link>
              </nav>
              <span className="who">
                {user.email} · {orgs?.map((o) => o.name).join(", ") || "no org"}
              </span>
              <form action={signOut}>
                <button type="submit">Sign out</button>
              </form>
            </>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
