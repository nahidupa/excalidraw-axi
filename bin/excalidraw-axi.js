#!/usr/bin/env node
/**
 * excalidraw-axi — agent-ergonomic CLI for Excalidraw diagrams.
 * File-first .excalidraw operations with token-efficient (TOON-style) output.
 * Zero runtime dependencies. Node >= 18.
 *
 * v0.2: self-sufficient drawing — add/move/delete/get/clear element ops,
 * spec-driven create with auto-layout, real Mermaid flowchart conversion.
 *
 * AXI principles: token-efficient output, minimal default schemas, content
 * truncation (+ --full), pre-computed aggregates, definitive empty states,
 * structured errors & exit codes, content-first home view, contextual help[].
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const VERSION = "0.2.0";
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

function makeText({ x, y, text, fontSize = 20, strokeColor = "#1e1e1e" }) {
  const { width, height } = measureText(text, fontSize);
  return baseElement({
    id: nid(),
    type: "text",
    x,
    y,
    width,
    height,
    fontSize,
    fontFamily: 1,
    text,
    textAlign: "left",
    verticalAlign: "top",
    autoResize: true,
    baseline: Math.round(height * 0.8),
    lineHeight: 1.25,
    containerId: null,
    originalText: text,
    strokeColor,
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
    roughness: o.roughness ?? 1,
    opacity: o.opacity ?? 100,
    roundness: { type: kind === "rectangle" ? 3 : 2 },
  });
}

/** Arrow/line between two absolute points; bindings optional element ids. */
function makeEdge({ x1, y1, x2, y2, kind = "arrow", from = null, to = null, label = null }) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const points = [
    [x1 - x, y1 - y],
    [x2 - x, y2 - y],
  ];
  const edge = baseElement({
    id: nid(),
    type: kind,
    x,
    y,
    width: Math.max(1, Math.abs(x2 - x1)),
    height: Math.max(1, Math.abs(y2 - y1)),
    points,
    lastCommittedPoint: points[points.length - 1],
    startBinding: from ? { elementId: from, focus: 0, gap: 8 } : null,
    endBinding: to ? { elementId: to, focus: 0, gap: 8 } : null,
    startArrowhead: null,
    endArrowhead: kind === "arrow" ? "arrow" : null,
  });
  const extra = [];
  if (label) {
    const t = makeText({
      x: (x1 + x2) / 2 - 40,
      y: (y1 + y2) / 2 - 30,
      text: label,
      fontSize: 16,
    });
    extra.push(t);
  }
  return { edge, extra };
}

