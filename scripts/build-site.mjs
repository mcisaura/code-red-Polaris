// Builds dist/: the public files of the AirDeck site, for Cloudflare Workers static assets.
// Run: node scripts/build-site.mjs   (npm run build)
// Only an allowlist of file types from the repo root plus easter/ is copied, so server code,
// tests, docs, secrets, music/ and downloads can never end up on the hosted site.
// dist/library.json = library.json's songs unchanged (YouTube ids, played in YouTube's embedded player), then
// library.public.json's songs each with "hosted": true (real audio at /music/<id>.m4a, copied from public-music/<id>.m4a).
// Only those tracks' audio is copied into dist/music/; music/ (YouTube downloads) is never copied.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

// What the site loads: pages, scripts (incl. audio worklets), styles, and the easter/ assets.
const ALLOWED_EXTENSIONS = new Set([".html", ".js", ".css", ".gif", ".mp3"]);
const COPIED_DIRECTORIES = ["easter"];
// Never copied, whatever the extension or folder.
const DENIED_NAMES = new Set([
  "server.py", "prefetch.py", "library.json", "library.public.json", "package.json", "package-lock.json",
  "wrangler.jsonc", "README.md", "AGENTS.md", "FEATURES_PLAN.md",
]);
const DENIED_DIRECTORIES = new Set([
  "tests", "music", "public-music", "downloads", "worker", "scripts", "node_modules", "dist", ".git", ".github", ".wrangler",
]);
const DENIED_EXTENSIONS = new Set([".py", ".cjs", ".mjs", ".md", ".example", ".env", ".json", ".jsonc", ".log"]);

export function isPublicFile(relativePath) {
  const parts = relativePath.split("/");
  const name = parts[parts.length - 1];
  if (parts.some((part) => part.startsWith("."))) return false; // dotfiles and dot folders
  if (parts.slice(0, -1).some((part) => DENIED_DIRECTORIES.has(part))) return false;
  if (DENIED_NAMES.has(name) || DENIED_EXTENSIONS.has(extname(name).toLowerCase())) return false;
  return ALLOWED_EXTENSIONS.has(extname(name).toLowerCase());
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : []; // symlinks are skipped
  });
}

// The song list: { songs: [...] } or a bare array. Each id is a YouTube video id, so it must be
// 1-20 characters of A-Z a-z 0-9 _ - (the AI DJ picker keeps only the first 20 characters of an id).
export function readLibrary(file = join(root, "library.json")) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const songs = Array.isArray(data) ? data : data?.songs;
  if (!Array.isArray(songs)) throw new Error("library.json must be an array or { songs: [...] }");
  const ids = new Set();
  for (const song of songs) {
    if (typeof song?.id !== "string" || !/^[A-Za-z0-9_-]{1,20}$/.test(song.id)) {
      throw new Error(`library.json: bad id ${JSON.stringify(song?.id)} (1-20 characters of A-Z a-z 0-9 _ -)`);
    }
    if (ids.has(song.id)) throw new Error(`library.json: duplicate id ${song.id}`);
    ids.add(song.id);
  }
  return { songs };
}

// library.public.json: ids are lowercase slugs ([a-z0-9-]{1,20}) that must not collide with library.json.
export function readPublicLibrary(file = join(root, "library.public.json"), taken = new Set()) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const songs = data?.songs;
  if (!Array.isArray(songs)) throw new Error("library.public.json must be { about, songs: [...] }");
  const ids = new Set();
  for (const song of songs) {
    if (typeof song?.id !== "string" || !/^[a-z0-9-]{1,20}$/.test(song.id)) {
      throw new Error(`library.public.json: bad id ${JSON.stringify(song?.id)} (1-20 characters of a-z 0-9 -)`);
    }
    if (ids.has(song.id) || taken.has(song.id)) throw new Error(`library.public.json: duplicate id ${song.id}`);
    ids.add(song.id);
  }
  return { about: data.about, songs };
}

// The merged list the site loads.
export function mergeLibraries(library, publicLibrary) {
  const about = [library.about, publicLibrary.about].filter((text) => typeof text === "string" && text).join(" ");
  return { ...(about ? { about } : {}), songs: [...library.songs, ...publicLibrary.songs.map((song) => ({ ...song, hosted: true }))] };
}

export function build() {
  const { songs } = readLibrary();
  const libraryData = JSON.parse(readFileSync(join(root, "library.json"), "utf8"));
  const publicLibrary = readPublicLibrary(join(root, "library.public.json"), new Set(songs.map((song) => song.id)));
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  const sources = [
    ...readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(root, entry.name)),
    ...COPIED_DIRECTORIES.filter((name) => existsSync(join(root, name)) && statSync(join(root, name)).isDirectory())
      .flatMap((name) => listFiles(join(root, name))),
  ];
  const copied = [];
  for (const source of sources) {
    const path = relative(root, source).split("\\").join("/");
    if (!isPublicFile(path)) continue;
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    cpSync(source, join(dist, path));
    copied.push(path);
  }
  const merged = mergeLibraries(Array.isArray(libraryData) ? { songs: libraryData } : libraryData, publicLibrary);
  writeFileSync(join(dist, "library.json"), JSON.stringify(merged, null, 2) + "\n");
  copied.push("library.json");
  // The hosted tracks' audio (only the files library.public.json lists) ships as static assets at /music/<id>.m4a,
  // so the site needs no R2 bucket. A missing file is skipped with a warning: that song 404s on the site.
  for (const song of publicLibrary.songs) {
    const source = join(root, "public-music", `${song.id}.m4a`);
    if (!existsSync(source)) { console.warn(`build: public-music/${song.id}.m4a is missing`); continue; }
    mkdirSync(join(dist, "music"), { recursive: true });
    cpSync(source, join(dist, "music", `${song.id}.m4a`));
    copied.push(`music/${song.id}.m4a`);
  }
  return { copied, songs: songs.length, hosted: publicLibrary.songs.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { copied, songs, hosted } = build();
    console.log(`dist/: ${copied.length} files`);
    for (const path of copied) console.log(`  ${path}`);
    console.log(`Hosted library: ${songs} YouTube song${songs === 1 ? "" : "s"} + ${hosted} hosted track${hosted === 1 ? "" : "s"}`);
  } catch (error) {
    console.error(`build failed: ${error.message}`);
    process.exit(1);
  }
}
