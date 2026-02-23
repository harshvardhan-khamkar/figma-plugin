# Figma -> Elementor Pre-Conversion Compliance Engine

## What this does
- Scans selected nodes recursively
- Applies 4 validation engines:
  - Structure Validation
  - Width & Spacing Validation
  - Responsive Compliance
  - Design Type Compatibility
- Produces issue list and weighted compatibility score
- Blocks export when:
  - Any critical issue exists, or
  - Score is below 70

## Fix workflow
- `Preview`: Generates proposed fixes without mutating nodes
- Preview groups output into:
  - `Safe To Apply`
  - `Needs Manual Review`
- `Apply Selected`: Applies only checked safe fixes from preview
- `Auto-Fix All`: One-click apply for all safe fixes

## Safe fix types
- Convert eligible non-overlapping structural frames to Auto Layout
- Convert ABSOLUTE child positioning to AUTO inside Auto Layout parents
- Set narrow text layers to `textAutoResize = HEIGHT`
- Harmonize mixed fixed/fill widths when a single child is the minority

## Files
- `manifest.json` plugin manifest
- `code.js` validation + preview + apply + gate logic
- `ui.html` scan/report/preview/apply/gate UI

## Usage
1. In Figma Desktop: Plugins -> Development -> Import plugin from manifest
2. Pick `manifest.json` in this folder
3. Select one or more sections/frames
4. Click `Scan`
5. Click `Preview`
6. Click `Apply Selected` or `Auto-Fix All`
7. Re-scan and fix remaining issues until score >= 70 and no critical issues
8. Click `Export`

## Notes
This is a pre-conversion compliance gate. Export action is intentionally gated and only emits allowed/blocked events in this scaffold.
