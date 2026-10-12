#!/usr/bin/env node
/**
 * excalidraw-axi — agent-ergonomic CLI for Excalidraw diagrams.
 * File-first .excalidraw operations with token-efficient (TOON-style) output.
 * Zero runtime dependencies. Node >= 18.
 *
 * AXI principles applied: token-efficient output, minimal default schemas,
 * content truncation (+ --full), pre-computed aggregates, definitive empty
 * states, structured errors & exit codes, content-first home view,
 * contextual help[] next steps, consistent --help.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const VERSION = "0.1.0";
const TRUNCATE_AT = 200;

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

function truncate(s, full) {
  if (full || s.length <= TRUNCATE_AT) return s;
  return s.slice(0, TRUNCATE_AT) + `… (truncated, ${s.length} chars total — use --full)`;
}

// ---------- scene helpers ----------
function nid() {
  return randomBytes(8).toString("hex");
}

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
    ...overrides,
  };
}

function makeScene(title) {
  const now = Date.now();
  const t = baseElement({
    id: nid(),
    type: "text",
    x: 100,
    y: 80,
    width: Math.max(100, title.length * 12),
    height: 30,
    fontSize: 20,
    fontFamily: 1,
    text: title,
    textAlign: "left",
    verticalAlign: "top",
    autoResize: true,
    baseline: 24,
    lineHeight: 1.25,
    updated: now,
  });
  const r = baseElement({
    id: nid(),
    type: "rectangle",
    x: 100,
    y: 140,
    width: 400,
    height: 220,
    updated: now,
  });
  return {
    type: "excalidraw",
    version: 2,
    source: "https://github.com/nahidupa/excalidraw-axi",
    elements: [t, r],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
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
  return { abs, doc, raw };
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
    if (a.startsWith("-") && a.length > 1) {
      // short flags: -o <val>, -h
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
  if (pos.length > positional && positional !== Infinity)
    fail(`Too many arguments: expected ${positional}, got ${pos.length}`, 2, [
      "excalidraw-axi --help",
    ]);
  return { pos, opts: out };
}

// ---------- commands ----------
function cmdHome() {
  const cwd = process.cwd();
  const scenes = findScenes(cwd);
  const out = [];
  out.push(`bin: ${shortBin()}`);
  out.push(`description: Agent-ergonomic CLI for Excalidraw .excalidraw scenes`);
  out.push(`count: ${scenes.length} scenes in ${cwd}`);
  if (scenes.length) {
    out.push(
      `scenes[${scenes.length}]{file}:`,
      ...scenes.slice(0, 20).map((s) => `  ${basename(s)}`)
    );
    if (scenes.length > 20)
      out.push(`  … (${scenes.length - 20} more — use \`excalidraw-axi list\`)`);
  } else {
    out.push(`(no .excalidraw files here — create one or point list at a directory)`);
  }
  out.push(
    helpLines([
      "excalidraw-axi list [dir]",
      "excalidraw-axi view <file>",
      "excalidraw-axi validate <file>",
      "excalidraw-axi create -o scene.excalidraw --title \"My diagram\"",
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
    out.push(helpLines(["excalidraw-axi create -o scene.excalidraw --title \"My diagram\""]));
    process.stdout.write(out.join("\n") + "\n");
    return;
  }
  out.push(`scenes[${scenes.length}]{file,elements,bytes}:`);
  for (const s of scenes) {
    let elements = "?";
    try {
      const doc = JSON.parse(readFileSync(s, "utf8"));
      elements = Array.isArray(doc.elements) ? doc.elements.length : "?";
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
  const elements = Array.isArray(doc.elements) ? doc.elements : [];
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
      out.push(`  … (${elements.length - shown.length} more — use --full with export)`);
  } else {
    out.push(`(empty scene — 0 elements)`);
  }
  out.push(
    helpLines(["excalidraw-axi validate <file>", "excalidraw-axi export <file> --svg"])
  );
  process.stdout.write(out.join("\n") + "\n");
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
    doc.elements.forEach((el, i) => {
      if (!el || typeof el !== "object") return problems.push(`elements[${i}] not an object`);
      for (const k of ["id", "type", "x", "y"])
        if (el[k] === undefined) problems.push(`elements[${i}] missing ${k}`);
    });
  }
  if (problems.length) {
    process.stdout.write(
      [`valid: false`, `problems[${problems.length}]:`, ...problems.map((p) => `  ${p}`)].join("\n") + "\n"
    );
    process.exit(1);
  }
  process.stdout.write(
    [
      `valid: true`,
      `elements: ${doc.elements.length}`,
      helpLines(["excalidraw-axi view <file>", "excalidraw-axi export <file> --svg"]),
    ].join("\n") + "\n"
  );
}

function cmdCreate(rawArgs) {
  const { pos, opts } = parseArgs(rawArgs, {
    flags: [
      { name: "out", short: "o", type: "string" },
      { name: "title", type: "string" },
      { name: "text", type: "string" },
      { name: "mermaid-file", type: "string" },
    ],
    positional: 0,
  });
  if (opts.help) return printHelp("create");
  if (!opts.out) fail("create requires -o <out.excalidraw>", 2, ["excalidraw-axi create -o scene.excalidraw --title \"My diagram\""]);
  let title = opts.title || opts.text || "Untitled diagram";
  if (opts["mermaid-file"]) {
    // Honest v0.1 behavior: embed mermaid source as a text element (no silent fake layout).
    // Full mermaid -> elements auto-layout is on the roadmap (needs browser DOM libs).
    const mf = resolve(opts["mermaid-file"]);
    if (!existsSync(mf)) fail(`mermaid file not found: ${opts["mermaid-file"]}`, 1);
    const src = readFileSync(mf, "utf8");
    title = src.length > 500 ? src.slice(0, 500) + "… (see full source in notes)" : src;
    title = `mermaid:\n${title}`;
  }
  const scene = makeScene(title);
  const abs = resolve(opts.out);
  writeFileSync(abs, JSON.stringify(scene, null, 2) + "\n");
  process.stdout.write(
    [
      `created: ${opts.out}`,
      `elements: ${scene.elements.length}`,
      helpLines([`excalidraw-axi view ${opts.out}`, `excalidraw-axi export ${opts.out} --svg`]),
    ].join("\n") + "\n"
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
      "excalidraw-axi — agent-ergonomic CLI for Excalidraw scenes (v" + VERSION + ")",
      "",
      "Usage: excalidraw-axi <command> [options]",
      "",
      "Commands:",
      "  (no args)                 Home view: scenes in cwd + next steps",
      "  list [dir]                List .excalidraw scenes",
      "  view <file> [--full]      Scene summary (truncated unless --full)",
      "  validate <file>           Schema check (exit 1 if invalid)",
      "  create -o out --title T   New scene (or --mermaid-file f.mmd to embed source)",
      "  export <file> [--svg] [-o out] [--scale N]  Render via community exporter",
      "",
      "Global: --help, --version. Unknown flags fail loud (exit 2).",
    ].join("\n"),
    list: "Usage: excalidraw-axi list [dir]\n\nList .excalidraw scenes with element counts.",
    view: "Usage: excalidraw-axi view <file> [--full]\n\nShow version, element counts by type, and first 15 elements. Long text truncated unless --full.",
    validate:
      "Usage: excalidraw-axi validate <file>\n\nCheck type/elements/required fields. Prints valid: true/false, exit 1 on invalid.",
    create:
      'Usage: excalidraw-axi create -o scene.excalidraw [--title "T"] [--text "T"] [--mermaid-file f.mmd]\n\nWrite a valid v2 scene. --mermaid-file embeds source as text (auto-layout roadmap).',
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
    case "validate":
      return cmdValidate(rest);
    case "create":
      return cmdCreate(rest);
    case "export":
      return cmdExport(rest);
    default:
      fail(`Unknown command: ${cmd}`, 2, ["excalidraw-axi --help"]);
  }
}

main();
