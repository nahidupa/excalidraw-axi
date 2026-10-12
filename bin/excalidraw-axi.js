#!/usr/bin/env node
/**
 * excalidraw-axi — agent-ergonomic CLI for Excalidraw diagrams.
 * File-first .excalidraw operations with token-efficient (TOON-style) output.
 * Zero runtime dependencies. Node >= 18.
 *
 * v0.3: style flags + new element types (freedraw/frame/image/embed),
 * arrange ops (group/align/distribute/flip/duplicate/lock/link/order),
 * move drags fully-bound arrows, sequenceDiagram subset,
 * live-instance sync via serve/open/sync (#url= + CORS server).
 *
 * AXI principles: token-efficient output, minimal default schemas, content
 * truncation (+ --full), pre-computed aggregates, definitive empty states,
 * structured errors & exit codes, content-first home view, contextual help[].
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename, extname } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { createServer } from "node:http";

const VERSION = "0.4.0";
const TRUNCATE_AT = 200;
const JSON_TRUNCATE_AT = 2000;

// layout constants
const ORIGIN_X = 100;
const ORIGIN_Y = 100;
const GAP_X = 140;
const GAP_Y = 100;

// ---------- output helpers (TOON-style) ----------
function shortBin() {
  const p = process.argv[1] || "excalidraw-axi";
  const home = homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function helpLines(lines) {
  if (!lines.length) return "";
  return `help[${lines.length}]:\n` + lines.map((l) => `  Run \`${l}\``).join("\n");
}

function fail(msg, code = 1, next = []) {
  // Structured errors go to stdout per AXI (not stderr), with clean exit codes.
  const parts = [`error: ${msg}`];
  if (next.length) parts.push(helpLines(next));
  process.stdout.write(parts.join("\n") + "\n");
  process.exit(code);
}

function truncate(s, full, at = TRUNCATE_AT) {
  if (full || s.length <= at) return s;
  return s.slice(0, at) + `… (truncated, ${s.length} chars total — use --full)`;
}

// ---------- arg parsing (fail loud on unknown flags -> exit 2) ----------
function parseArgs(argv, { flags = [], positional = 0 } = {}) {
  const pos = [];
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const spec = flags.find((f) => f.name === name);
      if (!spec) fail(`Unknown flag: --${name}`, 2, ["excalidraw-axi --help"]);
      if (spec.type === "boolean") {
        out[name] = true;
      } else {
        const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (val === undefined || val.startsWith("--"))
          fail(`Flag --${name} requires a value`, 2, ["excalidraw-axi --help"]);
        out[name] = val;
      }
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-?\d+(\.\d+)?$/.test(a)) {
      const chars = a.slice(1).split("");
      for (const c of chars) {
        if (c === "h") {
          out.help = true;
          continue;
        }
        const spec = flags.find((f) => f.short === c);
        if (!spec) fail(`Unknown flag: -${c}`, 2, ["excalidraw-axi --help"]);
        if (spec.type === "boolean") {
          out[spec.name] = true;
        } else {
          const val = argv[++i];
          if (val === undefined) fail(`Flag -${c} requires a value`, 2, ["excalidraw-axi --help"]);
          out[spec.name] = val;
        }
      }
      continue;
    }
    pos.push(a);
  }
  if (positional !== Infinity && pos.length > positional)
    fail(`Too many arguments: expected ${positional}, got ${pos.length}`, 2, [
      "excalidraw-axi --help",
    ]);
  return { pos, opts: out };
}

function num(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n)) fail(`--${name} must be a number, got ${JSON.stringify(v)}`, 2);
  return n;
}

function color(v, name) {
  if (/^(transparent|#[0-9a-fA-F]{3,8})$/.test(v)) return v;
  fail(`--${name} must be a hex color (#1e1e1e) or "transparent", got ${JSON.stringify(v)}`, 2);
  return v;
}

function oneOf(v, name, allowed) {
  if (allowed.includes(v)) return v;
  fail(`--${name} must be ${allowed.join("|")}, got ${JSON.stringify(v)}`, 2);
  return v;
}

function inRange(v, name, lo, hi) {
  const n = num(v, name);
  if (n < lo || n > hi) fail(`--${name} must be ${lo}..${hi}, got ${JSON.stringify(v)}`, 2);
  return n;
}

function isHttpUrl(v) {
  return typeof v === "string" && /^https?:\/\/\S+$/i.test(v);
}

/** "x1,y1 x2,y2 ..." -> [[x1,y1],[x2,y2],...] (shared by arrows/lines/freedraw). */
function parsePoints(str, min = 2) {
  const pts = String(str)
    .trim()
    .split(/[\s;]+/)
    .filter(Boolean)
    .map((p) => {
      const m = p.split(",").map(Number);
      if (m.length !== 2 || !m.every(Number.isFinite))
        fail(`--points must be "x1,y1 x2,y2 [...]", got ${JSON.stringify(str)}`, 2);
      return m;
    });
  if (pts.length < min) fail(`--points needs at least ${min} points`, 2);
  return pts;
}

/**
 * Normalize the shared style flags from `add` into makeShape/makeText opts.
 * Neutral keys (stroke/background/...) match makeShape; cmdAdd maps the
 * few text fields explicitly. roundness sharp -> null, round -> per-kind
 * object (adaptive for rectangles, proportional otherwise).
 */
function styleFor(kind, opts) {
  const s = {};
  if (opts.stroke !== undefined) s.stroke = color(opts.stroke, "stroke");
  if (opts.background !== undefined || opts.bg !== undefined)
    s.background = color(opts.background ?? opts.bg, "background");
  if (opts["stroke-width"] !== undefined) s.strokeWidth = num(opts["stroke-width"], "stroke-width");
  if (opts.roughness !== undefined) s.roughness = inRange(opts.roughness, "roughness", 0, 2);
  if (opts.opacity !== undefined) s.opacity = inRange(opts.opacity, "opacity", 0, 100);
  if (opts["stroke-style"] !== undefined)
    s.strokeStyle = oneOf(opts["stroke-style"], "stroke-style", ["solid", "dashed", "dotted"]);
  if (opts["fill-style"] !== undefined)
    s.fillStyle = oneOf(opts["fill-style"], "fill-style", ["solid", "hachure", "cross-hatch", "dots", "zigzag"]);
  if (opts.roundness !== undefined) {
    const r = oneOf(opts.roundness, "roundness", ["sharp", "round"]);
    s.roundness = r === "sharp" ? null : { type: kind === "rectangle" ? 3 : 2 };
  }
  if (opts.angle !== undefined) s.angle = num(opts.angle, "angle");
  if (opts.locked) s.locked = true;
  if (opts.link !== undefined) {
    if (!isHttpUrl(opts.link)) fail(`--link must be an http(s) URL, got ${JSON.stringify(opts.link)}`, 2);
    s.link = opts.link;
  }
  if (opts.frame !== undefined) s.frameId = opts.frame;
  if (opts["font-family"] !== undefined) s.fontFamily = inRange(opts["font-family"], "font-family", 1, 5);
  if (opts["text-align"] !== undefined)
    s.textAlign = oneOf(opts["text-align"], "text-align", ["left", "center", "right"]);
  return s;
}

const KNOWN_TYPES = new Set([
  "rectangle", "ellipse", "diamond", "arrow", "line", "freedraw",
  "text", "image", "frame", "magicframe", "embeddable", "iframe",
]);

// ---------- scene IO ----------
function nid() {
  return randomBytes(8).toString("hex");
}

function loadScene(file) {
  const abs = resolve(file);
  if (!existsSync(abs)) fail(`file not found: ${file}`, 1, ["excalidraw-axi list"]);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (e) {
    fail(`cannot read file: ${file} (${e.message})`, 1, ["excalidraw-axi list"]);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    fail(`invalid JSON in ${file}: ${e.message}`, 1, ["excalidraw-axi validate <file>"]);
  }
  if (!Array.isArray(doc.elements)) doc.elements = [];
  return { abs, doc };
}

function saveScene(abs, doc) {
  writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n");
}

function liveElements(doc) {
  return doc.elements.filter((el) => el && !el.isDeleted);
}

function findElement(doc, id) {
  const el = liveElements(doc).find((e) => e.id === id);
  if (!el) fail(`element not found: ${id}`, 1, ["excalidraw-axi view <file>"]);
  return el;
}

function findScenes(dir) {
  const abs = resolve(dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch (e) {
    fail(`cannot read directory: ${dir} (${e.message})`, 1, ["excalidraw-axi list ."]);
  }
  return entries
    .filter((f) => f.endsWith(".excalidraw"))
    .map((f) => join(abs, f))
    .sort();
}

// ---------- element builders ----------
function baseElement(overrides) {
  return {
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 3 },
    boundElements: [],
    link: null,
    locked: false,
    seed: randomInt(0, 2 ** 31),
    version: 1,
    versionNonce: randomInt(0, 2 ** 31),
    updated: Date.now(),
    isDeleted: false,
    ...overrides,
  };
}

function measureText(text, fontSize) {
  const lines = String(text).split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  return {
    width: Math.max(60, Math.round(longest * fontSize * 0.6)),
    height: Math.max(25, Math.round(lines.length * fontSize * 1.25)),
  };
}

function makeText({ x, y, text, fontSize = 20, strokeColor = "#1e1e1e", fontFamily = 1, textAlign = "left", link = null, locked = false, frameId = null, angle = 0 }) {
  const { width, height } = measureText(text, fontSize);
  return baseElement({
    id: nid(),
    type: "text",
    x,
    y,
    width,
    height,
    angle,
    fontSize,
    fontFamily,
    text,
    textAlign,
    verticalAlign: "top",
    autoResize: true,
    baseline: Math.round(height * 0.8),
    lineHeight: 1.25,
    containerId: null,
    originalText: text,
    strokeColor,
    link,
    locked,
    frameId,
  });
}

function makeShape(kind, o) {
  if (kind === "text") {
    if (!o.text) fail("add text requires --text \"...\"", 2, ['excalidraw-axi add text --text "Hi"']);
    return makeText(o);
  }
  const w = o.w ?? 220;
  const h = o.h ?? 110;
  return baseElement({
    id: nid(),
    type: kind,
    x: o.x,
    y: o.y,
    width: w,
    height: h,
    backgroundColor: o.background ?? "transparent",
    strokeColor: o.stroke ?? "#1e1e1e",
    strokeWidth: o.strokeWidth ?? 2,
    strokeStyle: o.strokeStyle ?? "solid",
    roughness: o.roughness ?? 1,
    opacity: o.opacity ?? 100,
    fillStyle: o.fillStyle ?? "solid",
    angle: o.angle ?? 0,
    link: o.link ?? null,
    locked: o.locked ?? false,
    frameId: o.frameId ?? null,
    roundness: o.roundness !== undefined ? o.roundness : { type: kind === "rectangle" ? 3 : 2 },
  });
}

/**
 * Arrow/line through absolute points (polyline); bindings optional element ids.
 * Accepts {x1,y1,x2,y2} or {points:[[x,y],...]}. style: stroke/width/roughness/
 * opacity/roundness/angle/link/locked/frameId + arrowType sharp|round.
 */
function makeEdge({ x1, y1, x2, y2, points: absPts = null, kind = "arrow", from = null, to = null, label = null, style = {} }) {
  const abs = absPts || [[x1, y1], [x2, y2]];
  const xs = abs.map((p) => p[0]);
  const ys = abs.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const points = abs.map(([px, py]) => [px - x, py - y]);
  const w = Math.max(...xs) - x;
  const h = Math.max(...ys) - y;
  const edge = baseElement({
    id: nid(),
    type: kind,
    x,
    y,
    width: Math.max(1, w),
    height: Math.max(1, h),
    points,
    lastCommittedPoint: points[points.length - 1],
    startBinding: from ? { elementId: from, focus: 0, gap: 8 } : null,
    endBinding: to ? { elementId: to, focus: 0, gap: 8 } : null,
    startArrowhead: style.startArrowhead !== undefined ? style.startArrowhead : null,
    endArrowhead:
      style.endArrowhead !== undefined ? style.endArrowhead : kind === "arrow" ? "arrow" : null,
    elbowed: style.elbowed ?? false,
    fixedSegments: style.elbowed ? [] : null,
    strokeColor: style.stroke ?? "#1e1e1e",
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? "solid",
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
    angle: style.angle ?? 0,
    link: style.link ?? null,
    locked: style.locked ?? false,
    frameId: style.frameId ?? null,
    roundness:
      style.roundness !== undefined
        ? style.roundness
        : style.arrowType === "round"
          ? { type: 2 }
          : null,
  });
  const extra = [];
  if (label) {
    const t = makeText({
      x: (x + (x + w)) / 2 - 40,
      y: (y + (y + h)) / 2 - 30,
      text: label,
      fontSize: 16,
    });
    extra.push(t);
  }
  return { edge, extra };
}

/**
 * Label text for a shape. Bound by default (containerId + boundElements):
 * bound labels move/resize with the container and survive human edits.
 * Set unbound=true for the legacy midpoint overlay (edges always unbound —
 * arrows are not containers).
 */
function shapeLabel(shape, label, fontSize = 20, unbound = false) {
  let fs = fontSize;
  let m = measureText(label, fs);
  if (!unbound) {
    // shrink to fit inside the container (app wraps bound text on edit)
    while (fs > 12 && m.width > shape.width - 20) {
      fs -= 2;
      m = measureText(label, fs);
    }
  }
  const t = makeText({
    x: Math.round(shape.x + (shape.width - m.width) / 2),
    y: Math.round(shape.y + (shape.height - m.height) / 2),
    text: label,
    fontSize: fs,
  });
  if (!unbound) {
    t.containerId = shape.id;
    shape.boundElements.push({ type: "text", id: t.id });
  }
  return t;
}

// container types a text label may bind to (mirrors the app's bindable set)
const LABEL_CONTAINERS = new Set([
  "rectangle", "ellipse", "diamond", "image", "embeddable", "iframe", "frame",
]);

/** Freehand stroke through absolute points. Pressures default to 0.5 (app simulates). */
function makeFreedraw(abs, { pressures = null, style = {} } = {}) {
  const xs = abs.map((p) => p[0]);
  const ys = abs.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const points = abs.map(([px, py]) => [px - x, py - y]);
  const pr = pressures || points.map(() => 0.5);
  return baseElement({
    id: nid(),
    type: "freedraw",
    x,
    y,
    width: Math.max(1, Math.max(...xs) - x),
    height: Math.max(1, Math.max(...ys) - y),
    points,
    pressures: pr,
    simulatePressure: !pressures,
    lastCommittedPoint: points[points.length - 1],
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
    strokeColor: style.stroke ?? "#1e1e1e",
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? "solid",
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
    angle: style.angle ?? 0,
    locked: style.locked ?? false,
    frameId: style.frameId ?? null,
    roundness: style.roundness !== undefined ? style.roundness : { type: 2 },
  });
}

