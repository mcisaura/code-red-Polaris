// AirDeck on Cloudflare Workers: serves dist/ (static assets), the offline AI DJ picker and the hosted
// tracks (library.public.json, CC BY etc.) at /music/<id>.m4a: static files in dist/, or the R2 bucket bound as MUSIC when one is configured.
// library.json's songs play through YouTube's embedded player and are never hosted. What the Worker can't
// do (YouTube downloads) answers with a clear JSON error, and /api/config tells the pages which they're on.
import { pick } from "./picker.js";

const MAX_BODY_BYTES = 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_UNAVAILABLE = "YouTube import isn't available on the hosted site";

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

// Headers for everything served; HTML also says which browser features it may use.
function secured(response) {
  const result = new Response(response.body, response);
  result.headers.set("X-Content-Type-Options", "nosniff");
  result.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((result.headers.get("Content-Type") || "").includes("text/html")) {
    result.headers.set("Permissions-Policy", "camera=(self), geolocation=()");
  }
  return result;
}

// Only AirDeck's own pages may call the API: an Origin header, when sent, must be this site's.
const sameOrigin = (request, url) => {
  const origin = request.headers.get("Origin");
  return origin === null || origin === url.origin;
};

// The request body as text, or a Response when it is over the limit.
async function readLimited(request) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return json(413, { error: "request body too large" });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return json(413, { error: "request body too large" });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return json(400, { error: "invalid request body" });
  }
}

async function djPick(request) {
  const text = await readLimited(request);
  if (text instanceof Response) return text;
  let body;
  try {
    body = JSON.parse(text.trim() === "" ? "{}" : text);
  } catch {
    return json(400, { error: "invalid request body" });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "invalid request body" });
  const { status, body: answer } = pick(body);
  return json(status, answer);
}

// A video's title and channel from YouTube's public oEmbed endpoint (no key, nothing downloaded).
// The Worker asks YouTube, so the browser never needs to. Cached for a day.
async function youtubeInfo(request, url) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
  const id = url.searchParams.get("id") ?? "";
  if (!VIDEO_ID.test(id)) return json(400, { error: "invalid video id" });
  const target = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
  let upstream;
  try {
    upstream = await fetch(target, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout?.(5000) });
  } catch {
    return json(502, { error: "could not reach YouTube" });
  }
  // 401/403/404: private, removed, or embedding switched off.
  if ([401, 403, 404].includes(upstream.status)) return json(404, { error: "video not found" });
  if (!upstream.ok) return json(502, { error: "YouTube didn't answer" });
  let data;
  try {
    data = await upstream.json();
  } catch {
    return json(502, { error: "unexpected answer from YouTube" });
  }
  if (typeof data?.title !== "string" || !data.title.trim()) return json(502, { error: "unexpected answer from YouTube" });
  const author = typeof data.author_name === "string" ? data.author_name.slice(0, 200) : "";
  return json(200, { title: data.title.trim().slice(0, 200), author }, { "Cache-Control": "public, max-age=86400" });
}

// Hosted audio: GET|HEAD /music/<id>.m4a from the optional MUSIC R2 binding (unbound: static assets), with single-range support so browsers can seek.
const MUSIC_PATH = /^\/music\/([a-z0-9-]{1,20})\.m4a$/;
const AUDIO_HEADERS = { "Content-Type": "audio/mp4", "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable" };

// "bytes=a-b", "bytes=a-", "bytes=-n" -> {start, end} (inclusive), null (no/ignored header: serve all) or "bad" (416).
function parseRange(header, size) {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return header.trim().startsWith("bytes=") && header.includes(",") ? null : "bad";
  let start, end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return "bad";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!(start <= end) || start >= size) return "bad";
  return { start, end };
}

async function music(request, env, id) {
  if (!env.MUSIC) return json(404, { error: "not found" });
  const key = `${id}.m4a`;
  const head = await env.MUSIC.head(key);
  if (!head) return json(404, { error: "not found" });
  const size = head.size;
  const etag = head.httpEtag || `"${head.etag}"`;
  const base = { ...AUDIO_HEADERS, ETag: etag };
  const range = parseRange(request.headers.get("Range"), size);
  if (range === "bad") return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  const headers = range
    ? { ...base, "Content-Range": `bytes ${range.start}-${range.end}/${size}`, "Content-Length": String(range.end - range.start + 1) }
    : { ...base, "Content-Length": String(size) };
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });
  const object = await env.MUSIC.get(key, range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined);
  if (!object) return json(404, { error: "not found" });
  return new Response(object.body, { status, headers });
}

async function api(request, env, url) {
  const { pathname } = url;
  // Only our own pages may call the API (blocks other websites from using it through your browser).
  if (request.method === "POST" && !sameOrigin(request, url)) return json(403, { error: "forbidden origin" });
  if (pathname === "/api/config") {
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
    return json(200, { youtube: false, youtubeEmbed: true, hosted: true });
  }
  if (pathname === "/api/dj/pick") {
    if (request.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });
    return djPick(request);
  }
  if (pathname === "/api/youtube/info") return youtubeInfo(request, url);
  if (pathname === "/api/youtube" || pathname === "/api/progress") return json(501, { error: YOUTUBE_UNAVAILABLE });
  return json(404, { error: "not found" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/api" || pathname.startsWith("/api/")) return secured(await api(request, env, url));

      if (request.method !== "GET" && request.method !== "HEAD") {
        return secured(json(405, { error: "method not allowed" }, { Allow: "GET, HEAD" }));
      }
      const track = MUSIC_PATH.exec(pathname);
      // With an R2 bucket bound (optional) the audio comes from it; otherwise from the static assets the build ships.
      if (track && env.MUSIC) return secured(await music(request, env, track[1]));
      // The landing page is the home page (index.html is the hand tracker, ai-dj.html is AirMix).
      if (pathname === "/") url.pathname = "/landing.html";
      return secured(await env.ASSETS.fetch(new Request(url, request)));
    } catch (error) {
      console.error(error);
      return secured(json(500, { error: "server error" }));
    }
  },
};
