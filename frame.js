// frame.js - WebGL "window" effect shown only inside a simple four-point polygon (convex or concave).
// Usage: const fx = new FrameFx(); fx.resize(w, h); fx.render(video, quad, "glitch", bass, ms);

const VERT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
attribute vec2 a_pos;   // pixel position on the canvas
attribute vec2 a_local; // 0..1 position inside the quad
uniform vec2 u_res;
varying vec2 v_px;
varying vec2 v_local;
void main() {
  v_px = a_pos;
  v_local = a_local;
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform vec2 u_center; // quad center in pixels
uniform float u_radius; // average distance from the center to the corners, in pixels
uniform float u_time;  // seconds
uniform float u_bass;  // 0..1
uniform int u_fx;      // 0 bubble Aero, 1 glitch, 2 wave, 3 kaleido, 4 portal, 5 color filter
varying vec2 v_px;
varying vec2 v_local;

// Sample the (unmirrored) video at a screen pixel, flipping x to match the mirrored view.
vec3 cam(vec2 p) {
  vec2 uv = vec2(1.0 - p.x / u_res.x, p.y / u_res.y);
  return texture2D(u_tex, clamp(uv, 0.0, 1.0)).rgb;
}
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
// Rotate a color's hue by angle a (radians) around the gray axis, keeping its brightness.
vec3 hueRotate(vec3 c, float a) {
  const vec3 k = vec3(0.57735);
  float ca = cos(a);
  return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}

void main() {
  float s = 0.35 + 0.65 * u_bass; // effect strength
  vec2 p = v_px;
  vec3 col;

  if (u_fx == 0) {
    // Aero glass: a cool, luminous camera view with floating refractive bubbles.
    float rad = max(u_radius, 1.0);
    vec2 uv = (p - u_center) / rad;
    vec3 sky = mix(vec3(0.42, 0.82, 0.96), vec3(0.88, 0.98, 1.0),
                   clamp(0.5 + uv.y * 0.35, 0.0, 1.0));
    col = mix(cam(p), sky, 0.22);
    col += vec3(0.025, 0.045, 0.05);
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      float seed = hash(fi + 4.0);
      float speed = 0.055 + 0.065 * hash(fi + 18.0);
      float y = 1.3 - mod(fi * (2.6 / 18.0) + u_time * speed, 2.6);
      float x = (seed - 0.5) * 1.75 + sin(u_time * 0.45 + fi * 2.4) * 0.10;
      float radius = (0.16 + 0.19 * hash(fi + 9.0)) * (1.0 + 0.10 * u_bass);
      vec2 b = (uv - vec2(x, y)) / radius;
      float r2 = dot(b, b);
      if (r2 < 1.0) {
        float r = sqrt(r2);
        float dome = sqrt(max(0.0, 1.0 - r2));
        // The camera bends through each glass sphere, with a slight rainbow rim.
        vec2 lens = p - b * radius * rad * dome * 0.24;
        vec2 split = b * (0.8 + 1.5 * u_bass) * r;
        vec3 glass = vec3(cam(lens + split).r, cam(lens).g, cam(lens - split).b);
        vec3 tint = mix(vec3(0.55, 0.9, 1.0), vec3(0.77, 1.0, 0.79), seed);
        glass = mix(glass, tint, 0.17 + 0.12 * (1.0 - dome));
        float rim = smoothstep(0.68, 0.96, r);
        float light = clamp(dot(b, vec2(-0.65, -0.76)), 0.0, 1.0);
        glass += mix(vec3(0.12, 0.38, 0.52), vec3(0.85, 0.98, 1.0), light) * rim * 0.55;
        float gleam = exp(-dot(b - vec2(-0.30, -0.40), b - vec2(-0.30, -0.40)) * 55.0);
        glass = mix(glass, vec3(1.0), gleam * 0.88);
        float crescent = exp(-pow((r - 0.82) * 23.0, 2.0)) * light * light;
        glass += vec3(0.68, 0.86, 0.95) * crescent * 0.55;
        col = mix(col, glass, 1.0 - smoothstep(0.94, 1.0, r));
      }
    }
  } else if (u_fx == 1) {
    // glitch: horizontal slice offsets, RGB split, noise
    float t = floor(u_time * 14.0);
    float row = floor(p.y / 14.0);
    float n = hash(row + t * 3.7);
    float off = n > 0.82 ? (hash(row * 1.3 + t) - 0.5) * 90.0 * s : 0.0;
    float split = (4.0 + 14.0 * s) * (0.5 + hash(t));
    vec2 q = vec2(p.x + off, p.y);
    col = vec3(cam(q + vec2(split, 0.0)).r, cam(q).g, cam(q - vec2(split, 0.0)).b);
    float noise = hash(dot(floor(p / 2.0), vec2(12.9898, 78.233)) + t);
    col += (noise - 0.5) * 0.18 * s;
  } else if (u_fx == 2) {
    // wave: liquid sine displacement
    float amp = 6.0 + 16.0 * s;
    vec2 q = p + vec2(sin(p.y * 0.035 + u_time * 3.0),
                      sin(p.x * 0.03 + u_time * 2.4)) * amp;
    col = cam(q);
  } else if (u_fx == 3) {
    // kaleidoscope: fold angle into mirrored segments around the center
    vec2 d = p - u_center;
    float r = length(d);
    float a = atan(d.y, d.x + 1e-5) + u_time * 0.3;
    float seg = 6.2831853 / 6.0;
    a = abs(mod(a, seg) - seg * 0.5);
    float zoom = 1.0 + 0.25 * s;
    vec2 q = u_center + vec2(cos(a), sin(a)) * r / zoom;
    col = cam(q);
  } else if (u_fx == 4) {
    // portal: a swirling lens. The picture twists tighter toward the middle, rings ripple outward,
    // colors split a little near the rim, and the edge glows.
    vec2 d = p - u_center;
    float rad = max(u_radius, 1.0);
    float r = clamp(length(d) / rad, 0.0, 1.4);          // 0 at the middle, ~1 at the corners
    float twist = (1.0 - smoothstep(0.0, 1.1, r)) * (1.6 + 2.4 * s) * sin(u_time * 0.7 + 0.6);
    float ang = atan(d.y, d.x + 1e-5) + twist;
    float ripple = sin(r * 18.0 - u_time * 4.0) * (3.0 + 7.0 * s) * (1.0 - r * 0.5);
    float len = length(d) * (0.45 + 0.55 * r) + ripple;   // lens: the middle is magnified
    vec2 dir = vec2(cos(ang), sin(ang));
    vec2 q = u_center + dir * len;
    float split = (2.0 + 9.0 * s) * r;
    col = vec3(cam(q + dir * split).r, cam(q).g, cam(q - dir * split).b);
    col *= 0.75 + 0.25 * smoothstep(0.0, 0.5, r);           // a touch darker in the very middle
    float rim = smoothstep(0.65, 1.05, r);
    col += vec3(0.35, 0.15, 0.85) * rim * (0.55 + 0.6 * s); // purple glow at the edge
  } else {
    // color filter: map brightness to a neon palette (deep violet → hot pink → cyan → white) whose hues
    // cycle over time (one full turn about every 10 s)
    vec3 c = cam(p);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    l = clamp(l * (1.0 + 0.5 * s) + 0.08 * sin(u_time * 1.5), 0.0, 1.0);
    vec3 c0 = vec3(0.05, 0.0, 0.25);
    vec3 c1 = vec3(0.95, 0.12, 0.62);
    vec3 c2 = vec3(0.1, 0.9, 1.0);
    vec3 c3 = vec3(1.0, 0.98, 0.9);
    vec3 m = l < 0.4 ? mix(c0, c1, l / 0.4) : (l < 0.75 ? mix(c1, c2, (l - 0.4) / 0.35) : mix(c2, c3, (l - 0.75) / 0.25));
    m = clamp(hueRotate(m, u_time * 0.6), 0.0, 1.0);
    col = mix(c, m, 0.92);
  }
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0); // opaque, so premultiplied is the same
}`;

const LINE_VERT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
attribute vec2 a_pos;
uniform vec2 u_res;
void main() {
  vec2 c = a_pos / u_res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

const LINE_FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec4 u_color;
void main() { gl_FragColor = u_color; }`;