function makeFrame({ x, y, w = 400, h = 300, name = "Frame", style = {} }) {
  return baseElement({
    id: nid(),
    type: "frame",
    x,
    y,
    width: w,
    height: h,
    name,
    strokeColor: style.stroke ?? "#1e1e1e",
    backgroundColor: style.background ?? "transparent",
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? "solid",
    roughness: style.roughness ?? 0,
    opacity: style.opacity ?? 100,
    angle: style.angle ?? 0,
    locked: style.locked ?? false,
  });
}

const IMAGE_MIMES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Intrinsic pixel dimensions from image headers (zero deps). Null if unreadable. */
function imageDims(buf, ext) {
  try {
    if (ext === ".png") {
      if (buf.length < 33) return null;
      if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (ext === ".gif") {
      if (buf.length < 10) return null;
      const sig = buf.toString("ascii", 0, 6);
      if (sig !== "GIF87a" && sig !== "GIF89a") return null;
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    if (ext === ".jpg" || ext === ".jpeg") {
      if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
      const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      let p = 2;
      while (p + 4 < buf.length) {
        if (buf[p] !== 0xff) return null;
        const marker = buf[p + 1];
        if (marker === 0xd8 || marker === 0xd9) {
          p += 2;
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          p += 2;
          continue;
        }
        const len = buf.readUInt16BE(p + 2);
        if (SOF.has(marker)) return { w: buf.readUInt16BE(p + 7), h: buf.readUInt16BE(p + 5) };
        p += 2 + len;
      }
      return null;
    }
    if (ext === ".webp") {
      if (buf.length < 30) return null;
      if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") return null;
      const fourcc = buf.toString("ascii", 12, 16);
      if (fourcc === "VP8 ") {
        // lossy bitstream: 14-bit width at frame-tag+6, height +8
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return w > 0 && h > 0 ? { w, h } : null;
      }
      if (fourcc === "VP8L") {
        const bits = buf.readUInt32LE(21);
        return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (fourcc === "VP8X") {
        return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
      }
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function imageDimsOf(path) {
  const abs = resolve(path);
  const ext = extname(abs).toLowerCase();
  if (!IMAGE_MIMES[ext]) return null;
  try {
    return imageDims(readFileSync(abs), ext);
  } catch {
    return null;
  }
}

/** Read a raster file into a doc.files[fileId] entry. Throws loud failures.
 *  Identical bytes reuse the existing fileId (the app fails to resolve
 *  duplicate file entries carrying the same dataURL). */
function loadImageFile(doc, path) {
  const abs = resolve(path);
  if (!existsSync(abs)) fail(`image not found: ${path}`, 1);
  const mime = IMAGE_MIMES[extname(abs).toLowerCase()];
  if (!mime)
    fail(`unsupported image ${JSON.stringify(extname(abs))} — png|jpg|jpeg|webp|gif`, 1);
  const buf = readFileSync(abs);
  if (!buf.length) fail(`empty image file: ${path}`, 1);
  const dataURL = `data:${mime};base64,${buf.toString("base64")}`;
  doc.files = doc.files || {};
  for (const [fid, f] of Object.entries(doc.files))
    if (f && f.dataURL === dataURL) return fid; // same bytes: share the entry
  const fileId = nid();
  doc.files[fileId] = {
    mimeType: mime,
    id: fileId,
    dataURL,
    created: Date.now(),
  };
  return fileId;
}

function makeImage({ x, y, w = 320, h = 240, fileId, style = {} }) {
  return baseElement({
    id: nid(),
    type: "image",
    x,
    y,
    width: w,
    height: h,
    fileId,
    scale: [1, 1],
    strokeColor: style.stroke ?? "transparent",
    backgroundColor: style.background ?? "transparent",
    strokeWidth: style.strokeWidth ?? 2,
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
    angle: style.angle ?? 0,
    link: style.link ?? null,
    locked: style.locked ?? false,
    frameId: style.frameId ?? null,
    roundness: style.roundness !== undefined ? style.roundness : { type: 3 },
  });
}

/** Embeddable (Web Embed tool). URL lives in `link`; only allowlisted hosts render inline. */
function makeEmbed({ x, y, w = 560, h = 315, url, style = {} }) {
  return baseElement({
    id: nid(),
    type: "embeddable",
    x,
    y,
    width: w,
    height: h,
    link: url,
    strokeColor: style.stroke ?? "#1e1e1e",
    backgroundColor: style.background ?? "transparent",
    strokeWidth: style.strokeWidth ?? 2,
    strokeStyle: style.strokeStyle ?? "solid",
    roughness: style.roughness ?? 1,
    opacity: style.opacity ?? 100,
    angle: style.angle ?? 0,
    locked: style.locked ?? false,
    frameId: style.frameId ?? null,
    roundness: style.roundness !== undefined ? style.roundness : { type: 3 },
  });
}

function nodePorts(node, side) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  switch (side) {
    case "top":
      return [cx, node.y];
    case "bottom":
      return [cx, node.y + node.height];
    case "left":
      return [node.x, cy];
    case "right":
      return [node.x + node.width, cy];
    default:
      return [cx, cy];
  }
}

function autoPlace(doc, h = 110) {
  const live = liveElements(doc);
  if (!live.length) return { x: ORIGIN_X, y: ORIGIN_Y };
  const bottom = Math.max(...live.map((e) => e.y + (e.height || 0)));
  return { x: ORIGIN_X, y: Math.round(bottom + 60) };
}

// ---------- layered layout (mermaid + spec share this) ----------
function computeDepths(nodes, edges) {
  const depth = new Map();
  const incoming = new Map([...nodes.keys()].map((k) => [k, []]));
  const outgoing = new Map([...nodes.keys()].map((k) => [k, []]));
  for (const e of edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    outgoing.get(e.from).push(e.to);
    incoming.get(e.to).push(e.from);
  }
  const queue = [];
  for (const [id, inc] of incoming) if (!inc.length) queue.push(id);
  // cycle fallback: seed leftovers at depth 0 so every node gets placed
  if (!queue.length && nodes.size) queue.push(nodes.keys().next().value);
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const d = incoming.get(id).length
      ? Math.max(...incoming.get(id).map((p) => depth.get(p) ?? 0)) + 1
      : 0;
    depth.set(id, d);
    for (const n of outgoing.get(id)) if (!seen.has(n)) queue.push(n);
  }
  for (const id of nodes.keys()) if (!depth.has(id)) depth.set(id, (Math.max(-1, ...depth.values())) + 1);
  return depth;
}

/** orientation: vertical (flow down), vertical-rev (flow up), horizontal (flow right), horizontal-rev. */
function layoutLayered(nodes, edges, orientation) {
  const depth = computeDepths(nodes, edges);
  const layers = new Map();
  for (const [id, d] of depth) {
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(id);
  }
  const vertical = orientation.startsWith("vertical");
  const rev = orientation.endsWith("rev");
  const ordered = [...layers.keys()].sort((a, b) => (rev ? b - a : a - b));
  const W = (n) => n._w;
  const H = (n) => n._h;
  // widest layer sets the cross-axis extent so layers center on each other
  let crossMax = 0;
  for (const d of ordered) {
    const ids = layers.get(d);
    const total = ids.reduce((s, id) => s + (vertical ? W(nodes.get(id)) : H(nodes.get(id))), 0) +
      (ids.length - 1) * (vertical ? GAP_X : GAP_Y);
    crossMax = Math.max(crossMax, total);
  }
  const pos = new Map();
  ordered.forEach((d, li) => {
    const ids = layers.get(d);
    const total = ids.reduce((s, id) => s + (vertical ? W(nodes.get(id)) : H(nodes.get(id))), 0) +
      (ids.length - 1) * (vertical ? GAP_X : GAP_Y);
    let cursor = (vertical ? ORIGIN_X : ORIGIN_Y) + (crossMax - total) / 2;
    const along = (vertical ? ORIGIN_Y : ORIGIN_X) + li * ((vertical ? 110 : 220) + (vertical ? GAP_Y : GAP_X));
    for (const id of ids) {
      const n = nodes.get(id);
      if (vertical) {
        pos.set(id, { x: Math.round(cursor), y: Math.round(along) });
        cursor += n._w + GAP_X;
      } else {
        pos.set(id, { x: Math.round(along), y: Math.round(cursor) });
        cursor += n._h + GAP_Y;
      }
    }
  });
  return pos;
}

function portsFor(orientation) {
  switch (orientation) {
    case "vertical":
      return ["bottom", "top"];
    case "vertical-rev":
      return ["top", "bottom"];
    case "horizontal":
      return ["right", "left"];
    case "horizontal-rev":
      return ["left", "right"];
    default:
      return ["bottom", "top"];
  }
}

// ---------- mermaid flowchart subset ----------
function parseMermaidFlowchart(src) {
  const rawLines = src.split("\n");
  const lines = [];
  for (const rl of rawLines) {
    const t = rl.trim();
    if (!t || t.startsWith("%%")) continue;
    if (/^(classDef|class |style |click |linkStyle|subgraph|end\b)/i.test(t)) continue;
    lines.push(t);
  }
  if (!lines.length) fail("empty mermaid input (0 diagram lines)", 1);
  let direction = "TD";
  let startIdx = 0;
  const m0 = lines[0].match(/^(graph|flowchart)\s+(TB|TD|BT|RL|LR)?\s*;?\s*$/i);
  if (m0) {
    direction = (m0[2] || "TD").toUpperCase();
    startIdx = 1;
  } else if (/^(sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph|sankey|requirementDiagram|c4Context|packet-beta|kanban)\b/i.test(lines[0])) {
    fail(
      `unsupported mermaid type ${JSON.stringify(lines[0].split(/\s+/)[0])} — v0.3 converts flowchart/graph (TD,TB,LR,RL,BT) and sequenceDiagram only`,
      1,
      ["excalidraw-axi create --help"]
    );
  }
  const nodes = new Map();
  const edges = [];
  const problems = [];

  function regNode(token) {
    const m = token.trim().match(/^([A-Za-z0-9_]+)\s*([\s\S]*)$/);
    if (!m) return null;
    const id = m[1];
    let rest = (m[2] || "").trim();
    let shape = "rectangle";
    let label = id;
    if (rest) {
      if (/^\{\{[\s\S]*\}\}$/.test(rest) || (/^\{[\s\S]*\}$/.test(rest))) {
        shape = "diamond";
        label = rest.replace(/^\{\{?|\}\}?$/g, "");
      } else if (/^\(\(\([\s\S]*\)\)\)$/.test(rest)) {
        shape = "ellipse";
        label = rest.replace(/^\(\(\(|\)\)\)$/g, "");
      } else if (/^\(\[[\s\S]*\]\)$/.test(rest)) {
        label = rest.replace(/^\(\[|\]\)$/g, "");
      } else if (/^\[\[[\s\S]*\]\]$/.test(rest)) {
        label = rest.replace(/^\[\[|\]\]$/g, "");
      } else if (/^\[\/[\s\S]*\/\]$/.test(rest)) {
        label = rest.replace(/^\[\/|\/\]$/g, "");
      } else if (/^\[\\[\s\S]*\\\]$/.test(rest)) {
        label = rest.replace(/^\[\\|\\\]$/g, "");
      } else if (/^\(\([\s\S]*\)\)$/.test(rest)) {
        shape = "ellipse";
        label = rest.replace(/^\(\(|\)\)$/g, "");
      } else if (/^\([\s\S]*\)$/.test(rest)) {
        label = rest.replace(/^\(|\)$/g, "");
      } else if (/^\[[\s\S]*\]$/.test(rest)) {
        label = rest.replace(/^\[|\]$/g, "");
      } else {
        label = rest;
      }
      label = label.replace(/^["']|["']$/g, "").trim() || id;
    }
    if (!nodes.has(id)) nodes.set(id, { id, shape, label });
    else {
      const n = nodes.get(id);
      if (n.label === id && label !== id) {
        n.label = label;
        n.shape = shape;
      }
    }
    return id;
  }

  // mask [...] (...) {...} spans so operators inside labels don't split
  const SPAN = /(\(\(\(.*?\)\)\)|\(\[.*?\]\)|\[\[.*?\]\]|\[\/.*?\/\]|\[\\.*?\\\]|\{\{.*?\}\}|\{.*?\}|\(.*?\)|\[.*?\])/g;
  const OP = /(-->|---|==>|--o|--x|-\.->|~~~|--)\s*(\|[^|]*\|)?\s*/;
  for (let li = startIdx; li < lines.length; li++) {
    const line = lines[li].replace(/;+\s*$/, "");
    const spans = [];
    const masked = line.replace(SPAN, (s) => {
      spans.push(s);
      return `\u0001${spans.length - 1}\u0001`;
    });
    if (!OP.test(masked)) {
      const id = regNode(line);
      if (!id) problems.push(`line ${li + 1}: cannot parse ${JSON.stringify(line)}`);
      continue;
    }
    const parts = masked.split(OP);
    // parts: [seg, op, label, seg, op, label, seg, ...]
    const segs = [];
    const labels = [];
    for (let i = 0; i < parts.length; i += 3) {
      segs.push((parts[i] || "").replace(/\u0001(\d+)\u0001/g, (_, k) => spans[Number(k)]));
      if (i + 2 < parts.length)
        labels.push(((parts[i + 2] || "").replace(/^\||\|$/g, "") || "").trim());
    }
    const ids = [];
    let bad = false;
    for (const s of segs) {
      const id = regNode(s);
      if (!id) {
        problems.push(`line ${li + 1}: cannot parse segment ${JSON.stringify(s)}`);
        bad = true;
        break;
      }
      ids.push(id);
    }
    if (bad) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      const label = [labels[i], labels[i + 1]].map((l) => l || "").find((l) => l) || "";
      edges.push({ from: ids[i], to: ids[i + 1], label });
    }
  }
  if (problems.length && !nodes.size)
    fail(`mermaid parse failed:\n  ${problems.slice(0, 5).join("\n  ")}`, 1);
  if (!nodes.size) fail("mermaid parse found 0 nodes — nothing to draw", 1);
  return { direction, nodes, edges };
}

function sizeNode(n) {
  const lines = String(n.label).split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));
  n._w = Math.min(340, Math.max(160, longest * 11 + 60));
  n._h = n.shape === "diamond" ? 140 : Math.max(80, 44 + lines.length * 28);
  return n;
}

function buildSceneFromGraph(nodes, edges, orientation, sourceNote) {
  for (const n of nodes.values()) sizeNode(n);
  const pos = layoutLayered(nodes, edges, orientation);
  const [outSide, inSide] = portsFor(orientation);
  const elements = [];
  const idMap = new Map(); // logical id -> element id
  for (const [id, n] of nodes) {
    const p = pos.get(id);
    const shape = makeShape(n.shape, {
      x: p.x,
      y: p.y,
      w: n._w,
      h: n._h,
      background: n._background ?? "#e3f2fd",
      stroke: n._stroke,
    });
    idMap.set(id, shape.id);
    elements.push(shape, shapeLabel(shape, n.label, 18));
  }
  const byElId = new Map([...idMap.entries()].map(([k, v]) => [v, k]));
  void byElId;
  const elByLogical = new Map(
    [...nodes.keys()].map((id) => [id, elements.find((e) => e.id === idMap.get(id))])
  );
  for (const e of edges) {
    const a = elByLogical.get(e.from);
    const b = elByLogical.get(e.to);
    if (!a || !b) continue;
    const [x1, y1] = nodePorts(a, outSide);
    const [x2, y2] = nodePorts(b, inSide);
    const { edge, extra } = makeEdge({
      x1,
      y1,
      x2,
      y2,
      kind: "arrow",
      from: a.id,
      to: b.id,
      label: e.label || null,
    });
    a.boundElements.push({ type: "arrow", id: edge.id });
    b.boundElements.push({ type: "arrow", id: edge.id });
    elements.push(edge, ...extra);
  }
  return {
    type: "excalidraw",
    version: 2,
    source: sourceNote || "https://github.com/nahidupa/excalidraw-axi",
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

// ---------- mermaid sequenceDiagram subset ----------
function parseSequenceDiagram(src) {
  const participants = new Map(); // id -> {id, label, kind}
  const messages = []; // {from, to, label, dashed}
  const notes = []; // {targets:[ids], text, at}
  const problems = [];

  function regParticipant(id, label, kind) {
    if (!participants.has(id))
      participants.set(id, { id, label: label || id, kind: kind || "participant" });
    else if (label) {
      const p = participants.get(id);
      if (p.label === id) {
        p.label = label;
        p.kind = kind || p.kind;
      }
    }
    return id;
  }

  const lines = src.split("\n");
  let started = false;
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim();
    if (!t || t.startsWith("%%")) continue;
    if (!started) {
      if (/^sequenceDiagram\b/i.test(t)) {
        started = true;
        continue;
      }
      fail("not a sequenceDiagram (first line must be `sequenceDiagram`)", 1);
    }
    let m;
    if ((m = t.match(/^(participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i)))
      regParticipant(m[2], (m[3] || "").trim(), m[1].toLowerCase());
    else if ((m = t.match(/^([A-Za-z0-9_]+)\s*(-{1,2}(?:>>|>|-x|x))\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/)) ||
      (m = t.match(/^([A-Za-z0-9_]+)\s*(-{1,2}(?:>>|>|-x|x))\s*([A-Za-z0-9_]+)\s*$/))) {
      const from = regParticipant(m[1]);
      const to = regParticipant(m[3]);
      messages.push({ from, to, label: (m[4] || "").trim(), dashed: m[2].startsWith("--") });
    } else if ((m = t.match(/^Note\s+(over|left of|right of)\s+([A-Za-z0-9_,\s]+):\s*(.*)$/i))) {
      const targets = m[2].split(",").map((s) => s.trim()).filter(Boolean);
      targets.forEach((id) => regParticipant(id));
      notes.push({ targets, text: m[3].trim() });
    } else if (/^(autonumber|activate|deactivate|loop|alt|else|opt|par|and|rect|break|end|par\b|create|destroy)\b/i.test(t)) {
      continue; // layout-hint lines: parsed for order, no geometry of their own
    } else {
      problems.push(`line ${li + 1}: cannot parse ${JSON.stringify(t)}`);
    }
  }
  if (!participants.size) fail("sequenceDiagram has 0 participants — nothing to draw", 1);
  if (!messages.length && !notes.length)
    fail("sequenceDiagram has 0 messages/notes — nothing to draw", 1);
  if (problems.length) fail(`sequenceDiagram parse failed:\n  ${problems.slice(0, 5).join("\n  ")}`, 1);
  return { participants, messages, notes };
}

function buildSceneFromSequence({ participants, messages, notes }) {
  const ids = [...participants.keys()];
  const BOX_W = 170;
  const BOX_H = 70;
  const COL_W = 260;
  const TOP = 100;
  const MSG_TOP = 300;
  const MSG_STEP = 70;
  const cx = new Map(ids.map((id, i) => [id, ORIGIN_X + i * (BOX_W + COL_W) + BOX_W / 2]));
  const totalMsgs = messages.length + notes.length;
  const bottom = MSG_TOP + Math.max(0, totalMsgs - 1) * MSG_STEP + 120;
  const elements = [];
  const idMap = new Map();
  for (const [id, p] of participants) {
    const shape = makeShape(p.kind === "actor" ? "ellipse" : "rectangle", {
      x: Math.round(cx.get(id) - BOX_W / 2),
      y: TOP,
      w: BOX_W,
      h: BOX_H,
      background: "#e3f2fd",
    });
    idMap.set(id, shape.id);
    elements.push(shape, shapeLabel(shape, p.label, 18));
    // lifeline: dashed line from box bottom to scene bottom
    const { edge } = makeEdge({
      x1: cx.get(id),
      y1: TOP + BOX_H + 6,
      x2: cx.get(id),
      y2: bottom,
      kind: "line",
      style: { stroke: "#adb5bd", strokeWidth: 1, strokeStyle: "dashed", roughness: 0 },
    });
    edge.roundness = null;
    elements.push(edge);
  }
  let row = 0;
  const place = (fn) => fn(MSG_TOP + row++ * MSG_STEP);
  for (const msg of messages) {
    place((y) => {
      const x1 = cx.get(msg.from);
      const self = msg.from === msg.to;
      const x2 = self ? x1 + 90 : cx.get(msg.to);
      const dir = x2 >= x1 ? 1 : -1;
      const { edge, extra } = makeEdge({
        x1: self ? x1 : x1 + dir * (BOX_W / 2),
        y1: y,
        x2,
        y2: y,
        kind: "arrow",
        style: msg.dashed ? { strokeStyle: "dashed" } : {},
        label: msg.label || null,
      });
      const a = elements.find((e) => e.id === idMap.get(msg.from));
      const b = elements.find((e) => e.id === idMap.get(msg.to));
      if (a) a.boundElements.push({ type: "arrow", id: edge.id });
      if (b && b !== a) b.boundElements.push({ type: "arrow", id: edge.id });
      if (!self) {
        edge.startBinding = { elementId: a.id, focus: 0, gap: 8 };
        edge.endBinding = { elementId: b.id, focus: 0, gap: 8 };
      }
      elements.push(edge, ...extra);
    });
  }
  for (const note of notes) {
    place((y) => {
      const xs = note.targets.map((id) => cx.get(id));
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
      const t = makeText({ x: Math.round(mid - 60), y: Math.round(y - 40), text: note.text, fontSize: 15 });
      elements.push(t);
    });
  }
  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/nahidupa/excalidraw-axi",
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

// ---------- commands ----------
function cmdHome() {
  const cwd = process.cwd();
  const scenes = findScenes(cwd);
  const out = [];
  out.push(`bin: ${shortBin()}`);
  out.push(`description: Agent-ergonomic CLI for drawing in Excalidraw (.excalidraw scenes)`);
  out.push(`count: ${scenes.length} scenes in ${cwd}`);
  if (scenes.length) {
    out.push(
      `scenes[${scenes.length}]{file}:`,
      ...scenes.slice(0, 20).map((s) => `  ${basename(s)}`)
    );
    if (scenes.length > 20)
      out.push(`  … (${scenes.length - 20} more — use \`excalidraw-axi list\`)`);
  } else {
    out.push(`(no .excalidraw files here — create one from a spec, mermaid, or shapes)`);
  }
  out.push(
    helpLines([
      "excalidraw-axi create --spec diagram.json -o out.excalidraw",
      "excalidraw-axi create --mermaid-file flow.mmd -o out.excalidraw",
      "excalidraw-axi add rectangle --label \"API\"",
      "excalidraw-axi export <file> --svg",
    ])
  );
  process.stdout.write(out.join("\n") + "\n");
}

function cmdList(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: 1 });
  if (opts.help) return printHelp("list");
  const dir = pos[0] || ".";
  const scenes = findScenes(dir);
  const out = [];
  out.push(`count: ${scenes.length}`);
  if (!scenes.length) {
    out.push(`(no .excalidraw files in ${resolve(dir)})`);
    out.push(
      helpLines(["excalidraw-axi create --spec diagram.json -o scene.excalidraw"])
    );
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  out.push(`scenes[${scenes.length}]{file,elements,bytes}:`);
  for (const s of scenes) {
    let elements = "?";
    try {
      const doc = JSON.parse(readFileSync(s, "utf8"));
      elements = Array.isArray(doc.elements)
        ? doc.elements.filter((e) => e && !e.isDeleted).length
        : "?";
    } catch {
      elements = "unparseable";
    }
    out.push(`  ${basename(s)},${elements},${statSync(s).size}`);
  }
  out.push(helpLines(["excalidraw-axi view <file>", "excalidraw-axi export <file> --svg"]));
  process.stdout.write(out.join("\n") + "\n");
}

function cmdView(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [{ name: "full", type: "boolean" }],
    positional: 1,
  });
  if (opts.help) return printHelp("view");
  if (!pos[0]) fail("view requires <file>", 2, ["excalidraw-axi view <file>"]);
  const { doc } = loadScene(pos[0]);
  const elements = liveElements(doc);
  const byType = {};
  for (const el of elements) byType[el.type || "?"] = (byType[el.type || "?"] || 0) + 1;
  const out = [];
  out.push(`file: ${pos[0]}`);
  out.push(`version: ${doc.version ?? "?"}`);
  out.push(`elements: ${elements.length}`);
  out.push(
    `byType: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"}`
  );
  out.push(`viewBackgroundColor: ${doc.appState?.viewBackgroundColor ?? "?"}`);
  const shown = elements.slice(0, 15);
  if (shown.length) {
    out.push(`items[${shown.length}]{id,type,x,y,w,h,text}:`);
    for (const el of shown) {
      const text =
        typeof el.text === "string" ? truncate(el.text.replace(/\n/g, " / "), opts.full) : "-";
      out.push(`  ${el.id},${el.type},${el.x},${el.y},${el.width},${el.height},${text}`);
    }
    if (elements.length > shown.length)
      out.push(`  … (${elements.length - shown.length} more — use --full)`);
  } else {
    out.push(`(empty scene — 0 elements)`);
  }
  out.push(
    helpLines([
      "excalidraw-axi get <file> <id>",
      "excalidraw-axi add rectangle --label \"New\"",
      "excalidraw-axi export <file> --svg",
    ])
  );
  process.stdout.write(out.join("\n") + "\n");
}

function cmdGet(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [{ name: "full", type: "boolean" }],
    positional: 2,
  });
  if (opts.help) return printHelp("get");
  if (pos.length < 2) fail("get requires <file> <id>", 2, ["excalidraw-axi get <file> <id>"]);
  const { doc } = loadScene(pos[0]);
  const el = findElement(doc, pos[1]);
  const json = JSON.stringify(el, null, 2);
  process.stdout.write(
    [`element: ${el.id} (${el.type})`, truncate(json, opts.full, JSON_TRUNCATE_AT)].join("\n") + "\n"
  );
}

function cmdValidate(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: 1 });
  if (opts.help) return printHelp("validate");
  if (!pos[0]) fail("validate requires <file>", 2, ["excalidraw-axi validate <file>"]);
  const { doc } = loadScene(pos[0]);
  const problems = [];
  if (doc.type !== "excalidraw") problems.push(`type is ${JSON.stringify(doc.type)}, want "excalidraw"`);
  if (!Array.isArray(doc.elements)) problems.push("elements is not an array");
  else {
    const live = liveElements(doc);
    const byId = new Map(live.filter((e) => e && typeof e === "object").map((e) => [e.id, e]));
    const ids = new Set();
    for (const el of live) {
      if (!el || typeof el !== "object") {
        problems.push(`element not an object`);
        continue;
      }
      for (const k of ["id", "type", "x", "y"])
        if (el[k] === undefined) problems.push(`${el.id || "?"} missing ${k}`);
      if (el.id !== undefined) {
        if (ids.has(el.id)) problems.push(`${el.id} duplicate id`);
        ids.add(el.id);
      }
      if (el.type !== undefined && !KNOWN_TYPES.has(el.type))
        problems.push(`${el.id || "?"} unknown type ${JSON.stringify(el.type)}`);
      for (const k of ["x", "y", "width", "height"])
        if (el[k] !== undefined && !Number.isFinite(el[k])) problems.push(`${el.id} ${k} not a number`);
      if (el.width !== undefined && el.width < 0) problems.push(`${el.id} negative width`);
      if (el.height !== undefined && el.height < 0) problems.push(`${el.id} negative height`);
      if (el.opacity !== undefined && !(el.opacity >= 0 && el.opacity <= 100))
        problems.push(`${el.id} opacity ${el.opacity} outside 0..100`);
      if (el.roughness !== undefined && !(el.roughness >= 0 && el.roughness <= 2))
        problems.push(`${el.id} roughness ${el.roughness} outside 0..2`);
      if (el.strokeWidth !== undefined && el.type !== "text" && !(el.strokeWidth > 0))
        problems.push(`${el.id} strokeWidth must be > 0`);
      if (el.strokeStyle !== undefined && !["solid", "dashed", "dotted"].includes(el.strokeStyle))
        problems.push(`${el.id} bad strokeStyle ${JSON.stringify(el.strokeStyle)}`);
      if (el.fillStyle !== undefined && !["solid", "hachure", "cross-hatch", "dots", "zigzag"].includes(el.fillStyle))
        problems.push(`${el.id} bad fillStyle ${JSON.stringify(el.fillStyle)}`);
      if (el.roundness !== undefined && el.roundness !== null && ![1, 2, 3].includes(el.roundness.type))
        problems.push(`${el.id} bad roundness ${JSON.stringify(el.roundness)}`);
      if (el.fontFamily !== undefined && !(el.fontFamily >= 1 && el.fontFamily <= 5))
        problems.push(`${el.id} fontFamily ${el.fontFamily} outside 1..5`);
      if (el.textAlign !== undefined && !["left", "center", "right", "justify"].includes(el.textAlign))
        problems.push(`${el.id} bad textAlign ${JSON.stringify(el.textAlign)}`);
      if (el.type === "arrow" || el.type === "line") {
        if (!Array.isArray(el.points) || el.points.length < 2 || !el.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
          problems.push(`${el.id} points must be 2+ [x,y] pairs`);
        for (const k of ["startArrowhead", "endArrowhead"])
          if (el[k] !== undefined && el[k] !== null && !["arrow", "triangle", "triangle_outline", "diamond", "diamond_outline", "circle", "circle_outline", "bar"].includes(el[k]))
            problems.push(`${el.id} bad ${k} ${JSON.stringify(el[k])}`);
        if (el.elbowed && el.fixedSegments !== undefined && el.fixedSegments !== null && !Array.isArray(el.fixedSegments))
          problems.push(`${el.id} elbowed arrow needs fixedSegments array|null`);
      }
      for (const k of ["startBinding", "endBinding"])
        if (el[k] && !byId.has(el[k].elementId))
          problems.push(`${el.id} dangling ${k} -> ${el[k].elementId} (re-add the arrow after edits)`);
      if (el.type === "freedraw") {
        if (!Array.isArray(el.points) || el.points.length < 2) problems.push(`${el.id} freedraw needs 2+ points`);
        if (el.pressures !== undefined && (!Array.isArray(el.pressures) || el.pressures.length !== (el.points || []).length))
          problems.push(`${el.id} pressures length must match points`);
      }
      if (el.type === "image") {
        if (!el.fileId || !doc.files || !doc.files[el.fileId] || !doc.files[el.fileId].dataURL)
          problems.push(`${el.id} image fileId ${JSON.stringify(el.fileId)} missing from files[]`);
      }
      if (el.type === "embeddable" && !(typeof el.link === "string" && el.link.length))
        problems.push(`${el.id} embeddable needs a link URL`);
      if (el.type === "text" && el.containerId != null) {
        const target = byId.get(el.containerId);
        if (!target) problems.push(`${el.id} containerId ${el.containerId} is not a live element`);
        else if (!LABEL_CONTAINERS.has(target.type))
          problems.push(`${el.id} containerId target ${target.id} is ${target.type}, not a label container`);
        else if (!Array.isArray(target.boundElements) || !target.boundElements.some((b) => b && b.type === "text" && b.id === el.id))
          problems.push(`${el.id} container ${target.id} missing reciprocal boundElements text entry`);
      }
      if (el.frameId != null && (!byId.has(el.frameId) || byId.get(el.frameId).type !== "frame"))
        problems.push(`${el.id} frameId ${el.frameId} is not a live frame`);
      if (Array.isArray(el.boundElements))
        for (const b of el.boundElements)
          if (b && b.id && !byId.has(b.id))
            problems.push(`${el.id} boundElements references deleted/missing ${b.id}`);
    }
  }
  if (problems.length) {
    process.stdout.write(
      [`valid: false`, `problems[${problems.length}]:`, ...problems.map((p) => `  ${p}`)].join("\n") + "\n"
    );
    process.exit(1);
  }
  const elements = liveElements(doc);
  process.stdout.write(
    [
      `valid: true`,
      `elements: ${elements.length}`,
      helpLines(["excalidraw-axi view <file>", "excalidraw-axi export <file> --svg"]),
    ].join("\n") + "\n"
  );
}

