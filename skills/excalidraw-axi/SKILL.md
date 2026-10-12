---
name: excalidraw-axi
description: 'Draw and edit Excalidraw diagrams from the shell via the excalidraw-axi CLI. Use when the user wants a diagram, whiteboard drawing, flowchart, architecture diagram, or any Excalidraw scene created, edited, or exported. Triggers on mentions of excalidraw, Excalidraw, whiteboard drawing, flowchart, architecture diagram, wireframe, sketch, or .excalidraw files.'
version: "0.2.0"
---

# excalidraw-axi — draw in Excalidraw without a browser

File-first CLI for `.excalidraw` scenes. Prefer it over driving the Excalidraw UI with browser automation (`chrome-devtools-axi` pixel-clicking) — it is deterministic, token-efficient, and verifiable. Use the browser only to visually check a rendered export or to interact with excalidraw.com itself.

## Tool choice

- Create/edit/export diagrams → `excalidraw-axi` (this skill).
- Look at the finished diagram → open the exported SVG/PNG, or serve it; use `chrome-devtools-axi` only if live-page verification is needed.

## Quick reference

```bash
excalidraw-axi                                        # home view: scenes in cwd + next steps
excalidraw-axi create --spec diagram.json -o out.excalidraw
excalidraw-axi create --mermaid-file flow.mmd -o out.excalidraw
excalidraw-axi add <file> rectangle|ellipse|diamond --label "API" [--x N --y N --w N --h N]
excalidraw-axi add <file> text --text "Hi" [--x N --y N]
excalidraw-axi add <file> arrow|line --from <id> --to <id> [--label "calls"]
excalidraw-axi view <file> [--full]                   # summary + byType counts
excalidraw-axi get <file> <id> [--full]               # one element as JSON
excalidraw-axi validate <file>                        # exit 1 if invalid
excalidraw-axi move <file> <id> --dx 0 --dy 60
excalidraw-axi delete <file> <id...>                  # soft-delete
excalidraw-axi export <file> --svg [-o out.svg]       # render (needs network once for npx backend)
```

## Spec format (preferred for agents — no coordinates needed)

```json
{"layout":"row","nodes":[{"id":"api","label":"API server","shape":"rectangle"}],"edges":[{"from":"a","to":"b","label":"calls"}]}
```

- `layout`: `row` (flow right) | `column` (flow down) | `grid`.
- `shape`: `rectangle` (default) | `ellipse` | `diamond` | `text`. `id` optional (slugified from label).
- Workflow: write spec JSON → `create --spec` → `validate` → `export --svg` → show the SVG.

## Mermaid subset (flowchart/graph only)

`graph`/`flowchart` with `TD,TB,LR,RL,BT`; `[box]`, `(rounded)`, `{decision}`→diamond, `((circle))`→ellipse; `-->`, `---`, `==>`, `--o`, `--x`, `-.->`; `|labels|`; `A-->B-->C` chains. Other diagram types fail loudly — do not retry them, ask the user or use a spec instead.

## Rules

- `add` without `--x/--y` auto-places below existing content — use explicit coords only when layout matters.
- Get element ids from `view` (first column), never invent them.
- `move` does not drag attached arrows — re-add arrows after moving shapes.
- Exit codes: 0 ok, 1 validation/content failure, 2 unknown command/flag.
- Every command prints `help[]` next steps — follow them instead of guessing.
