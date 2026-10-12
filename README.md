# excalidraw-axi

Agent-ergonomic CLI for Excalidraw diagrams. File-first `.excalidraw` operations with token-efficient output, following [AXI](https://axi.md/) principles.

> No `excalidraw-axi` existed in the [AXI catalog](https://axi.md/) — this is the first.

## Install

```sh
npm install -g github:nahidupa/excalidraw-axi
# or run without installing:
npx github:nahidupa/excalidraw-axi list
```

Requires Node >= 18. Zero runtime dependencies. The `export` command fetches `@moona3k/excalidraw-export` on demand via `npx`.

## Usage

```sh
excalidraw-axi                          # home view: scenes in cwd + next steps
excalidraw-axi list [dir]               # list .excalidraw scenes
excalidraw-axi view <file> [--full]     # scene summary (truncated unless --full)
excalidraw-axi validate <file>          # schema check (exit 1 if invalid)
excalidraw-axi create -o s.excalidraw --title "My diagram"
excalidraw-axi export <file> --svg [-o out] [--scale N]
```

Example:

```sh
$ excalidraw-axi create -o arch.excalidraw --title "API -> DB"
created: arch.excalidraw
elements: 2
help[2]:
  Run `excalidraw-axi view arch.excalidraw`
  Run `excalidraw-axi export arch.excalidraw --svg`

$ excalidraw-axi view arch.excalidraw
file: arch.excalidraw
version: 2
elements: 2
byType: text=1, rectangle=1
viewBackgroundColor: #ffffff
items[2]{id,type,x,y,w,h,text}:
  9f31…,text,100,80,132,30,API -> DB
  44ab…,rectangle,100,140,400,220,-
help[2]:
  Run `excalidraw-axi validate <file>`
  Run `excalidraw-axi export <file> --svg`
```

## AXI principles applied

| Principle | How |
|---|---|
| Token-efficient output | TOON-style `items[n]{fields}:` rows, 3–4 fields by default |
| Minimal schemas | `list` shows file/elements/bytes only |
| Truncation | Long text cut at 200 chars with `--full` escape hatch |
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

This CLI is the file-side complement: agents create/inspect/validate scenes locally, render them in CI, and hand them to any of the above for live editing.

## Roadmap

* `create --mermaid-file` auto-layout (currently embeds source as text; needs browser-DOM libs)
* `--fields` selector for list/view
* Live-canvas sync mode against local Docker (`:5001`) / `mcp_excalidraw` server
* AXI catalog PR once stable

## License

MIT