function makeSceneTitle(title) {
  const now = Date.now();
  const t = makeText({ x: 100, y: 80, text: title, fontSize: 20 });
  const r = makeShape("rectangle", { x: 100, y: 140, w: 400, h: 220 });
  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/nahidupa/excalidraw-axi",
    elements: [t, r],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function loadSpec(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) fail(`spec not found: ${path}`, 1);
  let spec;
  try {
    spec = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    fail(`invalid JSON in spec ${path}: ${e.message}`, 1);
  }
  if (!Array.isArray(spec.nodes) || !spec.nodes.length)
    fail(`spec needs non-empty "nodes" array [{label, shape?}]`, 1, [
      "excalidraw-axi create --help",
    ]);
  const nodes = new Map();
  spec.nodes.forEach((n, i) => {
    if (!n || typeof n !== "object" || !n.label)
      fail(`spec.nodes[${i}] needs a "label"`, 1, ["excalidraw-axi create --help"]);
    const id = String(n.id || n.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `node-${i}`);
    if (nodes.has(id)) fail(`duplicate spec node id: ${id}`, 1);
    const shape = (n.shape || "rectangle").toLowerCase();
    if (!["rectangle", "ellipse", "diamond", "text"].includes(shape))
      fail(`spec.nodes[${i}].shape must be rectangle|ellipse|diamond|text, got ${JSON.stringify(n.shape)}`, 1);
    nodes.set(id, {
      id,
      shape,
      label: String(n.label),
      _w: n.w ? num(n.w, "w") : undefined,
      _h: n.h ? num(n.h, "h") : undefined,
      _stroke: n.stroke !== undefined ? color(String(n.stroke), "stroke") : undefined,
      _background: n.background !== undefined ? color(String(n.background), "background") : undefined,
    });
  });
  const edges = [];
  for (const [i, e] of (spec.edges || []).entries()) {
    if (!e || !e.from || !e.to) fail(`spec.edges[${i}] needs "from" and "to"`, 1);
    if (!nodes.has(String(e.from))) fail(`spec.edges[${i}].from unknown node: ${e.from}`, 1);
    if (!nodes.has(String(e.to))) fail(`spec.edges[${i}].to unknown node: ${e.to}`, 1);
    edges.push({ from: String(e.from), to: String(e.to), label: e.label ? String(e.label) : "" });
  }
  const layout = String(spec.layout || "row").toLowerCase();
  if (!["row", "column", "grid"].includes(layout))
    fail(`spec.layout must be row|column|grid, got ${JSON.stringify(spec.layout)}`, 1);
  return { nodes, edges, layout };
}

