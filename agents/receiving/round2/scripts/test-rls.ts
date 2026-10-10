// Tenancy isolation test against the real Supabase project (engineering rule 1).
//   npm run seed && npm run test:rls
// Signs in as the BRAVO operator with the public anon key (exactly what the browser has) and
// proves it can't see or touch anything belonging to ALPHA — rows or photos, even with the exact path.
import { config } from "dotenv";
config({ path: ".env.local" });
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";
import { adminClient, DEMO_USERS } from "../lib/supabase/admin";

const BUCKET = "receiving-photos";
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function signIn(email: string) {
  const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: process.env.DEMO_PASSWORD! });
  if (error) throw new Error(`sign-in ${email}: ${error.message}`);
  return c;
}

async function main() {
  const admin = adminClient();
  const [alphaUser, bravoUser] = DEMO_USERS;
  const alpha = await signIn(alphaUser.email);
  const bravo = await signIn(bravoUser.email);

  // Plant an alpha photo with a KNOWN path, as if bravo had guessed or leaked it.
  const alphaPath = `org_demo_alpha/rls-test-${randomUUID()}.jpg`;
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#f00" } }).jpeg().toBuffer();
  const up = await admin.storage.from(BUCKET).upload(alphaPath, jpg, { contentType: "image/jpeg" });
  if (up.error) throw up.error;

  try {
    // Rows
    const a = await alpha.from("po_lines").select("unit_id, org_id");
    check("alpha sees its own PO lines", !a.error && (a.data?.length ?? 0) > 0, `${a.data?.length} rows`);
    check("alpha sees only alpha rows", !!a.data?.every((r) => r.org_id === "org_demo_alpha"));

    const b = await bravo.from("po_lines").select("unit_id").eq("org_id", "org_demo_alpha");
    check("bravo sees ZERO alpha PO lines", !b.error && b.data?.length === 0, `${b.data?.length} rows`);

    const bi = await bravo.from("inspections").select("id").eq("org_id", "org_demo_alpha");
    check("bravo sees ZERO alpha inspections", !bi.error && bi.data?.length === 0, `${bi.data?.length} rows`);

    const bo = await bravo.from("orgs").select("id");
    check("bravo sees only its own org", JSON.stringify(bo.data?.map((o) => o.id)) === '["org_demo_bravo"]');

    // Writes into another org
    const ins = await bravo.from("overrides").insert({
      inspection_id: randomUUID(), org_id: "org_demo_alpha", check_name: "identity",
      original_verdict: "FAIL", new_verdict: "PASS", reason: "rls test", operator_id: "attacker",
    });
    check("bravo cannot insert into alpha", !!ins.error, ins.error?.message);

    // Photos: exact path known
    const dl = await bravo.storage.from(BUCKET).download(alphaPath);
    check("bravo cannot download alpha photo by exact path", !!dl.error && !dl.data);
    const su = await bravo.storage.from(BUCKET).createSignedUrl(alphaPath, 60);
    check("bravo cannot sign a URL for alpha photo", !!su.error && !su.data);
    const ls = await bravo.storage.from(BUCKET).list("org_demo_alpha");
    check("bravo cannot list alpha photo folder", (ls.data?.length ?? 0) === 0);
    const pub = await fetch(admin.storage.from(BUCKET).getPublicUrl(alphaPath).data.publicUrl);
    check("public URL for alpha photo is refused", !pub.ok, `HTTP ${pub.status}`);
    const bup = await bravo.storage.from(BUCKET).upload(`org_demo_alpha/${randomUUID()}.jpg`, jpg);
    check("bravo cannot upload into alpha folder", !!bup.error);

    // Positive control: alpha CAN read it, so the negatives above mean something.
    const adl = await alpha.storage.from(BUCKET).download(alphaPath);
    check("alpha can download its own photo (control)", !adl.error && !!adl.data);
  } finally {
    await admin.storage.from(BUCKET).remove([alphaPath]);
  }

  console.log(failures ? `\n${failures} isolation check(s) FAILED` : "\nall isolation checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
