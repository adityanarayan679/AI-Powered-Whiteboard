# Canvas — Minimal Whiteboard

An SVG-based whiteboard app with drawing tools, shapes, text, sticky notes, connectors, multi-page support, and AI-powered diagram generation.

## Features

- **Drawing tools** — Pencil, marker, laser pointer, and eraser
- **Shapes** — Rectangles, ellipses, triangles, diamonds, lines, and arrows
- **Text & sticky notes** — Inline text editing with multiple font options
- **Smart shapes** — Draw freehand shapes and they auto-convert to clean shapes
- **Multi-page** — Unlimited pages with undo/redo per page
- **Export/Import** — Save/load as JSON, export as SVG or PNG
- **AI integration** — Generate flowcharts and mindmaps using:
  - Built-in offline mode (no API key needed)
  - Gemini (Google) — `gemini-3-flash-preview`
  - OpenRouter — `google/gemini-3-flash-preview:free`
  - Groq — `llama-3.3-70b-versatile`
- **Dark mode** — Light/dark theme toggle
- **Keyboard shortcuts** — Fast tool switching, undo/redo, copy/paste
- **Responsive** — Works on desktop and mobile

## Usage

1. Open `index.html` in a browser (use a local server for AI API features)
2. Select a tool from the toolbar at the bottom
3. Draw, type, or add shapes on the canvas
4. Use the AI panel (top-right) to generate diagrams or mindmaps

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `V` | Select tool |
| `H` | Pan tool |
| `P` | Pencil |
| `M` | Marker |
| `L` | Laser |
| `E` | Eraser |
| `R` | Rectangle |
| `O` | Ellipse |
| `T` | Text |
| `S` | Sticky note |
| `A` | Arrow |
| `D` | Diamond |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+C/V` | Copy/Paste |
| `Delete` | Delete selected |
| `Escape` | Deselect / Close panels |

## Files

- `index.html` — Application shell and UI
- `style.css` — All styling (light/dark theme, responsive)
- `script.js` — Full application logic (~995 lines)

## License

MIT