function cmdCreate(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "out", short: "o", type: "string" },
      { name: "title", type: "string" },
      { name: "text", type: "string" },
      { name: "mermaid-file", type: "string" },
      { name: "spec", type: "string" },
    ],
    positional: 0,
  });
  if (opts.help) return printHelp("create");
  if (!opts.out)
    fail("create requires -o <out.excalidraw>", 2, [
      "excalidraw-axi create --spec diagram.json -o scene.excalidraw",
    ]);
  let scene;
  let note;
  if (opts.spec) {
    const { nodes, edges, layout } = loadSpec(opts.spec);
    if (layout === "grid") {
      // grid: fixed columns, then center-to-center edges
      for (const n of nodes.values()) sizeNode(n);
      const cols = Math.ceil(Math.sqrt(nodes.size));
      const ids = [...nodes.keys()];
      const pos = new Map();
      ids.forEach((id, i) => {
        const n = nodes.get(id);
        pos.set(id, {
          x: ORIGIN_X + (i % cols) * (n._w + GAP_X),
          y: ORIGIN_Y + Math.floor(i / cols) * (n._h + GAP_Y),
        });
      });
      const elements = [];
      const elByLogical = new Map();
      for (const [id, n] of nodes) {
        const p = pos.get(id);
        const shape = makeShape(n.shape, { x: p.x, y: p.y, w: n._w, h: n._h, background: n._background ?? "#e3f2fd", stroke: n._stroke });
        elByLogical.set(id, shape);
        elements.push(shape, shapeLabel(shape, n.label, 18));
      }
      for (const e of edges) {
        const a = elByLogical.get(e.from);
        const b = elByLogical.get(e.to);
        const ax = a.x + a.width / 2;
        const ay = a.y + a.height / 2;
        const bx = b.x + b.width / 2;
        const by = b.y + b.height / 2;
        const { edge, extra } = makeEdge({ x1: ax, y1: ay, x2: bx, y2: by, kind: "arrow", from: a.id, to: b.id, label: e.label || null });
        a.boundElements.push({ type: "arrow", id: edge.id });
        b.boundElements.push({ type: "arrow", id: edge.id });
        elements.push(edge, ...extra);
      }
      scene = { type: "excalidraw", version: 2, source: "https://github.com/nahidupa/excalidraw-axi", elements, appState: { viewBackgroundColor: "#ffffff" }, files: {} };
    } else {
      const orientation = layout === "column" ? "vertical" : "horizontal";
      scene = buildSceneFromGraph(nodes, edges, orientation);
    }
    note = `spec: ${nodes.size} nodes, ${edges.length} edges (${layout})`;
  } else if (opts["mermaid-file"]) {
    const mf = resolve(opts["mermaid-file"]);
    if (!existsSync(mf)) fail(`mermaid file not found: ${opts["mermaid-file"]}`, 1);
    const src = readFileSync(mf, "utf8");
    const first = (src.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("%%")) || "");
    if (/^sequenceDiagram\b/i.test(first)) {
      const seq = parseSequenceDiagram(src);
      scene = buildSceneFromSequence(seq);
      note = `mermaid sequence: ${seq.participants.size} participants, ${seq.messages.length} messages`;
    } else {
      const { direction, nodes, edges } = parseMermaidFlowchart(src);
      const orientation =
        direction === "LR" ? "horizontal" : direction === "RL" ? "horizontal-rev" : direction === "BT" ? "vertical-rev" : "vertical";
      scene = buildSceneFromGraph(nodes, edges, orientation);
      note = `mermaid ${direction}: ${nodes.size} nodes, ${edges.length} edges`;
    }
  } else {
    scene = makeSceneTitle(opts.title || opts.text || "Untitled diagram");
    note = "title template (use --spec or --mermaid-file to draw)";
  }
  const abs = resolve(opts.out);
  saveScene(abs, scene);
  process.stdout.write(
    [
      `created: ${opts.out}`,
      `elements: ${scene.elements.length}`,
      `layout: ${note}`,
      helpLines([`excalidraw-axi view ${opts.out}`, `excalidraw-axi export ${opts.out} --svg`]),
    ].join("\n") + "\n"
  );
}

const ADD_FLAGS = [
  { name: "x", type: "string" },
  { name: "y", type: "string" },
  { name: "w", type: "string" },
  { name: "h", type: "string" },
  { name: "width", type: "string" },
  { name: "height", type: "string" },
  { name: "stroke", type: "string" },
  { name: "background", type: "string" },
  { name: "bg", type: "string" },
  { name: "stroke-width", type: "string" },
  { name: "stroke-style", type: "string" },
  { name: "fill-style", type: "string" },
  { name: "roundness", type: "string" },
  { name: "angle", type: "string" },
  { name: "roughness", type: "string" },
  { name: "opacity", type: "string" },
  { name: "text", type: "string" },
  { name: "font-size", type: "string" },
  { name: "font-family", type: "string" },
  { name: "text-align", type: "string" },
  { name: "label", type: "string" },
  { name: "unbound", type: "boolean" },
  { name: "locked", type: "boolean" },
  { name: "link", type: "string" },
  { name: "frame", type: "string" },
  { name: "arrow-type", type: "string" },
  { name: "start-arrowhead", type: "string" },
  { name: "end-arrowhead", type: "string" },
  { name: "elbow", type: "boolean" },
  { name: "from", type: "string" },
  { name: "to", type: "string" },
  { name: "x1", type: "string" },
  { name: "y1", type: "string" },
  { name: "x2", type: "string" },
  { name: "y2", type: "string" },
  { name: "points", type: "string" },
  { name: "pressures", type: "string" },
  { name: "file", short: "f", type: "string" },
];

const ADD_KINDS = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "frame", "image", "embed"];

function assertFrameExists(doc, frameId) {
  const f = liveElements(doc).find((e) => e.id === frameId);
  if (!f) fail(`frame not found: ${frameId}`, 1, ["excalidraw-axi view <file>"]);
  if (f.type !== "frame") fail(`--frame needs a frame id, ${frameId} is ${f.type}`, 1);
}

