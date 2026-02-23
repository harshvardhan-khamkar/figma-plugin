# Figma Multi-Framework Code Exporter (Local)

This plugin converts selected Figma layers into:

- `HTML + Tailwind`
- `React JSX`
- `WordPress Elementor JSON`

All conversion runs locally inside the Figma plugin runtime (no external API calls).

## How it works

1. Reads current selection (`SceneNode[]`).
2. Converts nodes into a normalized intermediate JSON model.
3. Runs framework-specific generators.
4. Displays generated code, warnings, colors/gradients, and model JSON in the plugin UI.
5. Supports Figma Codegen panel output for the same three targets.

## Files

- `manifest.json` plugin metadata + codegen language mapping
- `code.js` main plugin runtime (conversion pipeline + generators + codegen handler)
- `ui.html` plugin panel UI (framework tabs, code view, warnings, palette, node focus)

## UI usage (plugin panel)

1. Import plugin from `manifest.json` in Figma Desktop.
2. Select one or more layers/frames/components.
3. Run `Regenerate`.
4. Switch tabs:
   - `HTML + Tailwind`
   - `React JSX`
   - `WordPress Elementor`
5. Copy generated code or intermediate JSON.
6. Use `Focus` on a converted node to jump to it in canvas.

## Codegen mode usage (Inspect/Dev panel)

- Enable code in Figma Code panel using one of:
  - `HTML + Tailwind`
  - `React JSX`
  - `WordPress Elementor`
- The plugin converts the current codegen target node and returns generated output for that language.

## Notes / current scope

- `GROUP` nodes are normalized to `FRAME` in the intermediate model.
- `SLICE` nodes are skipped.
- Image paints are exported as placeholder URLs in generated output.
- Vector-like nodes are simplified to placeholders in generated HTML/Elementor output.
- Complex visual effects, masks, and blend modes may require manual cleanup after generation.

