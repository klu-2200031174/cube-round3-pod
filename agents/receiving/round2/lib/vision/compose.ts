import sharp from "sharp";
import type { PhotoRole } from "../types";

// Stitches all photos of one unit into a single labelled contact sheet, so the whole unit
// goes to the model in ONE call (engineering rule 2). LLaVA attends to a single image far
// more reliably than to several, and the "#N role" labels let the model cite photos by number.

const TILE = 640;
const LABEL_H = 44;

function labelSvg(text: string): Buffer {
  const safe = text.replace(/[<>&"']/g, "");
  return Buffer.from(
    `<svg width="${TILE}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#111"/>
      <text x="14" y="31" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="#ffd400">${safe}</text>
    </svg>`,
  );
}

export async function composeContactSheet(photos: { role: PhotoRole; bytes: Buffer }[]): Promise<Buffer> {
  if (photos.length === 0) throw new Error("no photos to compose");
  const cols = photos.length === 1 ? 1 : 2;
  const rows = Math.ceil(photos.length / cols);
  const cellH = TILE + LABEL_H;

  const tiles = await Promise.all(
    photos.map(async (p, i) => {
      const img = await sharp(p.bytes)
        .rotate() // honour EXIF orientation from phone cameras
        .resize(TILE, TILE, { fit: "contain", background: "#333" })
        .jpeg()
        .toBuffer();
      const left = (i % cols) * TILE;
      const top = Math.floor(i / cols) * cellH;
      return [
        { input: labelSvg(`#${i + 1} ${p.role}`), left, top },
        { input: img, left, top: top + LABEL_H },
      ];
    }),
  );

  return sharp({
    create: { width: cols * TILE, height: rows * cellH, channels: 3, background: "#333" },
  })
    .composite(tiles.flat())
    .jpeg({ quality: 85 })
    .toBuffer();
}