function cmdAdd(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: ADD_FLAGS, positional: 2 });
  if (opts.help) return printHelp("add");
  const [file, kindRaw] = pos;
  if (!file || !kindRaw)
    fail("add requires <file> <type>", 2, ['excalidraw-axi add <file> rectangle --label "API"']);
  const kind = kindRaw.toLowerCase();
  if (!ADD_KINDS.includes(kind))
    fail(`unknown shape ${JSON.stringify(kindRaw)} — ${ADD_KINDS.join("|")}`, 2);
  const { doc, abs } = loadScene(file);
  if (opts.frame !== undefined) assertFrameExists(doc, opts.frame);
  const style = styleFor(kind, opts);
  const added = [];
  const push = (...els) => {
    doc.elements.push(...els);
    added.push(...els);
  };

  if (kind === "arrow" || kind === "line") {
    let absPts, from = null, to = null;
    if (opts.from || opts.to) {
      if (!opts.from || !opts.to) fail("arrow binding needs both --from <id> and --to <id>", 2);
      const a = findElement(doc, opts.from);
      const b = findElement(doc, opts.to);
      from = a.id;
      to = b.id;
      absPts = [
        [a.x + a.width / 2, a.y + a.height / 2],
        [b.x + b.width / 2, b.y + b.height / 2],
      ];
    } else if (opts.points) {
      absPts = parsePoints(opts.points);
    } else if (opts.x1 !== undefined || opts.y1 !== undefined || opts.x2 !== undefined || opts.y2 !== undefined) {
      if ([opts.x1, opts.y1, opts.x2, opts.y2].some((v) => v === undefined))
        fail("explicit arrow needs all of --x1 --y1 --x2 --y2", 2);
      absPts = [[num(opts.x1, "x1"), num(opts.y1, "y1")], [num(opts.x2, "x2"), num(opts.y2, "y2")]];
    } else {
      fail("arrow needs --from/--to, --points, or --x1/--y1/--x2/--y2", 2, [
        "excalidraw-axi view <file>",
      ]);
    }
    if (opts["arrow-type"] !== undefined)
      style.arrowType = oneOf(opts["arrow-type"], "arrow-type", ["sharp", "round"]);
    if (opts["start-arrowhead"] !== undefined || opts["end-arrowhead"] !== undefined) {
      if (kind !== "arrow") fail("arrowheads need kind arrow (the renderer draws no heads on lines)", 2);
      const head = (v, name) => {
        const h = oneOf(v, name, ["none", "arrow", "triangle", "triangle_outline", "diamond", "diamond_outline", "circle", "circle_outline", "bar"]);
        return h === "none" ? null : h;
      };
      if (opts["start-arrowhead"] !== undefined) style.startArrowhead = head(opts["start-arrowhead"], "start-arrowhead");
      if (opts["end-arrowhead"] !== undefined) style.endArrowhead = head(opts["end-arrowhead"], "end-arrowhead");
    }
    if (opts.elbow) {
      if (kind !== "arrow") fail("--elbow needs kind arrow", 2);
      if (absPts.length !== 2) fail("--elbow needs exactly 2 endpoints (use --from/--to or --x1/--y1/--x2/--y2)", 2);
      // The app stores elbow corners explicitly (no auto-route on load):
      // insert the orthogonal corner so the arrow renders as an L.
      const [[x1, y1], [x2, y2]] = absPts;
      if (x1 !== x2 && y1 !== y2)
        absPts = Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? [[x1, y1], [x2, y1], [x2, y2]] : [[x1, y1], [x1, y2], [x2, y2]];
      style.elbowed = true;
    }
    const { edge, extra } = makeEdge({ points: absPts, kind, from, to, label: opts.label || null, style });
    push(edge, ...extra);
    if (from) findElement(doc, from).boundElements.push({ type: "arrow", id: edge.id });
    if (to) findElement(doc, to).boundElements.push({ type: "arrow", id: edge.id });
  } else if (kind === "freedraw") {
    if (!opts.points) fail("freedraw needs --points \"x1,y1 x2,y2 ...\" (2+ points)", 2);
    const absPts = parsePoints(opts.points);
    let pressures = null;
    if (opts.pressures !== undefined) {
      pressures = String(opts.pressures).trim().split(/[\s,;]+/).filter(Boolean).map((p) => {
        const n = Number(p);
        if (!Number.isFinite(n) || n < 0 || n > 1)
          fail(`--pressures must be 0..1 numbers, got ${JSON.stringify(p)}`, 2);
        return n;
      });
      if (pressures.length !== absPts.length)
        fail(`--pressures has ${pressures.length} values but --points has ${absPts.length}`, 2);
    }
    push(makeFreedraw(absPts, { pressures, style }));
  } else if (kind === "frame") {
    const w = opts.w ?? opts.width;
    const h = opts.h ?? opts.height;
    let x = opts.x !== undefined ? num(opts.x, "x") : undefined;
    let y = opts.y !== undefined ? num(opts.y, "y") : undefined;
    if (x === undefined || y === undefined) {
      const p = autoPlace(doc);
      if (x === undefined) x = p.x;
      if (y === undefined) y = p.y;
    }
    push(makeFrame({ x, y, w: w !== undefined ? num(w, "w") : 400, h: h !== undefined ? num(h, "h") : 300, name: opts.label || opts.text || "Frame", style }));
  } else if (kind === "image") {
    if (!opts.file) fail("image needs --file <path.png>", 2);
    const fileId = loadImageFile(doc, opts.file);
    const w = opts.w ?? opts.width;
    const h = opts.h ?? opts.height;
    let iw;
    let ih;
    if (w !== undefined && h !== undefined) {
      iw = num(w, "w");
      ih = num(h, "h");
    } else {
      // preserve the raster's aspect: explicit side wins, else intrinsic size
      const dims = imageDimsOf(opts.file);
      if (!dims) fail(`cannot read dimensions of ${opts.file} — pass --w and --h explicitly`, 1);
      if (w !== undefined) {
        iw = num(w, "w");
        ih = Math.max(1, Math.round(iw / (dims.w / dims.h)));
      } else if (h !== undefined) {
        ih = num(h, "h");
        iw = Math.max(1, Math.round(ih * (dims.w / dims.h)));
      } else {
        const longest = Math.max(dims.w, dims.h);
        const scale = longest > 1000 ? 1000 / longest : 1;
        iw = Math.max(1, Math.round(dims.w * scale));
        ih = Math.max(1, Math.round(dims.h * scale));
      }
    }
    let x = opts.x !== undefined ? num(opts.x, "x") : undefined;
    let y = opts.y !== undefined ? num(opts.y, "y") : undefined;
    if (x === undefined || y === undefined) {
      const p = autoPlace(doc);
      if (x === undefined) x = p.x;
      if (y === undefined) y = p.y;
    }
    push(makeImage({ x, y, w: iw, h: ih, fileId, style }));
  } else if (kind === "embed") {
    if (!opts.link) fail("embed needs --link <https://...>", 2);
    if (!isHttpUrl(opts.link)) fail(`--link must be an http(s) URL, got ${JSON.stringify(opts.link)}`, 2);
    const w = opts.w ?? opts.width;
    const h = opts.h ?? opts.height;
    let x = opts.x !== undefined ? num(opts.x, "x") : undefined;
    let y = opts.y !== undefined ? num(opts.y, "y") : undefined;
    if (x === undefined || y === undefined) {
      const p = autoPlace(doc);
      if (x === undefined) x = p.x;
      if (y === undefined) y = p.y;
    }
    push(makeEmbed({ x, y, w: w !== undefined ? num(w, "w") : 560, h: h !== undefined ? num(h, "h") : 315, url: opts.link, style }));
  } else {
    const w = opts.w ?? opts.width;
    const h = opts.h ?? opts.height;
    let x = opts.x !== undefined ? num(opts.x, "x") : undefined;
    let y = opts.y !== undefined ? num(opts.y, "y") : undefined;
    if (x === undefined || y === undefined) {
      const p = autoPlace(doc);
      if (x === undefined) x = p.x;
      if (y === undefined) y = p.y;
    }
    const el =
      kind === "text"
        ? makeText({
            x,
            y,
            text: opts.text || fail("add text requires --text", 2),
            fontSize: opts["font-size"] ? num(opts["font-size"], "font-size") : 20,
            strokeColor: style.stroke ?? "#1e1e1e",
            fontFamily: style.fontFamily ?? 1,
            textAlign: style.textAlign ?? "left",
            link: style.link ?? null,
            locked: style.locked ?? false,
            frameId: style.frameId ?? null,
            angle: style.angle ?? 0,
          })
        : makeShape(kind, {
            x,
            y,
            w: w !== undefined ? num(w, "w") : undefined,
            h: h !== undefined ? num(h, "h") : undefined,
            ...style,
          });
    push(el);
    if (opts.label && kind !== "text") {
      const t = shapeLabel(el, opts.label, 18, !!opts.unbound);
      push(t);
    } else if (opts.label) {
      fail("--label is for shapes; text already carries --text", 2);
    }
  }
  saveScene(abs, doc);
  const out = [
    `added[${added.length}]{id,type}:`,
    ...added.map((e) => `  ${e.id},${e.type}`),
    helpLines([
      `excalidraw-axi view ${file}`,
      `excalidraw-axi export ${file} --svg`,
    ]),
  ];
  process.stdout.write(out.join("\n") + "\n");
}

/** Translate el by (dx,dy). Points-bearing elements keep relative geometry. */
function translateEl(el, dx, dy) {
  el.x += dx;
  el.y += dy;
  el.updated = Date.now();
}

/** Live arrows whose start+end bindings are all inside `ids` (unbound ends OK). */
function boundFollowers(doc, ids) {
  const set = new Set(ids);
  return liveElements(doc).filter(
    (e) =>
      (e.type === "arrow" || e.type === "line") &&
      !set.has(e.id) &&
      (e.startBinding || e.endBinding) &&
      ["startBinding", "endBinding"].every((k) => !e[k] || set.has(e[k].elementId))
  );
}

/** Live arrows bound to a moved id but left behind (caller reports them). */
function strandedArrows(doc, movedIds, followedIds) {
  const moved = new Set(movedIds);
  const followed = new Set(followedIds);
  return liveElements(doc).filter(
    (e) =>
      (e.type === "arrow" || e.type === "line") &&
      !moved.has(e.id) &&
      !followed.has(e.id) &&
      ["startBinding", "endBinding"].some((k) => e[k] && moved.has(e[k].elementId))
  );
}

/**
 * Translate texts bound (containerId) to moved containers.
 * deltas: Map<containerId, {dx, dy}>. Bound labels always follow — a label
 * has exactly one anchor, so there is no ambiguous partial case.
 */
function followBoundTexts(doc, deltas) {
  let n = 0;
  for (const el of liveElements(doc)) {
    if (el.type === "text" && el.containerId && deltas.has(el.containerId)) {
      const d = deltas.get(el.containerId);
      el.x += d.dx;
      el.y += d.dy;
      el.updated = Date.now();
      n++;
    }
  }
  return n;
}

function cmdMove(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "x", type: "string" },
      { name: "y", type: "string" },
      { name: "dx", type: "string" },
      { name: "dy", type: "string" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("move");
  if (pos.length < 2) fail("move requires <file> <id...>", 2, ["excalidraw-axi move <file> <id> --dx 0 --dy 60"]);
  const { doc, abs } = loadScene(pos[0]);
  const ids = pos.slice(1);
  const els = ids.map((id) => findElement(doc, id));
  const hasAbs = opts.x !== undefined || opts.y !== undefined;
  const hasDelta = opts.dx !== undefined || opts.dy !== undefined;
  if (hasAbs && (els.length > 1 || hasDelta))
    fail("--x/--y positions a single element; use --dx/--dy for groups", 2);
  if (!hasAbs && !hasDelta) fail("move needs --x/--y or --dx/--dy", 2);
  const dx = opts.dx !== undefined ? num(opts.dx, "dx") : 0;
  const dy = opts.dy !== undefined ? num(opts.dy, "dy") : 0;
  const deltas = new Map();
  for (const el of els) {
    const ox = el.x;
    const oy = el.y;
    if (hasAbs) {
      if (opts.x !== undefined) el.x = num(opts.x, "x");
      if (opts.y !== undefined) el.y = num(opts.y, "y");
    } else {
      translateEl(el, dx, dy);
    }
    el.updated = Date.now();
    deltas.set(el.id, { dx: el.x - ox, dy: el.y - oy });
  }
  // Arrows bound on every bound end to the moved set follow along.
  const followed = hasAbs ? [] : boundFollowers(doc, ids);
  for (const a of followed) translateEl(a, dx, dy);
  // Bound labels always follow their container.
  const followedTexts = followBoundTexts(doc, deltas);
  saveScene(abs, doc);
  const out = [
    `moved: ${els.length} element${els.length === 1 ? "" : "s"}` +
      (followed.length ? ` (+${followed.length} bound arrow${followed.length === 1 ? "" : "s"} followed)` : "") +
      (followedTexts ? ` (+${followedTexts} bound label${followedTexts === 1 ? "" : "s"})` : ""),
  ];
  const stranded = strandedArrows(doc, ids, followed.map((a) => a.id));
  if (stranded.length)
    out.push(`(left behind: ${stranded.length} arrow${stranded.length === 1 ? "" : "s"} bound to moved shapes — re-add them: ${stranded.slice(0, 3).map((a) => a.id).join(",")}${stranded.length > 3 ? "…" : ""})`);
  out.push(helpLines([`excalidraw-axi view ${pos[0]}`]));
  process.stdout.write(out.join("\n") + "\n");
}

function cmdDelete(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: Infinity });
  if (opts.help) return printHelp("delete");
  if (pos.length < 2) fail("delete requires <file> <id...>", 2, ["excalidraw-axi delete <file> <id>"]);
  const { doc, abs } = loadScene(pos[0]);
  const ids = pos.slice(1);
  let n = 0;
  for (const id of ids) {
    const el = doc.elements.find((e) => e && e.id === id && !e.isDeleted);
    if (!el) fail(`element not found: ${id}`, 1);
    el.isDeleted = true;
    el.updated = Date.now();
    n++;
  }
  // repair references so validate stays clean: drop boundElements entries,
  // bindings and containerIds pointing at the deleted ids
  const gone = new Set(ids);
  for (const el of doc.elements) {
    if (!el || typeof el !== "object") continue;
    if (Array.isArray(el.boundElements)) {
      const before = el.boundElements.length;
      el.boundElements = el.boundElements.filter((b) => !b || !b.id || !gone.has(b.id));
      if (el.boundElements.length !== before) el.updated = Date.now();
    }
    for (const k of ["startBinding", "endBinding"])
      if (el[k] && gone.has(el[k].elementId)) {
        el[k] = null;
        el.updated = Date.now();
      }
    if (el.containerId && gone.has(el.containerId)) {
      el.containerId = null;
      el.updated = Date.now();
    }
  }
  saveScene(abs, doc);
  process.stdout.write(
    [`deleted: ${n}`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

// ---------- arrange ops ----------
function resolveIds(doc, ids) {
  return ids.map((id) => findElement(doc, id));
}

function cmdGroup(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: Infinity });
  if (opts.help) return printHelp("group");
  if (pos.length < 3) fail("group requires <file> <id...>", 2, ["excalidraw-axi group <file> <id1> <id2>"]);
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  const gid = nid();
  for (const el of els) {
    el.groupIds = [...(el.groupIds || []), gid];
    el.updated = Date.now();
  }
  saveScene(abs, doc);
  process.stdout.write(
    [`grouped: ${els.length} elements -> group ${gid}`, helpLines([`excalidraw-axi ungroup ${pos[0]} ${gid}`])].join("\n") + "\n"
  );
}

