/**
 * Builds the icon set from public/logo.png.
 *
 * Committed so the assets can be regenerated rather than being binaries nobody
 * can reproduce. Run: node scripts/build-icons.mjs
 *
 * Two things about the source file drive everything here.
 *
 * The mark occupies 258x280 of a 500x500 canvas — roughly half of it is
 * transparent margin, and the mark sits slightly low within it. Drawn as-is at
 * a favicon's size the visible glyph would be about half the intended height
 * and off-centre, so every output below is cropped to the ink and re-centred.
 * That is the same artwork, placed properly; nothing about the mark changes.
 *
 * And the outputs are flattened onto the site's own cream rather than left
 * transparent. iOS composites a transparent apple-icon onto black, which would
 * put a dark brown mark on a black tile; browsers with dark tab strips do much
 * the same to a favicon. Cream is #f7f2e7 — the page background, not a new
 * colour — so the icon reads as the site rather than as an image sitting on
 * top of one.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOURCE = "public/logo.png";
const CREAM = "0xF7F2E7";

/** Ink bounds measured from the alpha channel of the source. */
const CROP = { w: 258, h: 280, x: 121, y: 119 };

/** Share of the canvas the mark fills. Enough to read small, not cramped. */
const FILL = 0.74;

function render(size, out, { background = CREAM } = {}) {
  const markHeight = Math.round(size * FILL);
  execFileSync(
    "ffmpeg",
    [
      "-v", "error",
      "-f", "lavfi",
      "-i", `color=c=${background}:s=${size}x${size}`,
      "-i", SOURCE,
      "-filter_complex",
      `[1:v]crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y},scale=-1:${markHeight}:flags=lanczos[m];` +
        `[0:v][m]overlay=(W-w)/2:(H-h)/2`,
      "-frames:v", "1",
      /*
       * Keep the alpha channel even though every pixel is opaque.
       *
       * Flattening onto cream leaves ffmpeg free to write RGB, and the ICO
       * decoder in the build rejects that outright: "The PNG is not in RGBA
       * format". The channel costs a few hundred bytes at these sizes.
       */
      "-pix_fmt", "rgba",
      "-y", out,
    ],
    { stdio: "inherit" }
  );
}

/**
 * Packs PNGs into an .ico.
 *
 * Written by hand because an icon container is a header and a directory of
 * offsets, and a dependency for forty bytes of struct would be worse. PNG
 * inside ICO is read by every browser still in use.
 */
function buildIco(pngPaths, out) {
  const images = pngPaths.map(({ size, path }) => ({ size, data: readFileSync(path) }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((img, i) => {
    const at = i * 16;
    // 256 is stored as 0 — the field is one byte.
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 0);
    directory.writeUInt8(img.size >= 256 ? 0 : img.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(img.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += img.data.length;
  });

  writeFileSync(out, Buffer.concat([header, directory, ...images.map((i) => i.data)]));
}

const tmp = (name) => join(tmpdir(), `veltr-icon-${name}`);

/**
 * The mark on its own, transparent, for placing in the page.
 *
 * The source carries about a quarter of its width as empty margin on each side.
 * Laid out directly, the gap between the mark and the wordmark would be
 * whatever spacing was asked for plus nine invisible pixels, which is why a
 * pasted-in logo reads as pasted in. Trimmed, the spacing in the markup is the
 * spacing on the screen.
 *
 * Three times the size it is displayed at, so it stays sharp on dense screens.
 */
execFileSync(
  "ffmpeg",
  [
    "-v", "error",
    "-i", SOURCE,
    "-vf", `crop=${CROP.w}:${CROP.h}:${CROP.x}:${CROP.y},scale=-1:840:flags=lanczos`,
    "-y", "public/logo-mark.png",
  ],
  { stdio: "inherit" }
);

// Favicon: the sizes a browser actually picks between.
const icoParts = [16, 32, 48].map((size) => {
  const path = tmp(`${size}.png`);
  render(size, path);
  return { size, path };
});
buildIco(icoParts, "app/favicon.ico");
icoParts.forEach(({ path }) => unlinkSync(path));

// The high-resolution icon, for tabs on dense displays and installed contexts.
render(512, "app/icon.png");

// iOS home screen. Fixed 180 and never transparent — see the note above.
render(180, "app/apple-icon.png");

console.log("built app/favicon.ico, app/icon.png, app/apple-icon.png, public/logo-mark.png from", SOURCE);
