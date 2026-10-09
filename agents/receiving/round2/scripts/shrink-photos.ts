// Shrinks phone photos in eval/photos/ in place (longest side 1600 px, JPEG), so the eval set is
// small enough to commit. Run once, BEFORE the eval: the evidence records hash the files as
// they are when the eval runs, so shrinking afterwards would break those hashes.
//
//   npm run eval:shrink
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DIR = path.resolve("../eval/photos");
const MAX = 1600;

async function main() {
  let changed = 0;
  for (const name of readdirSync(DIR)) {
    const ext = path.extname(name).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) {
      if (!name.startsWith(".")) console.error(`skipped ${name}: use JPEG, PNG or WebP (HEIC isn't supported)`);
      continue;
    }
    const file = path.join(DIR, name);
    const input = readFileSync(file);
    const meta = await sharp(input).metadata();
    if (Math.max(meta.width ?? 0, meta.height ?? 0) <= MAX && ext !== ".png") continue;
    const out = await sharp(input).rotate().resize(MAX, MAX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const target = ext === ".jpg" || ext === ".jpeg" ? file : file.slice(0, -ext.length) + ".jpg";
    writeFileSync(target + ".tmp", out);
    renameSync(target + ".tmp", target);
    console.error(`${name}: ${(input.length / 1e6).toFixed(1)} MB → ${(out.length / 1e6).toFixed(2)} MB${target !== file ? ` (now ${path.basename(target)}; update cases.csv)` : ""}`);
    changed++;
  }
  console.error(`${changed} photo(s) shrunk.`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