function cmdUngroup(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: 2 });
  if (opts.help) return printHelp("ungroup");
  if (pos.length < 2) fail("ungroup requires <file> <group-id>", 2);
  const { doc, abs } = loadScene(pos[0]);
  let n = 0;
  for (const el of liveElements(doc)) {
    if (el.groupIds && el.groupIds.includes(pos[1])) {
      el.groupIds = el.groupIds.filter((g) => g !== pos[1]);
      el.updated = Date.now();
      n++;
    }
  }
  if (!n) fail(`group not found: ${pos[1]}`, 1, [`excalidraw-axi get ${pos[0]} <id>`]);
  saveScene(abs, doc);
  process.stdout.write(
    [`ungrouped: ${pos[1]} (${n} elements)`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

function selBox(els) {
  const x0 = Math.min(...els.map((e) => e.x));
  const y0 = Math.min(...els.map((e) => e.y));
  const x1 = Math.max(...els.map((e) => e.x + (e.width || 0)));
  const y1 = Math.max(...els.map((e) => e.y + (e.height || 0)));
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

const ALIGN_FLAGS = ["left", "center", "right", "top", "middle", "bottom"].map((n) => ({ name: n, type: "boolean" }));

function cmdAlign(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: ALIGN_FLAGS, positional: Infinity });
  if (opts.help) return printHelp("align");
  if (pos.length < 3) fail("align requires <file> <id...> (2+)", 2);
  const modes = ALIGN_FLAGS.map((f) => f.name).filter((n) => opts[n]);
  if (modes.length !== 1) fail("align needs exactly one of --left|--center|--right|--top|--middle|--bottom", 2);
  const mode = modes[0];
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  const box = selBox(els);
  const deltas = new Map();
  for (const el of els) {
    const ox = el.x;
    const oy = el.y;
    if (mode === "left") el.x = box.x0;
    else if (mode === "center") el.x = Math.round(box.x0 + (box.w - (el.width || 0)) / 2);
    else if (mode === "right") el.x = Math.round(box.x1 - (el.width || 0));
    else if (mode === "top") el.y = box.y0;
    else if (mode === "middle") el.y = Math.round(box.y0 + (box.h - (el.height || 0)) / 2);
    else if (mode === "bottom") el.y = Math.round(box.y1 - (el.height || 0));
    el.updated = Date.now();
    deltas.set(el.id, { dx: el.x - ox, dy: el.y - oy });
  }
  const followedTexts = followBoundTexts(doc, deltas);
  saveScene(abs, doc);
  const out = [`aligned: ${els.length} elements --${mode}` + (followedTexts ? ` (+${followedTexts} bound labels)` : "")];
  const stranded = strandedArrows(doc, els.map((e) => e.id), []);
  if (stranded.length)
    out.push(`(left behind: ${stranded.length} bound arrows — re-add them)`);
  out.push(helpLines([`excalidraw-axi view ${pos[0]}`]));
  process.stdout.write(out.join("\n") + "\n");
}

function cmdDistribute(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "horizontal", type: "boolean" },
      { name: "vertical", type: "boolean" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("distribute");
  if (pos.length < 4) fail("distribute requires <file> <id...> (3+)", 2);
  if (!!opts.horizontal === !!opts.vertical)
    fail("distribute needs exactly one of --horizontal|--vertical", 2);
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  const horiz = !!opts.horizontal;
  const sorted = [...els].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
  const size = (e) => (horiz ? e.width || 0 : e.height || 0);
  const start = (e) => (horiz ? e.x : e.y);
  const first = start(sorted[0]);
  const last = start(sorted[sorted.length - 1]) + size(sorted[sorted.length - 1]);
  const total = sorted.reduce((s, e) => s + size(e), 0);
  const gap = (last - first - total) / (sorted.length - 1);
  if (gap < 0) fail("distribute: elements overlap along the axis — spread them first", 1);
  let cursor = first;
  const deltas = new Map();
  for (const el of sorted) {
    const ox = el.x;
    const oy = el.y;
    if (horiz) el.x = Math.round(cursor);
    else el.y = Math.round(cursor);
    el.updated = Date.now();
    deltas.set(el.id, { dx: el.x - ox, dy: el.y - oy });
    cursor += size(el) + gap;
  }
  followBoundTexts(doc, deltas);
  saveScene(abs, doc);
  process.stdout.write(
    [`distributed: ${els.length} elements (${horiz ? "horizontal" : "vertical"}, gap ${Math.round(gap)})`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

function cmdFlip(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "horizontal", type: "boolean" },
      { name: "vertical", type: "boolean" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("flip");
  if (pos.length < 2) fail("flip requires <file> <id...>", 2);
  if (!!opts.horizontal === !!opts.vertical)
    fail("flip needs exactly one of --horizontal|--vertical", 2);
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  const box = selBox(els);
  const cx = box.x0 + box.w / 2;
  const cy = box.y0 + box.h / 2;
  const horiz = !!opts.horizontal;
  const deltas = new Map();
  for (const el of els) {
    const ox = el.x;
    const oy = el.y;
    if (horiz) {
      el.x = Math.round(2 * cx - el.x - (el.width || 0));
      if (Array.isArray(el.points)) el.points = el.points.map(([px, py]) => [(el.width || 0) - px, py]);
      if (el.type !== "text") el.angle = -(el.angle || 0);
    } else {
      el.y = Math.round(2 * cy - el.y - (el.height || 0));
      if (Array.isArray(el.points)) el.points = el.points.map(([px, py]) => [px, (el.height || 0) - py]);
      if (el.type !== "text") el.angle = -(el.angle || 0);
    }
    el.updated = Date.now();
    deltas.set(el.id, { dx: el.x - ox, dy: el.y - oy });
  }
  followBoundTexts(doc, deltas);
  saveScene(abs, doc);
  process.stdout.write(
    [`flipped: ${els.length} elements (${horiz ? "horizontal" : "vertical"})`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

/** Deep-clone elements with fresh ids, translated by (dx,dy). Bindings and
 *  containerIds remap inside the set, dangling refs outside are dropped. */
function cloneWithFreshIds(els, dx, dy) {
  const srcIds = new Set(els.map((e) => e.id));
  const remap = new Map(els.map((e) => [e.id, nid()]));
  return els.map((el) => {
    const c = JSON.parse(JSON.stringify(el));
    c.id = remap.get(el.id);
    c.seed = randomInt(0, 2 ** 31);
    c.versionNonce = randomInt(0, 2 ** 31);
    c.version = 1;
    c.updated = Date.now();
    c.isDeleted = false;
    c.x += dx;
    c.y += dy;
    // rebind inside the duplicated set, drop dangling refs outside it
    for (const k of ["startBinding", "endBinding"])
      if (c[k]) c[k] = srcIds.has(c[k].elementId) ? { ...c[k], elementId: remap.get(c[k].elementId) } : null;
    if (c.containerId) c.containerId = srcIds.has(c.containerId) ? remap.get(c.containerId) : null;
    if (Array.isArray(c.boundElements))
      c.boundElements = c.boundElements
        .filter((b) => !b.id || srcIds.has(b.id))
        .map((b) => ({ ...b, id: remap.get(b.id) ?? b.id }));
    return c;
  });
}

function cmdDuplicate(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "dx", type: "string" },
      { name: "dy", type: "string" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("duplicate");
  if (pos.length < 2) fail("duplicate requires <file> <id...>", 2);
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  const dx = opts.dx !== undefined ? num(opts.dx, "dx") : 20;
  const dy = opts.dy !== undefined ? num(opts.dy, "dy") : 20;
  const clones = cloneWithFreshIds(els, dx, dy);
  doc.elements.push(...clones);
  saveScene(abs, doc);
  process.stdout.write(
    [
      `duplicated[${clones.length}]{id}:`,
      ...clones.map((e) => `  ${e.id}`),
      helpLines([`excalidraw-axi view ${pos[0]}`]),
    ].join("\n") + "\n"
  );
}

function cmdLock(rawArgs, lock) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: Infinity });
  const name = lock ? "lock" : "unlock";
  if (opts.help) return printHelp(name);
  if (pos.length < 2) fail(`${name} requires <file> <id...>`, 2);
  const { doc, abs } = loadScene(pos[0]);
  const els = resolveIds(doc, pos.slice(1));
  for (const el of els) {
    el.locked = lock;
    el.updated = Date.now();
  }
  saveScene(abs, doc);
  process.stdout.write(
    [`${name}ed: ${els.length} elements`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

function cmdLink(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "url", type: "string" },
      { name: "remove", type: "boolean" },
    ],
    positional: 2,
  });
  if (opts.help) return printHelp("link");
  if (pos.length < 2) fail("link requires <file> <id>", 2);
  if (!!opts.url === !!opts.remove) fail("link needs exactly one of --url <https://...> | --remove", 2);
  const { doc, abs } = loadScene(pos[0]);
  const el = findElement(doc, pos[1]);
  if (opts.remove) {
    el.link = null;
  } else {
    if (!isHttpUrl(opts.url)) fail(`--url must be an http(s) URL, got ${JSON.stringify(opts.url)}`, 2);
    el.link = opts.url;
  }
  el.updated = Date.now();
  saveScene(abs, doc);
  process.stdout.write(
    [`linked: ${el.id} -> ${el.link === null ? "(removed)" : el.link}`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

function cmdOrder(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "front", type: "boolean" },
      { name: "back", type: "boolean" },
      { name: "forward", type: "boolean" },
      { name: "backward", type: "boolean" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("order");
  if (pos.length < 2) fail("order requires <file> <id...>", 2);
  const modes = ["front", "back", "forward", "backward"].filter((m) => opts[m]);
  if (modes.length !== 1) fail("order needs exactly one of --front|--back|--forward|--backward", 2);
  const mode = modes[0];
  const { doc, abs } = loadScene(pos[0]);
  const sel = new Set(resolveIds(doc, pos.slice(1)).map((e) => e.id));
  const els = doc.elements;
  if (mode === "front") {
    const keep = els.filter((e) => !sel.has(e.id));
    const move = els.filter((e) => sel.has(e.id));
    doc.elements = [...keep, ...move];
  } else if (mode === "back") {
    const keep = els.filter((e) => !sel.has(e.id));
    const move = els.filter((e) => sel.has(e.id));
    doc.elements = [...move, ...keep];
  } else if (mode === "forward") {
    for (let i = els.length - 2; i >= 0; i--) {
      if (sel.has(els[i].id) && !sel.has(els[i + 1].id)) {
        [els[i], els[i + 1]] = [els[i + 1], els[i]];
      }
    }
  } else {
    for (let i = 1; i < els.length; i++) {
      if (sel.has(els[i].id) && !sel.has(els[i - 1].id)) {
        [els[i], els[i - 1]] = [els[i - 1], els[i]];
      }
    }
  }
  saveScene(abs, doc);
  process.stdout.write(
    [`ordered: ${sel.size} elements --${mode}`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
}

// ---------- libraries (.excalidrawlib) ----------
function loadLib(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) return { abs, lib: null };
  let lib;
  try {
    lib = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    fail(`invalid JSON in library ${path}: ${e.message}`, 1);
  }
  if (lib.type !== "excalidrawlib" || !Array.isArray(lib.libraryItems))
    fail(`${path} is not an .excalidrawlib file (want {type:"excalidrawlib", libraryItems:[]})`, 1);
  return { abs, lib };
}

function saveLib(abs, lib) {
  writeFileSync(abs, JSON.stringify(lib, null, 2) + "\n");
}

function cmdLib(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "name", type: "string" },
      { name: "dx", type: "string" },
      { name: "dy", type: "string" },
    ],
    positional: Infinity,
  });
  if (opts.help) return printHelp("lib");
  const [sub, ...rest] = pos;
  if (sub === "list") {
    if (rest.length !== 1) fail("lib list requires <libfile>", 2);
    const { lib } = loadLib(rest[0]);
    if (!lib) fail(`library not found: ${rest[0]}`, 1);
    const out = [`items: ${lib.libraryItems.length}`];
    if (lib.libraryItems.length)
      out.push(
        `items[${lib.libraryItems.length}]{id,elements,created}:`,
        ...lib.libraryItems.map((it) => `  ${it.id},${(it.elements || []).length},${it.created ? new Date(it.created).toISOString().slice(0, 10) : "?"}`)
      );
    else out.push(`(empty library — add items with lib push)`);
    out.push(helpLines([`excalidraw-axi lib unpack ${rest[0]} <item-id> <scene>`]));
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  if (sub === "push") {
    if (rest.length < 2) fail("lib push requires <libfile> <scene> <id...>", 2);
    const [libfile, scene, ...ids] = rest;
    const { doc } = loadScene(scene);
    const els = resolveIds(doc, ids);
    const { abs, lib } = loadLib(libfile);
    const target = lib || { type: "excalidrawlib", version: 2, libraryItems: [] };
    const item = {
      id: nid(),
      status: "published",
      elements: JSON.parse(JSON.stringify(els)),
      created: Date.now(),
    };
    if (opts.name) item.name = opts.name;
    target.libraryItems.push(item);
    saveLib(abs, target);
    process.stdout.write(
      [`pushed: item ${item.id} (${els.length} elements) -> ${libfile}`, helpLines([`excalidraw-axi lib list ${libfile}`])].join("\n") + "\n"
    );
    return;
  }
  if (sub === "unpack") {
    if (rest.length !== 3) fail("lib unpack requires <libfile> <item-id> <scene>", 2);
    const [libfile, itemId, scene] = rest;
    const { lib } = loadLib(libfile);
    if (!lib) fail(`library not found: ${libfile}`, 1);
    const item = lib.libraryItems.find((it) => it && it.id === itemId);
    if (!item) fail(`library item not found: ${itemId}`, 1, [`excalidraw-axi lib list ${libfile}`]);
    if (!Array.isArray(item.elements) || !item.elements.length)
      fail(`library item ${itemId} has no elements`, 1);
    const { doc, abs } = loadScene(scene);
    const dx = opts.dx !== undefined ? num(opts.dx, "dx") : 0;
    const dy = opts.dy !== undefined ? num(opts.dy, "dy") : 0;
    const clones = cloneWithFreshIds(item.elements.filter((e) => e && !e.isDeleted), dx, dy);
    doc.elements.push(...clones);
    saveScene(abs, doc);
    process.stdout.write(
      [
        `unpacked[${clones.length}]{id}:`,
        ...clones.map((e) => `  ${e.id}`),
        helpLines([`excalidraw-axi validate ${scene}`]),
      ].join("\n") + "\n"
    );
    return;
  }
  fail(`lib needs push|list|unpack, got ${JSON.stringify(sub)}`, 2, ["excalidraw-axi lib --help"]);
}

function cmdClear(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: [], positional: 1 });
  if (opts.help) return printHelp("clear");
  if (!pos[0]) fail("clear requires <file>", 2, ["excalidraw-axi clear <file>"]);
  const { doc, abs } = loadScene(pos[0]);
  const n = liveElements(doc).length;
  doc.elements = [];
  saveScene(abs, doc);
  process.stdout.write(
    [`cleared: ${n} elements removed from ${pos[0]}`, helpLines([`excalidraw-axi add ${pos[0]} rectangle --label "Start"`])].join("\n") + "\n"
  );
}

// ---------- live instance (serve/open/sync) ----------
// The Excalidraw web app loads external scenes via `#url=<scene-file-url>`
// (fetch + same loader as the Open dialog). The CLI serves the file with
// CORS headers so a tab at --url can fetch it from 127.0.0.1:<port>.
const SERVE_DEFAULT_PORT = 5237;

function stripHash(u) {
  return String(u).replace(/#.*$/, "");
}

function viewerLink(viewer, fileUrl) {
  return `${stripHash(viewer)}#url=${encodeURIComponent(fileUrl)}`;
}

function startSceneServer(abs, port) {
  const server = createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (u.pathname === "/scene.excalidraw") {
      let body;
      try {
        body = readFileSync(abs, "utf8");
        JSON.parse(body);
      } catch (e) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("scene unreadable");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }
    if (u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("excalidraw-axi scene server: GET /scene.excalidraw\n");
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  return new Promise((resolve, reject) => {
    server.on("error", (e) => reject(e));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function cmdServe(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "port", type: "string" },
      { name: "url", type: "string" },
    ],
    positional: 1,
  });
  if (opts.help) return printHelp("serve");
  if (!pos[0]) fail("serve requires <file>", 2, ["excalidraw-axi serve <file>"]);
  const { abs } = loadScene(pos[0]); // fail fast if unreadable
  const port = opts.port !== undefined ? num(opts.port, "port") : SERVE_DEFAULT_PORT;
  const viewer = opts.url || "http://localhost:5001";
  let server;
  try {
    server = await startSceneServer(abs, port);
  } catch (e) {
    fail(`cannot serve on 127.0.0.1:${port} (${e.message})`, 1, [`excalidraw-axi serve ${pos[0]} --port <free-port>`]);
  }
  const link = viewerLink(viewer, `http://127.0.0.1:${port}/scene.excalidraw`);
  process.stdout.write(
    [
      `serving: ${pos[0]} on http://127.0.0.1:${port}/scene.excalidraw`,
      `open: ${link}`,
      `(paste into your running Excalidraw tab — click Load if it asks to replace the canvas)`,
      helpLines([`excalidraw-axi open ${pos[0]}`, `excalidraw-axi sync ${pos[0]}`]),
    ].join("\n") + "\n"
  );
  void server;
  await new Promise(() => {}); // serve until Ctrl+C
}

async function cmdOpen(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "port", type: "string" },
      { name: "url", type: "string" },
      { name: "no-launch", type: "boolean" },
    ],
    positional: 1,
  });
  if (opts.help) return printHelp("open");
  if (!pos[0]) fail("open requires <file>", 2, ["excalidraw-axi open <file>"]);
  const { abs } = loadScene(pos[0]);
  const port = opts.port !== undefined ? num(opts.port, "port") : SERVE_DEFAULT_PORT;
  const viewer = opts.url || "http://localhost:5001";
  let server;
  try {
    server = await startSceneServer(abs, port);
  } catch (e) {
    fail(`cannot serve on 127.0.0.1:${port} (${e.message})`, 1, [`excalidraw-axi open ${pos[0]} --port <free-port>`]);
  }
  const link = viewerLink(viewer, `http://127.0.0.1:${port}/scene.excalidraw`);
  const out = [
    `serving: ${pos[0]} on http://127.0.0.1:${port}/scene.excalidraw`,
    `open: ${link}`,
  ];
  if (!opts["no-launch"]) {
    const opener = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
    const r = spawnSync(opener, [link], { stdio: "ignore" });
    out.push(r.error || r.status !== 0 ? `(browser launch failed — paste the open: URL manually)` : `launched: browser`);
  }
  out.push(`(click Load in the tab if it asks to replace the canvas)`);
  out.push(helpLines([`excalidraw-axi sync ${pos[0]}`]));
  process.stdout.write(out.join("\n") + "\n");
  void server;
  await new Promise(() => {}); // serve until Ctrl+C
}

