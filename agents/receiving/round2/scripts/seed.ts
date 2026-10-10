// Seeds orgs, PO lines (from data/receiving_sample.csv) and one demo operator per org.
//   npm run seed
// Idempotent: safe to re-run.
import { config } from "dotenv";
config({ path: ".env.local" });
import { loadPoLines } from "../lib/po";
import { adminClient, DEMO_USERS } from "../lib/supabase/admin";

async function main() {
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 8) throw new Error("Set DEMO_PASSWORD (8+ chars) in .env.local");
  const db = adminClient();

  const orgs = DEMO_USERS.map((u) => ({ id: u.org_id, name: u.name }));
  const { error: orgErr } = await db.from("orgs").upsert(orgs);
  if (orgErr) throw orgErr;

  const lines = loadPoLines();
  const { error: poErr } = await db.from("po_lines").upsert(lines);
  if (poErr) throw poErr;
  console.log(`upserted ${orgs.length} orgs, ${lines.length} PO lines`);

  const { data: existing, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw listErr;
  for (const u of DEMO_USERS) {
    let user = existing.users.find((x) => x.email === u.email);
    if (!user) {
      const { data, error } = await db.auth.admin.createUser({ email: u.email, password, email_confirm: true });
      if (error) throw error;
      user = data.user;
    } else {
      await db.auth.admin.updateUserById(user.id, { password });
    }
    const { error } = await db.from("org_members").upsert({ user_id: user.id, org_id: u.org_id });
    if (error) throw error;
    console.log(`demo user ${u.email} → ${u.org_id}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
