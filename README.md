# excalidraw-axi

Agent-ergonomic CLI for **drawing in Excalidraw**. File-first `.excalidraw` operations with token-efficient output, following [AXI](https://axi.md/) principles.

> No `excalidraw-axi` existed in the [AXI catalog](https://axi.md/) — this is the first.

## Install

```sh
npm install -g github:nahidupa/excalidraw-axi
# or run without installing:
npx github:nahidupa/excalidraw-axi --help
```

Requires Node >= 18. Zero runtime dependencies. The `export` command fetches `@moona3k/excalidraw-export` on demand via `npx`.

## Draw

Three paths, fastest first:

```sh
# 1. Spec -> diagram with auto-layout (best for agents: no coordinates)
excalidraw-axi create --spec diagram.json -o arch.excalidraw

# 2. Mermaid flowchart -> diagram (TD,TB,LR,RL,BT subset)
excalidraw-axi create --mermaid-file flow.mmd -o flow.excalidraw

# 3. Shape by shape (explicit geometry or auto-place below content)
excalidraw-axi add arch.excalidraw rectangle --label "API"
excalidraw-axi add arch.excalidraw text --text "notes" --x 100 --y 600
excalidraw-axi add arch.excalidraw arrow --from <id-a> --to <id-b> --label "calls"
excalidraw-axi add arch.excalidraw freedraw --points "10,10 60,40 120,40"
excalidraw-axi add arch.excalidraw frame --label "F"   # image --file a.png | embed --link <url>
```

Style flags for `add`: `--stroke #hex --background #hex --stroke-width N --stroke-style solid|dashed|dotted --fill-style solid|hachure|cross-hatch|dots|zigzag --roundness sharp|round --angle N --roughness 0..2 --opacity 0..100 --font-family 1..5 --text-align left|center|right --locked --link <url> --frame <frame-id> --arrow-type sharp|round` (arrows). Text keeps stroke/font/align/link/lock only.

Arrowheads (arrow kind only): `--start-arrowhead/--end-arrowhead none|arrow|triangle|triangle_outline|diamond|diamond_outline|circle|circle_outline|bar`. `--elbow` routes a 2-endpoint arrow orthogonally (the app stores elbow corners explicitly — there is no auto-route on load, so the CLI computes the corner).

Labels: `--label` binds the text **inside** the shape (`containerId` + `boundElements`) — it moves/resizes with the container and survives human edits. `--unbound` keeps the legacy overlay text. Edge labels stay midpoint text (arrows are not containers). `move`/`align`/`distribute`/`flip` drag bound labels along; `delete` repairs references; `duplicate` remaps them.

Images: `--file` embeds the raster as dataURL in `files[]` (png|jpg|jpeg|webp|gif). Aspect is preserved — an explicit `--w` or `--h` scales the other side, otherwise intrinsic size (capped at 1000px). Identical bytes share one `files[]` entry. Live-tab note: this app build resolves images on `#url=` load only for single-image scenes; with 2+ images the tab may show placeholders (export/`validate` are unaffected — `sync` warns).

Spec format (`diagram.json`):

```json
{
  "layout": "row",
  "nodes": [
    { "id": "user", "label": "User", "shape": "ellipse" },
    { "id": "api", "label": "API server" },
    { "id": "db", "label": "Postgres?", "shape": "diamond" }
  ],
  "edges": [
    { "from": "user", "to": "api", "label": "HTTPS" },
    { "from": "api", "to": "db", "label": "queries" }
  ]
}
```

* `layout`: `row` (flow right) | `column` (flow down) | `grid`
* `shape`: `rectangle` (default) | `ellipse` | `diamond` | `text`
* Nodes accept optional `w`, `h`, `stroke`, `background`.
* `id` optional — slugified from label when omitted.

Mermaid subset: `graph`/`flowchart` with `TD,TB,LR,RL,BT`; `[box]`, `(rounded)`, `{decision}`→diamond, `((circle))`→ellipse; `-->`, `---`, `==>`, `--o`, `--x`, `-.->` edges; `|labels|`; `A-->B-->C` chains. `sequenceDiagram` subset: `participant`/`actor`, `->/->>/-->/-->>/-x/--x` (`--` dashed), `Note over|left of|right of`. Other diagram types (class, state, …) fail with a clear error instead of a wrong drawing.

## Inspect / edit / render

```sh
excalidraw-axi list [dir]                # scenes with live element counts
excalidraw-axi view <file> [--full]      # version, byType counts, first 15 elements
excalidraw-axi get <file> <id> [--full]  # one element as JSON
excalidraw-axi validate <file>           # schema + integrity check (exit 1 if invalid)
excalidraw-axi move <file> <id...> --dx 0 --dy 60
excalidraw-axi group <file> <a> <b> | ungroup <file> <gid>
excalidraw-axi align <file> <a> <b> --top | distribute <file> <a> <b> <c> --horizontal
excalidraw-axi flip <file> <a> --horizontal | duplicate <file> <a> [--dx N --dy N]
excalidraw-axi lock|unlock <file> <a> | link <file> <a> --url <u>|--remove
excalidraw-axi order <file> <a> --front|--back|--forward|--backward
excalidraw-axi delete <file> <id...>     # soft-delete (isDeleted)
excalidraw-axi clear <file>              # remove all elements
excalidraw-axi export <file> --svg [-o out] [--scale N]
```

## Live instance (local Docker, excalidraw.com, …)

The app loads external scenes via `#url=<scene-file-url>`. The CLI serves the file with CORS headers so a running tab can fetch it:

```sh
excalidraw-axi serve <file> [--port 5237] [--url http://localhost:5001]
# → prints an `open:` link; paste it into your running tab (confirm replace if asked)

excalidraw-axi open <file> [--url U] [--no-launch]  # serve + launch the link in a browser
excalidraw-axi sync <file> [--url U]                # serve + verify load via chrome-devtools-axi
```

`serve`/`open` run until Ctrl+C (the server re-reads the file per request, so edit → reload works). `sync` exits 0 after verifying the canvas element count matches the file, 1 otherwise. `sync` needs the `chrome-devtools-axi` helper on PATH; without it, use `open`. `sync` pre-seeds image bytes into tab storage (the `#url=` loader ignores `scene.files`).

## Read back (pull) and libraries

```sh
excalidraw-axi pull live.excalidraw [--url http://localhost:5001]
# read the live tab back: elements+appState from storage, image bytes from
# tab storage (chunked). Unresolvable images are kept as elements + reported.
excalidraw-axi pull live.excalidraw --from-url <scene-url|#url=-link>
# fetch a scene file without a browser
excalidraw-axi lib push shapes.lib scene.excalidraw <id...> [--name T]
excalidraw-axi lib list shapes.lib
excalidraw-axi lib unpack shapes.lib <item-id> scene.excalidraw [--dx N --dy N]
```

Round-trip an existing drawing: `pull` → `add`/`move`/… → `validate` → `sync`. (Live-tab selection is not readable — the app doesn't persist it — so `pull` grabs the whole canvas.)

Example session:

```sh
$ excalidraw-axi create --spec diagram.json -o arch.excalidraw
created: arch.excalidraw
elements: 9
layout: spec: 3 nodes, 2 edges (row)
help[2]:
  Run `excalidraw-axi view arch.excalidraw`
  Run `excalidraw-axi export arch.excalidraw --svg`
```

Notes:

* `add` without `--x/--y` auto-places below existing content.
* `--from/--to` arrows bind to both shapes (recorded in `boundElements`).
* Edge/shape labels are midpoint text elements (unbound).
* `move` drags arrows bound on every end to the moved set, plus bound labels; partially-bound arrows are reported left-behind (re-add those).
* `image` embeds the raster as a dataURL in `files[]` (png|jpg|jpeg|webp|gif).
* `embed` stores the URL in `link`; the app renders inline only allowlisted hosts (youtube/vimeo/codesandbox/…) — elsewhere it shows as a link.
* No sticky type exists in OSS Excalidraw — use rectangle+text. Laser is a pointer tool and Text-to-diagram/Mermaid-to-Excalidraw/Wireframe-to-code are Excalidraw+ AI features: no CLI equivalent.
* Unknown flags/commands fail loud (exit 2); validation failures exit 1.

## AXI principles applied

| Principle | How |
|---|---|
| Token-efficient output | TOON-style `items[n]{fields}:` rows, 3–4 fields by default |
| Minimal schemas | `list` shows file/elements/bytes only |
| Truncation | Long text cut at 200 chars (`get` JSON at 2000) with `--full` escape hatch |
| Aggregates | `elements`, `byType` counts up front |
| Empty states | Explicit `(no .excalidraw files…)`, `(empty scene…)` |
| Errors | Structured `error: …` on stdout, exit 1; unknown flag/command exit 2 |
| Content first | No-arg run shows live scenes, not help |
| Contextual disclosure | Every command ends with `help[]` next steps |
| Consistent help | `--help` on every command |

## Relationship to official tooling

* Editor: [`excalidraw/excalidraw`](https://github.com/excalidraw/excalidraw) (+ Docker `excalidraw/excalidraw:latest`)
* AI drawing: [`excalidraw/excalidraw-mcp`](https://github.com/excalidraw/excalidraw-mcp) (`https://mcp.excalidraw.com`), Excalidraw+ MCP, `yctimlin/mcp_excalidraw`
* Rendering backend used by `export`: [`@moona3k/excalidraw-export`](https://www.npmjs.com/package/@moona3k/excalidraw-export)

This CLI is the deterministic file-side complement: agents describe diagrams as specs/mermaid, get valid scenes with bound arrows, and render them in CI — no pixel-clicking the canvas.

## Roadmap

* Mermaid beyond flowchart + sequenceDiagram (needs browser-DOM libs)
* `--fields` selector for list/view
* AXI catalog PR once stable

## License

MIT