function runHelper(args) {
  const r = spawnSync("chrome-devtools-axi", args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: String(r.stdout || "") + String(r.stderr || "") };
}

function helperResult(out) {
  const m = String(out).split("\n").find((l) => l.startsWith("result: "));
  if (!m) return undefined;
  let v;
  try {
    v = JSON.parse(m.slice("result: ".length));
  } catch {
    return undefined;
  }
  // string payloads come double-encoded (result: "\"...\"") — unwrap them
  for (let i = 0; i < 2 && typeof v === "string" && v.startsWith('"'); i++) {
    try {
      v = JSON.parse(v);
    } catch {
      break;
    }
  }
  return v;
}

// ---------- tab file transfer (images live in IDB files-store) ----------
// The #url= loader does not ingest scene.files, so sync pre-seeds the tab's
// files-store and pull reads it back. Payloads move in slices to stay clear
// of arg/stdout size limits. step(args, what) runs a helper call, exits on
// helper failure, and returns stdout.
function idbPutFile(fid, rec, step) {
  const json = JSON.stringify({ ...rec, id: fid, lastRetrieved: Date.now() });
  const init = helperResult(step(["eval", "() => { window.__axi_file = ''; return 'ready'; }"], "stage image file"));
  if (init !== "ready") fail("sync failed (tab would not stage image bytes)", 1);
  const CH = 48 * 1024;
  for (let i = 0; i < json.length; i += CH) {
    const slice = json.slice(i, i + CH);
    const got = Number(
      helperResult(step(["eval", `() => { window.__axi_file += ${JSON.stringify(slice)}; return window.__axi_file.length; }`], "stage image file"))
    );
    if (got !== Math.min(i + CH, json.length)) fail("sync failed (image staging mismatch — tab storage unavailable?)", 1);
  }
  const doneRes = helperResult(
    step(
      [
        "eval",
        `() => new Promise(function(res){ var open = indexedDB.open("files-db"); open.onsuccess = function(){ var db = open.result; var tx = db.transaction("files-store", "readwrite"); tx.objectStore("files-store").put(JSON.parse(window.__axi_file), ${JSON.stringify(fid)}); tx.oncomplete = function(){ window.__axi_file = ""; res("stored"); }; tx.onerror = function(){ res("ERR"); }; }; open.onerror = function(){ res("ERR"); }; })`,
      ],
      "push image file"
    )
  );
  if (doneRes !== "stored") fail(`sync failed (could not store image ${fid} in tab)`, 1);
}

/** Read one file record back. Returns {mimeType,id,dataURL,created} or null. */
function idbGetFile(fid, step) {
  const envJson = helperResult(
    step(
      [
        "eval",
        `() => new Promise(function(res){ var open = indexedDB.open("files-db"); open.onsuccess = function(){ var db = open.result; var tx = db.transaction("files-store", "readonly"); var q = tx.objectStore("files-store").get(${JSON.stringify(fid)}); q.onsuccess = function(){ var r = q.result; res(JSON.stringify(r ? { mimeType: r.mimeType, id: r.id || ${JSON.stringify(fid)}, created: r.created, len: String(r.dataURL || "").length } : null)); }; q.onerror = function(){ res("null"); }; }; open.onerror = function(){ res("null"); }; })`,
      ],
      "read tab files"
    )
  );
  let env = null;
  try {
    env = JSON.parse(envJson);
  } catch {}
  if (!env || !env.len) return null;
  const total = Number(env.len);
  if (!(total > 0) || total > 8 * 1024 * 1024) return null;
  let dataURL = "";
  const CH = 128 * 1024;
  for (let i = 0; i < total; i += CH) {
    const end = Math.min(i + CH, total);
    const slice = helperResult(
      step(
        [
          "eval",
          `() => new Promise(function(res){ var open = indexedDB.open("files-db"); open.onsuccess = function(){ var db = open.result; var tx = db.transaction("files-store", "readonly"); var q = tx.objectStore("files-store").get(${JSON.stringify(fid)}); q.onsuccess = function(){ res(String((q.result && q.result.dataURL) || "").slice(${i}, ${end})); }; q.onerror = function(){ res(""); }; }; open.onerror = function(){ res(""); }; })`,
        ],
        "read tab files"
      )
    );
    if (typeof slice !== "string") return null;
    dataURL += slice;
  }
  if (dataURL.length !== total) return null;
  return { mimeType: env.mimeType, id: env.id, dataURL, created: env.created };
}

