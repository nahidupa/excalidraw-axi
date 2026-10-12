---
name: excalidraw-axi
description: 'Draw and edit Excalidraw diagrams from the shell via the excalidraw-axi CLI. Use when the user wants a diagram, whiteboard drawing, flowchart, architecture diagram, or any Excalidraw scene created, edited, or exported. Triggers on mentions of excalidraw, Excalidraw, whiteboard drawing, flowchart, architecture diagram, wireframe, sketch, or .excalidraw files.'
version: "0.4.0"
---

# excalidraw-axi — draw in Excalidraw without a browser

File-first CLI for `.excalidraw` scenes. Prefer it over driving the Excalidraw UI with browser automation (`chrome-devtools-axi` pixel-clicking) — it is deterministic, token-efficient, and verifiable. Use the browser only to visually check a rendered export or to interact with excalidraw.com itself.

## Tool choice

- Create/edit/export diagrams → `excalidraw-axi` (this skill).
- Edit an EXISTING drawing → `excalidraw-axi pull` it first, then edit, `validate`, `sync` back.
- Show a scene in a running local instance → `excalidraw-axi open|sync` (no pixel-clicking).
- Look at the finished diagram → open the exported SVG/PNG, or serve it; use `chrome-devtools-axi` only if live-page verification is needed.

## Quick reference

```bash
excalidraw-axi                                        # home view: scenes in cwd + next steps
excalidraw-axi create --spec diagram.json -o out.excalidraw
excalidraw-axi create --mermaid-file flow.mmd -o out.excalidraw   # flowchart/graph + sequenceDiagram
excalidraw-axi add <file> rectangle|ellipse|diamond --label "API" [--x N --y N --w N --h N]
excalidraw-axi add <file> text --text "Hi" [--x N --y N]
excalidraw-axi add <file> arrow|line --from <id> --to <id> [--label "calls"]
excalidraw-axi add <file> arrow --points "x1,y1 x2,y2 x3,y3"      # polyline
excalidraw-axi add <file> arrow --from <a> --to <b> --elbow       # orthogonal route
excalidraw-axi add <file> freedraw --points "x1,y1 x2,y2 ..."
excalidraw-axi add <file> frame --label "F" | image --file a.png | embed --link <url>
excalidraw-axi move <file> <id...> --dx 0 --dy 60                # bound arrows+labels follow
excalidraw-axi group <file> <a> <b> | align <file> <a> <b> --top | distribute <file> <a> <b> <c> --horizontal
excalidraw-axi flip <file> <a> --horizontal | duplicate <file> <a> | lock <file> <a> | link <file> <a> --url <u> | order <file> <a> --front
excalidraw-axi lib push <lib> <scene> <a> <b> | lib list <lib> | lib unpack <lib> <item> <scene>
excalidraw-axi view <file> [--full]                   # summary + byType counts
excalidraw-axi get <file> <id> [--full]               # one element as JSON
excalidraw-axi validate <file>                        # schema + integrity, exit 1 if invalid
excalidraw-axi delete <file> <id...>                  # soft-delete + reference repair
excalidraw-axi pull <out> [--url http://localhost:5001]      # read the live tab back
excalidraw-axi pull <out> --from-url <scene-url|#url=-link>  # no browser needed
excalidraw-axi open <file> [--url http://localhost:5001]   # serve + launch #url= link in browser
excalidraw-axi sync <file> [--url http://localhost:5001]   # serve + verify load, exits 0/1
excalidraw-axi export <file> --svg [-o out.svg]       # render (needs network once for npx backend)
```

Style flags (add): `--stroke #hex --background #hex --stroke-width N --stroke-style solid|dashed|dotted --fill-style solid|hachure|cross-hatch|dots|zigzag --roundness sharp|round --angle N --roughness 0..2 --opacity 0..100 --font-family 1..5 --text-align left|center|right --locked --link <url> --frame <frame-id> --arrow-type sharp|round --start-arrowhead/--end-arrowhead none|arrow|triangle|triangle_outline|diamond|diamond_outline|circle|circle_outline|bar`. Text keeps stroke/font/align/link/lock only.

## Spec format (preferred for agents — no coordinates needed)

```json
{"layout":"row","nodes":[{"id":"api","label":"API server","shape":"rectangle"}],"edges":[{"from":"a","to":"b","label":"calls"}]}
```

- `layout`: `row` (flow right) | `column` (flow down) | `grid`.
- `shape`: `rectangle` (default) | `ellipse` | `diamond` | `text`. `id` optional (slugified from label).
- Nodes accept optional `w,h,stroke,background`.
- Workflow: write spec JSON → `create --spec` → `validate` → `export --svg` → show the SVG.

## Mermaid subset (flowchart/graph + sequenceDiagram)

- `graph`/`flowchart` with `TD,TB,LR,RL,BT`; `[box]`, `(rounded)`, `{decision}`→diamond, `((circle))`→ellipse; `-->`, `---`, `==>`, `--o`, `--x`, `-.->`; `|labels|`; `A-->B-->C` chains.
- `sequenceDiagram`: `participant`/`actor` (+`as` names), `->/->>/-->/-->>/-x/--x` messages (`--` = dashed reply), `Note over|left of|right of`. Block markers (loop/alt/...) are skipped.
- Other diagram types fail loudly — do not retry them, ask the user or use a spec instead.

## Live instance (serve/open/sync/pull)

The app loads external scenes via `#url=<file-url>`. `serve` runs a localhost CORS server (default port 5237) that re-reads the file per request; `open` serves + launches the link; `sync` serves + loads via the `chrome-devtools-axi` helper and verifies the element count (needs the helper on PATH). `pull` reads the tab back (whole canvas — selection is not persisted by the app). If the tab asks to replace the canvas, confirm it. `serve`/`open` run until Ctrl+C.

## Rules

- `add` without `--x/--y` auto-places below existing content — use explicit coords only when layout matters.
- `--label` binds inside the shape by default (human-edit safe); `--unbound` keeps overlay text. Edge labels stay midpoint text.
- Get element ids from `view` (first column), never invent them.
- `move` drags arrows bound on every end to the moved set plus bound labels; partially-bound arrows are reported left-behind — re-add those.
- Images keep aspect (explicit side wins, else intrinsic ≤1000px); identical bytes share one `files[]` entry. Live tabs resolve single images; 2+ images may show placeholders (upstream `#url=` loader quirk — export/validate unaffected).
- Embeds render inline only on allowlisted hosts (youtube/vimeo/codesandbox/…); elsewhere they show as links.
- No sticky type in OSS Excalidraw — use rectangle+text. No laser/AI ops (pointer tool / Excalidraw+ only).
- Exit codes: 0 ok, 1 validation/content failure, 2 unknown command/flag.
- Every command prints `help[]` next steps — follow them instead of guessing.