const EFFECTS = { bubbles: 0, pixel8: 0, glitch: 1, wave: 2, kaleido: 3, portal: 4, color: 5 };

export class FrameFx {
  constructor() {
    this.ok = false;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 640;
    this.canvas.height = 480;
    this.w = 640;
    this.h = 480;
    // If the GPU resets, stop drawing until the context comes back, then set everything up again
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.ok = false; });
    this.canvas.addEventListener("webglcontextrestored", () => this._init());
    this._init();
  }

  _init() {
    this.ok = false;
    this.dirty = true;
    this.texW = this.texH = 0;   // forces a fresh texture allocation (also after a context restore)
    try {
      const gl = this.canvas.getContext("webgl", {
        alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: "high-performance",
      });
      if (!gl) return;
      this.gl = gl;
      this.fxProg = this._program(VERT, FRAG);
      this.lineProg = this._program(LINE_VERT, LINE_FRAG);
      if (!this.fxProg || !this.lineProg) return;

      // Cache attribute/uniform locations.
      this.fx = {
        pos: gl.getAttribLocation(this.fxProg, "a_pos"),
        local: gl.getAttribLocation(this.fxProg, "a_local"),
        res: gl.getUniformLocation(this.fxProg, "u_res"),
        tex: gl.getUniformLocation(this.fxProg, "u_tex"),
        center: gl.getUniformLocation(this.fxProg, "u_center"),
        radius: gl.getUniformLocation(this.fxProg, "u_radius"),
        time: gl.getUniformLocation(this.fxProg, "u_time"),
        bass: gl.getUniformLocation(this.fxProg, "u_bass"),
        mode: gl.getUniformLocation(this.fxProg, "u_fx"),
      };
      this.ln = {
        pos: gl.getAttribLocation(this.lineProg, "a_pos"),
        res: gl.getUniformLocation(this.lineProg, "u_res"),
        color: gl.getUniformLocation(this.lineProg, "u_color"),
      };

      this.quadBuf = gl.createBuffer();
      this.lineBuf = gl.createBuffer();

      // Webcam texture (re-uploaded every frame).
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied alpha
      this.ok = true;
      this.resize(this.w, this.h);
    } catch (e) {
      this.ok = false;
    }
  }

  // Compile and link one shader program; returns null on failure.
  _program(vsSrc, fsSrc) {
    const gl = this.gl;
    const make = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("FrameFx shader error:", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };
    const vs = make(gl.VERTEX_SHADER, vsSrc);
    const fs = make(gl.FRAGMENT_SHADER, fsSrc);
    if (!vs || !fs) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("FrameFx link error:", gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  // Match the 2D canvas pixel size.
  resize(w, h) {
    // Remember the size even while the context is lost, so a restore comes back at this size
    this.w = w;
    this.h = h;
    if (!this.ok) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  // Make the canvas fully transparent.
  // Public clear: does nothing if the canvas is already empty (saves a GPU clear on every idle frame)
  clear() {
    if (!this.ok || !this.dirty) return;
    this._clear();
    this.dirty = false;
  }

  _clear() {
    const gl = this.gl;
    gl.viewport(0, 0, this.w, this.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  // Draw the effect inside the quad, plus a viewfinder outline.
  // quad: four perimeter-ordered canvas points, clockwise or counterclockwise.
  render(video, quad, effect, bass = 0, timeMs = 0) {
    if (!this.ok) return;
    const gl = this.gl;
    this._clear();
    this.dirty = true;
    if (!quad || quad.length < 4 || !video || video.readyState < 2) return;

    try {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      const vw = video.videoWidth || video.width, vh = video.videoHeight || video.height;
      // render() may run at screen rate (60 fps) while the camera gives ~30 frames a second: skip re-uploading the same frame
      const stamp = video.tagName === "VIDEO" ? video.currentTime : null;
      if (stamp !== null && stamp === this.lastStamp && this.texW === vw && this.texH === vh) {
        // same camera frame as last time, the texture is already up to date
      } else if (this.texW === vw && this.texH === vh) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);   // same size: update in place (faster)
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
        this.texW = vw; this.texH = vh;
      }
      this.lastStamp = stamp;
    } catch (e) {
      return; // video not ready yet
    }

    const [a, b, c, d] = quad;
    const center = {
      x: (a.x + b.x + c.x + d.x) / 4,
      y: (a.y + b.y + c.y + d.y) / 4,
    };

    // The interior diagonal changes when one fingertip lies inside the other three.
    // A fixed 0–2 split would fill outside some concave polygons.
    const uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const verts = new Float32Array(triangulateQuad(quad).flatMap((i) =>
      [quad[i].x, quad[i].y, ...uv[i]]));
    gl.useProgram(this.fxProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.fx.pos);
    gl.vertexAttribPointer(this.fx.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.fx.local);
    gl.vertexAttribPointer(this.fx.local, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.fx.tex, 0);
    gl.uniform2f(this.fx.res, this.w, this.h);
    gl.uniform2f(this.fx.center, center.x, center.y);
    gl.uniform1f(this.fx.radius, (Math.hypot(a.x - center.x, a.y - center.y) + Math.hypot(b.x - center.x, b.y - center.y) +
      Math.hypot(c.x - center.x, c.y - center.y) + Math.hypot(d.x - center.x, d.y - center.y)) / 4);
    gl.uniform1f(this.fx.time, timeMs / 1000);
    gl.uniform1f(this.fx.bass, Math.max(0, Math.min(1, bass)));
    gl.uniform1i(this.fx.mode, EFFECTS[effect] !== undefined ? EFFECTS[effect] : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.disableVertexAttribArray(this.fx.local);

    this._outline(quad, bass);
  }

  // Bright outline plus thicker corner brackets, drawn as thin triangles.
  _outline(quad, bass) {
    const gl = this.gl;
    const out = [];
    const thin = 2 + 2 * bass;
    const thick = 6;
    // Push a line segment as a quad of the given thickness.
    const seg = (p, q, t) => {
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * t / 2, ny = (dx / len) * t / 2;
      out.push(
        p.x + nx, p.y + ny, p.x - nx, p.y - ny, q.x + nx, q.y + ny,
        q.x + nx, q.y + ny, p.x - nx, p.y - ny, q.x - nx, q.y - ny
      );
    };
    for (let i = 0; i < 4; i++) {
      const p = quad[i], q = quad[(i + 1) % 4], prev = quad[(i + 3) % 4];
      seg(p, q, thin);
      // Corner bracket: short thick arms along both edges meeting at this corner.
      const arm = (to) => {
        const dx = to.x - p.x, dy = to.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const k = Math.min(30, len * 0.3) / len;
        seg(p, { x: p.x + dx * k, y: p.y + dy * k }, thick);
      };
      arm(q);
      arm(prev);
    }
    gl.useProgram(this.lineProg);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.ln.pos);
    gl.vertexAttribPointer(this.ln.pos, 2, gl.FLOAT, false, 0, 0);
    gl.uniform2f(this.ln.res, this.w, this.h);
    gl.uniform4f(this.ln.color, 1, 1, 1, 1); // bright white
    gl.drawArrays(gl.TRIANGLES, 0, out.length / 2);
  }
}

// For a simple quadrilateral, a reflex vertex must connect to its opposite
// vertex. Convex quadrilaterals accept either diagonal; keep 0–2 in that case.
export function triangulateQuad(q) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
  const area = q.reduce((sum, p, i) => {
    const n = q[(i + 1) % 4]; return sum + p.x * n.y - n.x * p.y;
  }, 0);
  const winding = Math.sign(area);
  const reflex = q.findIndex((p, i) => cross(q[(i + 3) % 4], p, q[(i + 1) % 4]) * winding < 0);
  const i = reflex < 0 ? 0 : reflex;
  return [i, (i + 1) % 4, (i + 2) % 4, i, (i + 2) % 4, (i + 3) % 4];
}