/** Centered label text on top of a shape (unbound). Returns text element. */
function shapeLabel(shape, label, fontSize = 20) {
  const { width, height } = measureText(label, fontSize);
  return makeText({
    x: Math.round(shape.x + (shape.width - width) / 2),
    y: Math.round(shape.y + (shape.height - height) / 2),
    text: label,
    fontSize,
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
      `unsupported mermaid type ${JSON.stringify(lines[0].split(/\s+/)[0])} — v0.2 converts flowchart/graph (TD,TB,LR,RL,BT) only`,
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
      background: "#e3f2fd",
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
    liveElements(doc).forEach((el) => {
      if (!el || typeof el !== "object") return problems.push(`element not an object`);
      for (const k of ["id", "type", "x", "y"])
        if (el[k] === undefined) problems.push(`${el.id || "?"} missing ${k}`);
    });
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
        const shape = makeShape(n.shape, { x: p.x, y: p.y, w: n._w, h: n._h, background: "#e3f2fd" });
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
    const { direction, nodes, edges } = parseMermaidFlowchart(readFileSync(mf, "utf8"));
    const orientation =
      direction === "LR" ? "horizontal" : direction === "RL" ? "horizontal-rev" : direction === "BT" ? "vertical-rev" : "vertical";
    scene = buildSceneFromGraph(nodes, edges, orientation);
    note = `mermaid ${direction}: ${nodes.size} nodes, ${edges.length} edges`;
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
  { name: "roughness", type: "string" },
  { name: "opacity", type: "string" },
  { name: "text", type: "string" },
  { name: "font-size", type: "string" },
  { name: "label", type: "string" },
  { name: "from", type: "string" },
  { name: "to", type: "string" },
  { name: "x1", type: "string" },
  { name: "y1", type: "string" },
  { name: "x2", type: "string" },
  { name: "y2", type: "string" },
  { name: "points", type: "string" },
  { name: "file", short: "f", type: "string" },
];

function cmdAdd(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, { flags: ADD_FLAGS, positional: 2 });
  if (opts.help) return printHelp("add");
  const [file, kindRaw] = pos;
  if (!file || !kindRaw)
    fail("add requires <file> <type>", 2, ['excalidraw-axi add <file> rectangle --label "API"']);
  const kind = kindRaw.toLowerCase();
  if (!["rectangle", "ellipse", "diamond", "text", "arrow", "line"].includes(kind))
    fail(`unknown shape ${JSON.stringify(kindRaw)} — rectangle|ellipse|diamond|text|arrow|line`, 2);
  const { doc, abs } = loadScene(file);
  const style = {
    stroke: opts.stroke ? color(opts.stroke, "stroke") : undefined,
    background: color(opts.background ?? opts.bg ?? "transparent", "background"),
    strokeWidth: opts["stroke-width"] ? num(opts["stroke-width"], "stroke-width") : undefined,
    roughness: opts.roughness ? num(opts.roughness, "roughness") : undefined,
    opacity: opts.opacity ? num(opts.opacity, "opacity") : undefined,
  };
  const added = [];
  if (kind === "arrow" || kind === "line") {
    let x1, y1, x2, y2, from = null, to = null;
    if (opts.from || opts.to) {
      if (!opts.from || !opts.to)
        fail("arrow binding needs both --from <id> and --to <id>", 2);
      const a = findElement(doc, opts.from);
      const b = findElement(doc, opts.to);
      from = a.id;
      to = b.id;
      [x1, y1] = [a.x + a.width / 2, a.y + a.height / 2];
      [x2, y2] = [b.x + b.width / 2, b.y + b.height / 2];
    } else if (opts.points) {
      const pts = opts.points.trim().split(/[\s;]+/).map((p) => {
        const m = p.split(",").map(Number);
        if (m.length !== 2 || !m.every(Number.isFinite))
          fail(`--points must be "x1,y1 x2,y2", got ${JSON.stringify(opts.points)}`, 2);
        return m;
      });
      if (pts.length < 2) fail(`--points needs at least 2 points`, 2);
      [x1, y1] = pts[0];
      [x2, y2] = pts[pts.length - 1];
    } else if (opts.x1 !== undefined || opts.y1 !== undefined || opts.x2 !== undefined || opts.y2 !== undefined) {
      if ([opts.x1, opts.y1, opts.x2, opts.y2].some((v) => v === undefined))
        fail("explicit arrow needs all of --x1 --y1 --x2 --y2", 2);
      x1 = num(opts.x1, "x1");
      y1 = num(opts.y1, "y1");
      x2 = num(opts.x2, "x2");
      y2 = num(opts.y2, "y2");
    } else {
      fail("arrow needs --from/--to, --points, or --x1/--y1/--x2/--y2", 2, [
        "excalidraw-axi view <file>",
      ]);
    }
    const { edge, extra } = makeEdge({ x1, y1, x2, y2, kind, from, to, label: opts.label || null });
    doc.elements.push(edge, ...extra);
    added.push(edge, ...extra);
    if (from) findElement(doc, from).boundElements.push({ type: "arrow", id: edge.id });
    if (to) findElement(doc, to).boundElements.push({ type: "arrow", id: edge.id });
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
          })
        : makeShape(kind, {
            x,
            y,
            w: w !== undefined ? num(w, "w") : undefined,
            h: h !== undefined ? num(h, "h") : undefined,
            ...style,
          });
    doc.elements.push(el);
    added.push(el);
    if (opts.label && kind !== "text") {
      const t = shapeLabel(el, opts.label, 18);
      doc.elements.push(t);
      added.push(t);
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

function cmdMove(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "x", type: "string" },
      { name: "y", type: "string" },
      { name: "dx", type: "string" },
      { name: "dy", type: "string" },
    ],
    positional: 2,
  });
  if (opts.help) return printHelp("move");
  if (pos.length < 2) fail("move requires <file> <id>", 2, ["excalidraw-axi move <file> <id> --dx 0 --dy 60"]);
  const { doc, abs } = loadScene(pos[0]);
  const el = findElement(doc, pos[1]);
  if (opts.x !== undefined) el.x = num(opts.x, "x");
  if (opts.y !== undefined) el.y = num(opts.y, "y");
  if (opts.dx !== undefined) el.x += num(opts.dx, "dx");
  if (opts.dy !== undefined) el.y += num(opts.dy, "dy");
  el.updated = Date.now();
  saveScene(abs, doc);
  process.stdout.write(
    [`moved: ${el.id} -> x=${el.x}, y=${el.y}`, `(attached arrows do not follow — re-add them if needed)`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
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
  saveScene(abs, doc);
  process.stdout.write(
    [`deleted: ${n}`, helpLines([`excalidraw-axi view ${pos[0]}`])].join("\n") + "\n"
  );
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
      "  create --mermaid-file f.mmd -o s.excalidraw  Flowchart/graph (TD,TB,LR,RL,BT)",
      '  create -o s.excalidraw --title "T"  Blank title template',
      '  add <file> rectangle|ellipse|diamond --label "API" [--x N --y N --w N --h N]',
      '  add <file> text --text "Hi" [--x N --y N --font-size 20]',
      "  add <file> arrow|line --from <id> --to <id> [--label \"calls\"]",
      "  add <file> arrow --x1 N --y1 N --x2 N --y2 N | --points \"x1,y1 x2,y2\"",
      "",
      "Inspect / edit:",
      "  list [dir]                 List scenes",
      "  view <file> [--full]       Summary (truncated unless --full)",
      "  get <file> <id> [--full]   One element as JSON",
      "  validate <file>            Schema check (exit 1 if invalid)",
      "  move <file> <id> --x N --y N | --dx N --dy N",
      "  delete <file> <id...>      Soft-delete (isDeleted)",
      "  clear <file>               Remove all elements",
      "  export <file> [--svg] [-o out] [--scale N]",
      "",
      "Global: --help, --version. Unknown flags fail loud (exit 2).",
      "Note: move does not drag attached arrows — re-add them if needed.",
    ].join("\n"),
    list: "Usage: excalidraw-axi list [dir]\n\nList .excalidraw scenes with live element counts.",
    view: "Usage: excalidraw-axi view <file> [--full]\n\nShow version, element counts by type, and first 15 elements (id,type,x,y,w,h,text). Long text truncated unless --full.",
    get: "Usage: excalidraw-axi get <file> <id> [--full]\n\nPrint one element as JSON (truncated at 2000 chars unless --full).",
    validate:
      "Usage: excalidraw-axi validate <file>\n\nCheck type/elements/required fields. Prints valid: true/false, exit 1 on invalid.",
    create: [
      "Usage:",
      '  excalidraw-axi create --spec diagram.json -o s.excalidraw',
      "  excalidraw-axi create --mermaid-file flow.mmd -o s.excalidraw",
      '  excalidraw-axi create -o s.excalidraw --title "T"',
      "",
      "spec JSON: {layout: row|column|grid,",
      '  nodes: [{id?, label, shape?: rectangle|ellipse|diamond|text, w?, h?}],',
      '  edges: [{from, to, label?}]}',
      "mermaid: flowchart/graph subset — TD,TB,LR,RL,BT; [box], (rounded),",
      "  {decision}->diamond, ((circle))->ellipse; -->/---/==>/--o/--x/-.-> edges,",
      "  |labels| and A-->B-->C chains. Other diagram types fail with a clear error.",
    ].join("\n"),
    add: [
      "Usage:",
      '  excalidraw-axi add <file> rectangle|ellipse|diamond [--x N --y N] [--w N --h N]',
      '    [--stroke #hex] [--background #hex|transparent] [--label "T"]',
      '  excalidraw-axi add <file> text --text "Hi" [--x N --y N --font-size 20]',
      '  excalidraw-axi add <file> arrow|line --from <id> --to <id> [--label "calls"]',
      "  excalidraw-axi add <file> arrow --x1 N --y1 N --x2 N --y2 N [--label T]",
      '  excalidraw-axi add <file> arrow --points "x1,y1 x2,y2"',
      "",
      "No --x/--y: auto-places below existing content. --from/--to binds the arrow",
      "to both shapes (recorded in boundElements). Labels are midpoint/unbound text.",
    ].join("\n"),
    move: "Usage: excalidraw-axi move <file> <id> --x N --y N | --dx N --dy N\n\nAttached arrows do not follow — re-add them if needed.",
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