async function cmdSync(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "port", type: "string" },
      { name: "url", type: "string" },
    ],
    positional: 1,
  });
  if (opts.help) return printHelp("sync");
  if (!pos[0]) fail("sync requires <file>", 2, ["excalidraw-axi sync <file>"]);
  const { doc, abs } = loadScene(pos[0]);
  const want = liveElements(doc).length;
  const probe = runHelper(["--help"]);
  if (!probe.ok)
    fail("sync needs the chrome-devtools-axi browser helper on PATH (it drives the check)", 1, [
      `excalidraw-axi open ${pos[0]}   (manual: paste the open: URL into your tab)`,
    ]);
  const port = opts.port !== undefined ? num(opts.port, "port") : SERVE_DEFAULT_PORT;
  const viewer = opts.url || "http://localhost:5001";
  const link = viewerLink(viewer, `http://127.0.0.1:${port}/scene.excalidraw`);
  // The scene server must live in its own process: spawnSync blocks this
  // process's event loop, so an in-process server could never answer the
  // tab's fetch while a helper command runs. Reuse `serve` detached.
  const child = spawn(process.execPath, [process.argv[1], "serve", abs, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const killServer = () => {
    try {
      child.kill();
    } catch {}
  };
  process.on("SIGINT", () => {
    killServer();
    process.exit(130);
  });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`);
      if (r.ok) {
        ready = true;
        try {
          await r.text();
        } catch {}
      }
    } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 250));
  }
  const done = (code) => {
    killServer();
    process.exit(code);
  };
  if (!ready) {
    process.stdout.write(
      `error: cannot serve on 127.0.0.1:${port} (still busy after 10s — is another serve running?)\n`
    );
    done(1);
  }
  const step = (args, what) => {
    const r = runHelper(args);
    if (!r.ok) {
      process.stdout.write(`error: sync failed at ${what} (browser helper error)\n`);
      done(1);
    }
    return r.out;
  };
  // Start from a blank canvas so the app loads without a confirm dialog.
  step(["open", stripHash(viewer)], "open viewer");
  const cleared = helperResult(step(["eval", '() => { localStorage.setItem("excalidraw", "[]"); return "cleared"; }'], "clear canvas"));
  if (cleared !== "cleared") {
    process.stdout.write(`error: sync failed (could not clear canvas)\n`);
    done(1);
  }
  // The #url= loader ignores scene.files — pre-seed the tab's files-store
  // so images render instead of placeholders.
  const fileIds = Object.keys(doc.files || {});
  for (const fid of fileIds) idbPutFile(fid, doc.files[fid], step);
  step(["open", link], "open scene link");
  // Poll: the app fetches + renders async, then persists to localStorage.
  let got;
  for (let i = 0; i < 6; i++) {
    step(["wait", "2000"], "wait");
    const out = step(["eval", '() => JSON.parse(localStorage.getItem("excalidraw")).length'], "read canvas");
    got = Number(helperResult(out));
    if (got === want) break;
  }
  if (got === want) {
    const nImages = liveElements(doc).filter((e) => e.type === "image").length;
    const lines = [
      `synced: ${got} elements${fileIds.length ? ` (+${fileIds.length} files)` : ""} -> ${stripHash(viewer)}`,
    ];
    if (nImages > 1)
      lines.push(`(note: this app build resolves only single images on #url= load — with ${nImages} images the tab may show placeholders; export/validate are unaffected)`);
    lines.push(helpLines([`excalidraw-axi export ${pos[0]} --svg`, `excalidraw-axi pull pulled.excalidraw`]));
    process.stdout.write(lines.join("\n") + "\n");
    done(0);
  }
  process.stdout.write(
    [
      `error: sync unverified (canvas has ${Number.isFinite(got) ? got : "?"}, file has ${want})`,
      `(the tab may be showing a confirm dialog — accept it and re-run sync)`,
    ].join("\n") + "\n"
  );
  done(1);
}

/**
 * pull: read a scene back into a .excalidraw file — the round-trip half of
 * sync, so existing drawings (including human edits) can be edited by CLI.
 * Default source is the live tab at --url (elements+appState from
 * localStorage, image bytes from IDB files-store, both chunked).
 * --from-url fetches a scene file or #url= link instead (no browser needed).
 */
async function cmdPull(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "url", type: "string" },
      { name: "from-url", type: "string" },
    ],
    positional: 1,
  });
  if (opts.help) return printHelp("pull");
  if (!pos[0]) fail("pull requires <out.excalidraw>", 2, ["excalidraw-axi pull pulled.excalidraw"]);
  const out = resolve(pos[0]);

  if (opts["from-url"]) {
    let u = opts["from-url"];
    const hm = u.match(/#url=(.+)$/);
    if (hm) u = decodeURIComponent(hm[1]);
    if (!/^https?:\/\//i.test(u)) fail(`--from-url must be an http(s) URL or #url= link`, 2);
    let doc;
    try {
      const r = await fetch(u);
      if (!r.ok) fail(`fetch failed: ${u} -> HTTP ${r.status}`, 1);
      doc = await r.json();
    } catch (e) {
      if (e && e.message && e.message.startsWith("fetch failed")) throw e;
      fail(`cannot load scene from ${u} (${e.message})`, 1);
    }
    if (!doc || !Array.isArray(doc.elements)) fail(`not a scene (no elements[]) at ${u}`, 1);
    const scene = {
      type: "excalidraw",
      version: 2,
      source: `excalidraw-axi pull ${u}`,
      elements: doc.elements,
      appState: { viewBackgroundColor: (doc.appState && doc.appState.viewBackgroundColor) || "#ffffff" },
      files: doc.files || {},
    };
    writeFileSync(out, JSON.stringify(scene, null, 2) + "\n");
    const nFiles = Object.keys(scene.files).length;
    process.stdout.write(
      [`pulled: ${scene.elements.length} elements${nFiles ? ` (+${nFiles} files)` : ""} -> ${pos[0]}`, helpLines([`excalidraw-axi validate ${pos[0]}`, `excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
    );
    return;
  }

  const probe = runHelper(["--help"]);
  if (!probe.ok)
    fail("pull needs the chrome-devtools-axi browser helper on PATH (it reads the tab)", 1, [
      `excalidraw-axi pull ${pos[0]} --from-url <scene-url>   (no browser needed)`,
    ]);
  const viewer = opts.url || "http://localhost:5001";
  const step = (args, what) => {
    const r = runHelper(args);
    if (!r.ok) fail(`pull failed at ${what} (browser helper error)`, 1);
    return r.out;
  };
  step(["open", stripHash(viewer)], "open viewer");
  const metaJson = helperResult(
    step(
      ["eval", `() => JSON.stringify(function(){ var els = JSON.parse(localStorage.getItem("excalidraw") || "[]"); var ids = []; for (var i = 0; i < els.length; i++) if (els[i] && els[i].type === "image" && els[i].fileId) ids.push(els[i].fileId); return { n: els.length, fileIds: ids }; }())`],
      "read canvas"
    )
  );
  let meta = null;
  try {
    meta = JSON.parse(metaJson);
  } catch {}
  if (!meta || typeof meta.n !== "number") fail("pull failed (canvas unreadable — is the tab on an Excalidraw page?)", 1);
  const elements = [];
  const CHUNK = 100;
  for (let i = 0; i < meta.n; i += CHUNK) {
    const part = helperResult(
      step(["eval", `() => JSON.stringify((JSON.parse(localStorage.getItem("excalidraw") || "[]")).slice(${i}, ${i + CHUNK}))`], "read canvas")
    );
    if (typeof part !== "string") fail("pull failed (element payload unreadable)", 1);
    elements.push(...JSON.parse(part));
  }
  let bg = "#ffffff";
  try {
    const appJson = helperResult(step(["eval", `() => localStorage.getItem("excalidraw-state") || "{}"`], "read canvas"));
    const app = JSON.parse(appJson);
    if (app && app.viewBackgroundColor) bg = app.viewBackgroundColor;
  } catch {}
  const files = {};
  const unresolved = [];
  for (const fid of meta.fileIds || []) {
    const rec = idbGetFile(fid, step);
    if (rec && rec.dataURL) files[fid] = { mimeType: rec.mimeType, id: rec.id, dataURL: rec.dataURL, created: rec.created };
    else unresolved.push(fid);
  }
  const scene = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-axi pull",
    elements,
    appState: { viewBackgroundColor: bg },
    files,
  };
  writeFileSync(out, JSON.stringify(scene, null, 2) + "\n");
  const bits = [`pulled: ${elements.length} elements${Object.keys(files).length ? ` (+${Object.keys(files).length} files)` : ""} -> ${pos[0]}`];
  if (unresolved.length)
    bits.push(`(unresolved images: ${unresolved.length} fileIds have no bytes in tab storage — elements kept, re-add via image --file: ${unresolved.slice(0, 3).join(",")}${unresolved.length > 3 ? "…" : ""})`);
  bits.push(helpLines([`excalidraw-axi validate ${pos[0]}`, `excalidraw-axi view ${pos[0]}`]));
  process.stdout.write(bits.join("\n") + "\n");
}

function cmdExport(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "out", short: "o", type: "string" },
      { name: "svg", type: "boolean" },
      { name: "scale", type: "string" },
    ],
    positional: 1,
  });
  if (opts.help) return printHelp("export");
  if (!pos[0]) fail("export requires <file>", 2, ["excalidraw-axi export <file> --svg"]);
  loadScene(pos[0]); // fail fast with structured error if unreadable
  // Delegate rendering to the maintained community exporter (exact Excalidraw output).
  const args = [pos[0]];
  if (opts.svg) args.push("--svg");
  if (opts.out) args.push("-o", opts.out);
  if (opts.scale) args.push("--scale", opts.scale);
  const r = spawnSync("npx", ["-y", "@moona3k/excalidraw-export", ...args], {
    stdio: "inherit",
  });
  if (r.error)
    fail(`export backend failed to start: ${r.error.message}`, 1, [
      "npm install -g @moona3k/excalidraw-export",
    ]);
  if (r.status !== 0)
    fail(`export backend exited with code ${r.status}`, 1, [
      "excalidraw-axi validate <file>",
    ]);
}

function printHelp(topic) {
  const h = {
    top: [
      "excalidraw-axi — agent-ergonomic CLI for drawing in Excalidraw (v" + VERSION + ")",
      "",
      "Usage: excalidraw-axi <command> [options]",
      "",
      "Draw:",
      '  create --spec d.json -o s.excalidraw  Boxes+edges with auto-layout (row|column|grid)',
      "  create --mermaid-file f.mmd -o s.excalidraw  Flowchart/graph or sequenceDiagram",
      '  create -o s.excalidraw --title "T"  Blank title template',
      '  add <file> rectangle|ellipse|diamond --label "API" [--x N --y N --w N --h N]',
      '  add <file> text --text "Hi" [--x N --y N --font-size 20]',
      "  add <file> arrow|line --from <id> --to <id> [--label \"calls\"]",
      "  add <file> arrow --x1 N --y1 N --x2 N --y2 N | --points \"x1,y1 x2,y2 ...\"",
      '  add <file> freedraw --points "x1,y1 x2,y2 ..."',
      '  add <file> frame --label "F" | image --file a.png | embed --link <url>',
      "  style: --stroke #hex --background #hex --stroke-width N --stroke-style solid|dashed|dotted",
      "    --fill-style solid|hachure|cross-hatch|dots|zigzag --roundness sharp|round --angle N",
      "    --roughness 0..2 --opacity 0..100 --font-family 1..5 --text-align left|center|right",
      "    --locked --link <url> --frame <frame-id> --arrow-type sharp|round",
      "    heads: --start-arrowhead/--end-arrowhead none|arrow|triangle|triangle_outline|",
      "      diamond|diamond_outline|circle|circle_outline|bar; --elbow (2 endpoints)",
      "    --label binds inside the shape (human-edit safe); --unbound = overlay text",
      "",
      "Arrange:",
      "  move <file> <id...> --dx N --dy N | --x N --y N (single)",
      "  group <file> <id...> | ungroup <file> <group-id>",
      "  align <file> <id...> --left|--center|--right|--top|--middle|--bottom",
      "  distribute <file> <id...> --horizontal|--vertical",
      "  flip <file> <id...> --horizontal|--vertical",
      "  duplicate <file> <id...> [--dx N --dy N]",
      "  lock|unlock <file> <id...>",
      "  link <file> <id> --url <https://...> | --remove",
      "  order <file> <id...> --front|--back|--forward|--backward",
      "  delete <file> <id...>      Soft-delete (isDeleted)",
      "  clear <file>               Remove all elements",
      "",
      "Live instance:",
      "  serve <file> [--port N] [--url U]   Scene file over CORS localhost server",
      "  open <file> [--port N] [--url U] [--no-launch]  Serve + open #url= link",
      "  sync <file> [--port N] [--url U]    Serve + verify via browser helper",
      "  pull <out> [--url U]               Read the live tab back into a file",
      "  pull <out> --from-url <link|url>    Fetch a scene file (no browser)",
      "  lib push <lib> <scene> <id...> | lib list <lib> | lib unpack <lib> <item> <scene>",
      "",
      "Inspect / render:",
      "  list [dir]                 List scenes",
      "  view <file> [--full]       Summary (truncated unless --full)",
      "  get <file> <id> [--full]   One element as JSON",
      "  validate <file>            Schema + integrity check (exit 1 if invalid)",
      "  export <file> [--svg] [-o out] [--scale N]",
      "",
      "Global: --help, --version. Unknown flags fail loud (exit 2).",
      "Notes: move drags arrows bound on every end to the moved set; partially",
      "  bound arrows are reported left-behind. Embeds render inline only for",
      "  allowlisted hosts (youtube/vimeo/codesandbox/...). No sticky/laser/AI ops.",
    ].join("\n"),
    list: "Usage: excalidraw-axi list [dir]\n\nList .excalidraw scenes with live element counts.",
    view: "Usage: excalidraw-axi view <file> [--full]\n\nShow version, element counts by type, and first 15 elements (id,type,x,y,w,h,text). Long text truncated unless --full.",
    get: "Usage: excalidraw-axi get <file> <id> [--full]\n\nPrint one element as JSON (truncated at 2000 chars unless --full).",
    validate:
      "Usage: excalidraw-axi validate <file>\n\nSchema + integrity: required fields, unique ids, known types, numeric geometry, points/pressures, live bindings/fileIds/frameIds. Prints valid: true/false, exit 1 on invalid.",
    create: [
      "Usage:",
      '  excalidraw-axi create --spec diagram.json -o s.excalidraw',
      "  excalidraw-axi create --mermaid-file flow.mmd -o s.excalidraw",
      '  excalidraw-axi create -o s.excalidraw --title "T"',
      "",
      "spec JSON: {layout: row|column|grid,",
      '  nodes: [{id?, label, shape?: rectangle|ellipse|diamond|text, w?, h?, stroke?, background?}],',
      '  edges: [{from, to, label?}]}',
      "mermaid: flowchart/graph subset — TD,TB,LR,RL,BT; [box], (rounded),",
      "  {decision}->diamond, ((circle))->ellipse; -->/---/==>/--o/--x/-.-> edges,",
      "  |labels| and A-->B-->C chains. sequenceDiagram subset — participant/actor,",
      "  ->/->>/-->/-->>/-x/--x messages, Note over/left of/right of. Other diagram",
      "  types fail with a clear error.",
    ].join("\n"),
    add: [
      "Usage:",
      '  excalidraw-axi add <file> rectangle|ellipse|diamond [--x N --y N] [--w N --h N]',
      '    [--stroke #hex] [--background #hex|transparent] [--label "T"]',
      '  excalidraw-axi add <file> text --text "Hi" [--font-size 20 --font-family 2 --text-align center]',
      '  excalidraw-axi add <file> arrow|line --from <id> --to <id> [--label "calls"]',
      "  excalidraw-axi add <file> arrow --x1 N --y1 N --x2 N --y2 N [--label T]",
      '  excalidraw-axi add <file> arrow|line --points "x1,y1 x2,y2 x3,y3" (polyline)',
      '  excalidraw-axi add <file> freedraw --points "x1,y1 x2,y2 ..." [--pressures "0.5 0.8 ..."]',
      '  excalidraw-axi add <file> frame --label "F" [--x N --y N --w N --h N]',
      "  excalidraw-axi add <file> image --file a.png [--x N --y N --w N --h N]",
      "  excalidraw-axi add <file> embed --link <https://...> [--x N --y N --w N --h N]",
      "",
      "Style flags: --stroke --background/--bg --stroke-width --stroke-style",
      "  --fill-style --roundness sharp|round --angle --roughness 0..2 --opacity 0..100",
      "  --font-family 1..5 --text-align --locked --link <url> --frame <frame-id>",
      "  --arrow-type sharp|round (arrows). stroke-style/fill-style/roundness apply",
      "  to shapes+edges (text keeps stroke/font/align/link/lock only).",
      "  heads: --start-arrowhead/--end-arrowhead (arrow kind only), --elbow (2 pts).",
      "",
      "No --x/--y: auto-places below existing content. --from/--to binds the arrow",
      "to both shapes (recorded in boundElements). --label binds inside the shape",
      "(containerId + boundElements: moves/resizes with it, human-edit safe);",
      "--unbound keeps the legacy overlay text. Edge labels stay midpoint text.",
      "image keeps aspect (explicit side wins, else intrinsic ≤1000px) and embeds",
      "the raster as dataURL in files[]. embed renders inline only on",
      "allowlisted hosts. No sticky type in OSS Excalidraw — use rectangle+text.",
    ].join("\n"),
    move: "Usage: excalidraw-axi move <file> <id...> --dx N --dy N | (--x N --y N for one element)\n\nArrows bound on every end to the moved set follow, as do bound labels; partially-bound arrows are reported left-behind.",
    group: "Usage: excalidraw-axi group <file> <id...>\n\nAssign a shared groupId (appended; prints it for ungroup).",
    ungroup: "Usage: excalidraw-axi ungroup <file> <group-id>\n\nRemove the group id from every element that has it.",
    align:
      "Usage: excalidraw-axi align <file> <id...> --left|--center|--right|--top|--middle|--bottom\n\nAlign 2+ elements to the selection bbox.",
    distribute:
      "Usage: excalidraw-axi distribute <file> <id...> --horizontal|--vertical\n\nEven gaps between 3+ non-overlapping elements.",
    flip:
      "Usage: excalidraw-axi flip <file> <id...> --horizontal|--vertical\n\nMirror geometry about the selection center (text keeps its angle).",
    duplicate:
      "Usage: excalidraw-axi duplicate <file> <id...> [--dx N --dy N]\n\nClone with fresh ids (default offset 20,20); bindings remapped inside the set.",
    lock: "Usage: excalidraw-axi lock <file> <id...>\n\nSet locked=true.",
    unlock: "Usage: excalidraw-axi unlock <file> <id...>\n\nSet locked=false.",
    link: "Usage: excalidraw-axi link <file> <id> --url <https://...> | --remove\n\nSet or clear the hyperlink.",
    order:
      "Usage: excalidraw-axi order <file> <id...> --front|--back|--forward|--backward\n\nReorder z (elements array; front = drawn last = on top).",
    serve:
      "Usage: excalidraw-axi serve <file> [--port 5237] [--url http://localhost:5001]\n\nServe the scene with CORS headers; paste the printed open: #url= link into a running tab.",
    open:
      "Usage: excalidraw-axi open <file> [--port 5237] [--url U] [--no-launch]\n\nServe + launch the #url= link in a browser. Serves until Ctrl+C.",
    sync:
      "Usage: excalidraw-axi sync <file> [--port 5237] [--url U]\n\nServe + load via the chrome-devtools-axi helper and verify element count. Image files are pre-seeded into tab storage. Exits 0 on match.",
    pull:
      "Usage: excalidraw-axi pull <out.excalidraw> [--url U] | --from-url <link|url>\n\nRead a scene back: live tab (elements+appState+images, chunked) or fetch a scene file / #url= link (no browser). Unresolvable images are kept as elements and reported.",
    lib: [
      "Usage:",
      "  excalidraw-axi lib push <lib.excalidrawlib> <scene> <id...> [--name T]",
      "  excalidraw-axi lib list <lib.excalidrawlib>",
      "  excalidraw-axi lib unpack <lib.excalidrawlib> <item-id> <scene> [--dx N --dy N]",
      "",
      "Push stores live elements as a library item (creates the lib file).",
      "Unpack clones the item into a scene with fresh ids (bindings remapped).",
    ].join("\n"),
    delete:
      "Usage: excalidraw-axi delete <file> <id...>\n\nSoft-delete (sets isDeleted, Excalidraw convention).",
    clear: "Usage: excalidraw-axi clear <file>\n\nRemove all elements (keeps appState).",
    export:
      "Usage: excalidraw-axi export <file> [--svg] [-o out] [--scale N]\n\nRender via npx @moona3k/excalidraw-export (installed on demand).",
  };
  process.stdout.write((h[topic] || h.top) + "\n");
}

// ---------- entry ----------
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version")) {
    process.stdout.write(`excalidraw-axi ${VERSION}\n`);
    return;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    if (!cmd) return cmdHome();
    return printHelp("top");
  }
  switch (cmd) {
    case "list":
      return cmdList(rest);
    case "view":
      return cmdView(rest);
    case "get":
      return cmdGet(rest);
    case "validate":
      return cmdValidate(rest);
    case "create":
      return cmdCreate(rest);
    case "add":
      return cmdAdd(rest);
    case "move":
      return cmdMove(rest);
    case "group":
      return cmdGroup(rest);
    case "ungroup":
      return cmdUngroup(rest);
    case "align":
      return cmdAlign(rest);
    case "distribute":
      return cmdDistribute(rest);
    case "flip":
      return cmdFlip(rest);
    case "duplicate":
      return cmdDuplicate(rest);
    case "lock":
      return cmdLock(rest, true);
    case "unlock":
      return cmdLock(rest, false);
    case "link":
      return cmdLink(rest);
    case "order":
      return cmdOrder(rest);
    case "serve":
      return cmdServe(rest);
    case "open":
      return cmdOpen(rest);
    case "sync":
      return cmdSync(rest);
    case "pull":
      return cmdPull(rest);
    case "lib":
      return cmdLib(rest);
    case "delete":
      return cmdDelete(rest);
    case "clear":
      return cmdClear(rest);
    case "export":
      return cmdExport(rest);
    default:
      fail(`Unknown command: ${cmd}`, 2, ["excalidraw-axi --help"]);
  }
}

main();
