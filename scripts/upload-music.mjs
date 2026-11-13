// Uploads the hosted tracks to the R2 bucket the Worker serves them from.
// Run: npm run upload-music [-- --dry-run] [-- --local]
// Every public-music/<id>.m4a for a song in library.public.json goes to airdeck-music/<id>.m4a.
//   (default)  --remote: the real bucket (needs `npx wrangler login` and `npx wrangler r2 bucket create airdeck-music`)
//   --local    the local simulator that `npm run dev` (wrangler dev) uses
//   --dry-run  only print the commands
// Only audio you have the right to publish belongs in library.public.json (CC BY, CC0, your own, or permission).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "airdeck-music";
const dryRun = process.argv.includes("--dry-run");
const local = process.argv.includes("--local");

const songs = JSON.parse(readFileSync(join(root, "library.public.json"), "utf8")).songs ?? [];
const missing = [];
let uploaded = 0;
for (const song of songs) {
  if (!/^[a-z0-9-]{1,20}$/.test(song.id)) { console.error(`bad id ${JSON.stringify(song.id)}`); process.exit(1); }
  const file = join(root, "public-music", `${song.id}.m4a`);
  if (!existsSync(file)) { missing.push(song.id); continue; }
  const args = ["wrangler", "r2", "object", "put", `${BUCKET}/${song.id}.m4a`, "--file", file, "--content-type", "audio/mp4", local ? "--local" : "--remote"];
  console.log(`${dryRun ? "[dry run] " : ""}npx ${args.join(" ")}`);
  if (dryRun) { uploaded++; continue; }
  const result = spawnSync("npx", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) { console.error(`upload failed for ${song.id}`); process.exit(result.status || 1); }
  uploaded++;
}
if (missing.length) console.warn(`No public-music file for: ${missing.join(", ")} (skipped)`);
console.log(`${dryRun ? "Would upload" : "Uploaded"} ${uploaded} of ${songs.length} tracks to ${BUCKET}${local ? " (local simulator)" : ""}`);
