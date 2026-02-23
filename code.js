const FRAMEWORKS = ["html-tailwind", "react", "wordpress-elementor"];
const STORAGE_KEY = "figma-to-code-mvp-settings";
const DEFAULT_SETTINGS = { framework: "html-tailwind" };

let settings = { framework: DEFAULT_SETTINGS.framework };
let isRunning = false;
let queuedTrigger = null;

function round(value, digits) {
  if (digits === undefined) digits = 2;
  if (!Number.isFinite(value)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function escapeHtml(input) {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function escapeAttr(input) {
  return escapeHtml(input).replace(/'/g, "&#39;");
}

function sanitizeName(name) {
  const clean = String(name || "Node").trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean || "Node";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rgbToHex(color) {
  if (!color) return "#000000";
  const r = clamp(Math.round((Number(color.r) || 0) * 255), 0, 255);
  const g = clamp(Math.round((Number(color.g) || 0) * 255), 0, 255);
  const b = clamp(Math.round((Number(color.b) || 0) * 255), 0, 255);
  const h = function (n) { return n.toString(16).padStart(2, "0"); };
  return ("#" + h(r) + h(g) + h(b)).toLowerCase();
}

function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (!/^[a-fA-F0-9]{6}$/.test(clean)) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function cssColor(hex, opacity) {
  const alpha = Number.isFinite(opacity) ? round(opacity, 3) : 1;
  if (alpha >= 1) return hex;
  const rgb = hexToRgb(hex);
  return "rgba(" + rgb.r + ", " + rgb.g + ", " + rgb.b + ", " + alpha + ")";
}

function createContext() {
  return { nameCounts: new Map(), warningKeys: new Set(), warnings: [] };
}

function addWarning(ctx, code, message, nodeId, nodeName) {
  const key = code + ":" + String(nodeId || "global") + ":" + message;
  if (ctx.warningKeys.has(key)) return;
  ctx.warningKeys.add(key);
  ctx.warnings.push({ code: code, message: message, nodeId: nodeId || null, nodeName: nodeName || null });
}

function uniqueName(rawName, ctx) {
  const base = sanitizeName(rawName);
  const prev = ctx.nameCounts.get(base) || 0;
  ctx.nameCounts.set(base, prev + 1);
  if (prev === 0) return base;
  return base + "_" + String(prev + 1).padStart(2, "0");
}

function parseLineHeight(value) {
  if (!value || value === figma.mixed) return null;
  if (typeof value === "number") return round(value);
  if (value.unit === "PIXELS") return round(value.value);
  return null;
}

function parseLetterSpacing(value) {
  if (!value || value === figma.mixed) return null;
  if (value.unit === "PIXELS") return round(value.value);
  return null;
}

function parsePaints(paints, ctx, nodeId, nodeName) {
  if (!paints || paints === figma.mixed || !Array.isArray(paints)) return [];

  const out = [];
  for (let i = 0; i < paints.length; i++) {
    const paint = paints[i];
    if (!paint || paint.visible === false) continue;

    if (paint.type === "SOLID") {
      out.push({
        type: "SOLID",
        color: rgbToHex(paint.color),
        opacity: Number.isFinite(paint.opacity) ? round(paint.opacity, 3) : 1,
      });
      continue;
    }

    if (
      paint.type === "GRADIENT_LINEAR" ||
      paint.type === "GRADIENT_RADIAL" ||
      paint.type === "GRADIENT_ANGULAR" ||
      paint.type === "GRADIENT_DIAMOND"
    ) {
      const stops = [];
      const rawStops = safeArray(paint.gradientStops);
      for (let s = 0; s < rawStops.length; s++) {
        const stop = rawStops[s];
        if (!stop || !stop.color) continue;
        stops.push({
          position: Number.isFinite(stop.position) ? round(stop.position, 3) : 0,
          color: rgbToHex(stop.color),
          opacity: Number.isFinite(stop.color.a) ? round(stop.color.a, 3) : 1,
        });
      }

      const handles = [];
      const rawHandles = safeArray(paint.gradientHandlePositions);
      for (let h = 0; h < rawHandles.length; h++) {
        const p = rawHandles[h];
        handles.push({
          x: Number.isFinite(p.x) ? round(p.x, 6) : 0,
          y: Number.isFinite(p.y) ? round(p.y, 6) : 0,
        });
      }

      out.push({
        type: paint.type,
        opacity: Number.isFinite(paint.opacity) ? round(paint.opacity, 3) : 1,
        stops: stops,
        handles: handles,
      });
      continue;
    }

    if (paint.type === "IMAGE") {
      out.push({ type: "IMAGE", scaleMode: paint.scaleMode || "FILL" });
      addWarning(ctx, "IMAGE_PLACEHOLDER", "Image paints are represented as placeholders.", nodeId, nodeName);
      continue;
    }

    out.push({ type: paint.type });
    addWarning(ctx, "PAINT_UNSUPPORTED", "Paint type " + paint.type + " is simplified.", nodeId, nodeName);
  }

  return out;
}

function parseEffects(effects, ctx, nodeId, nodeName) {
  if (!effects || effects === figma.mixed || !Array.isArray(effects)) return [];
  const out = [];

  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    if (!e || e.visible === false) continue;

    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      out.push({
        type: e.type,
        color: rgbToHex(e.color),
        colorOpacity: Number.isFinite(e.color && e.color.a) ? round(e.color.a, 3) : 1,
        opacity: Number.isFinite(e.opacity) ? round(e.opacity, 3) : 1,
        offsetX: Number.isFinite(e.offset && e.offset.x) ? round(e.offset.x) : 0,
        offsetY: Number.isFinite(e.offset && e.offset.y) ? round(e.offset.y) : 0,
        radius: Number.isFinite(e.radius) ? round(e.radius) : 0,
        spread: Number.isFinite(e.spread) ? round(e.spread) : 0,
      });
      continue;
    }

    if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      out.push({ type: e.type, radius: Number.isFinite(e.radius) ? round(e.radius) : 0 });
      continue;
    }

    out.push({ type: e.type });
    addWarning(ctx, "EFFECT_UNSUPPORTED", "Effect type " + e.type + " may need manual editing.", nodeId, nodeName);
  }

  return out;
}

function firstPaintOfType(paints, type) {
  const list = safeArray(paints);
  for (let i = 0; i < list.length; i++) {
    if (list[i].type === type) return list[i];
  }
  return null;
}

function firstGradient(paints) {
  const list = safeArray(paints);
  for (let i = 0; i < list.length; i++) {
    if (String(list[i].type).indexOf("GRADIENT_") === 0) return list[i];
  }
  return null;
}

function hasImagePaint(paints) {
  const list = safeArray(paints);
  for (let i = 0; i < list.length; i++) {
    if (list[i].type === "IMAGE") return true;
  }
  return false;
}

function detectVectorLike(type) {
  return ["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE", "POLYGON"].indexOf(type) !== -1;
}

function calculateRectangleFromBoundingBox(boundingBox, figmaRotationDegrees) {
  const cssRotationDegrees = -figmaRotationDegrees;
  const theta = (cssRotationDegrees * Math.PI) / 180;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const absCosTheta = Math.abs(cosTheta);
  const absSinTheta = Math.abs(sinTheta);

  const denominator = absCosTheta * absCosTheta - absSinTheta * absSinTheta;
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 0.0001) {
    return {
      width: round(boundingBox.width),
      height: round(boundingBox.height),
      left: round(boundingBox.x),
      top: round(boundingBox.y),
      rotation: cssRotationDegrees,
    };
  }

  const h = (boundingBox.width * absSinTheta - boundingBox.height * absCosTheta) / -denominator;
  const w = (boundingBox.width - h * absSinTheta) / absCosTheta;

  const corners = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  const rotated = [];
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i];
    rotated.push({ x: c.x * cosTheta + c.y * sinTheta, y: -c.x * sinTheta + c.y * cosTheta });
  }

  const minX = Math.min(rotated[0].x, rotated[1].x, rotated[2].x, rotated[3].x);
  const minY = Math.min(rotated[0].y, rotated[1].y, rotated[2].y, rotated[3].y);

  return {
    width: round(w),
    height: round(h),
    left: round(boundingBox.x - minX),
    top: round(boundingBox.y - minY),
    rotation: cssRotationDegrees,
  };
}

function stopToCss(stop, fillOpacity, multiplier, unit) {
  const alpha = round((Number(stop.opacity) || 1) * (Number(fillOpacity) || 1), 3);
  const color = cssColor(stop.color, alpha);
  const pos = round((Number(stop.position) || 0) * (Number(multiplier) || 100), 2);
  return color + " " + pos + String(unit || "%");
}

function stopsToCss(stops, fillOpacity, multiplier, unit) {
  const list = safeArray(stops);
  const out = [];
  for (let i = 0; i < list.length; i++) out.push(stopToCss(list[i], fillOpacity, multiplier, unit));
  return out.join(", ");
}

function linearGradientCss(paint) {
  const handles = safeArray(paint.handles);
  let cssAngle = 180;
  if (handles.length >= 2) {
    const start = handles[0];
    const end = handles[1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    angle = (angle + 360) % 360;
    cssAngle = (angle + 90) % 360;
  }
  return "linear-gradient(" + round(cssAngle, 0) + "deg, " + stopsToCss(paint.stops, paint.opacity, 100, "%") + ")";
}

function radialGradientCss(paint) {
  const handles = safeArray(paint.handles);
  if (handles.length < 3) return "radial-gradient(" + stopsToCss(paint.stops, paint.opacity, 100, "%") + ")";
  const c = handles[0];
  const h1 = handles[1];
  const h2 = handles[2];
  const cx = round(c.x * 100, 2);
  const cy = round(c.y * 100, 2);
  const rx = round(Math.sqrt(Math.pow(h1.x - c.x, 2) + Math.pow(h1.y - c.y, 2)) * 100, 2);
  const ry = round(Math.sqrt(Math.pow(h2.x - c.x, 2) + Math.pow(h2.y - c.y, 2)) * 100, 2);
  return "radial-gradient(ellipse " + rx + "% " + ry + "% at " + cx + "% " + cy + "%, " + stopsToCss(paint.stops, paint.opacity, 100, "%") + ")";
}

function angularGradientCss(paint) {
  const handles = safeArray(paint.handles);
  if (handles.length < 3) return "conic-gradient(" + stopsToCss(paint.stops, paint.opacity, 360, "deg") + ")";
  const c = handles[0];
  const s = handles[2];
  const dx = s.x - c.x;
  const dy = s.y - c.y;
  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  angle = (angle + 360) % 360;
  const cx = round(c.x * 100, 2);
  const cy = round(c.y * 100, 2);
  return "conic-gradient(from " + round(angle, 0) + "deg at " + cx + "% " + cy + "%, " + stopsToCss(paint.stops, paint.opacity, 360, "deg") + ")";
}

function gradientToCss(paint) {
  if (!paint) return "";
  if (paint.type === "GRADIENT_LINEAR") return linearGradientCss(paint);
  if (paint.type === "GRADIENT_RADIAL") return radialGradientCss(paint);
  if (paint.type === "GRADIENT_ANGULAR") return angularGradientCss(paint);
  if (paint.type === "GRADIENT_DIAMOND") {
    const stops = stopsToCss(paint.stops, paint.opacity, 50, "%");
    return [
      "linear-gradient(to bottom right, " + stops + ") bottom right / 50% 50% no-repeat",
      "linear-gradient(to bottom left, " + stops + ") bottom left / 50% 50% no-repeat",
      "linear-gradient(to top left, " + stops + ") top left / 50% 50% no-repeat",
      "linear-gradient(to top right, " + stops + ") top right / 50% 50% no-repeat",
    ].join(", ");
  }
  return "";
}

function buildBackgroundCss(fills, width, height) {
  const list = safeArray(fills);
  if (!list.length) return "";

  const layers = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const paint = list[i];
    if (paint.type === "SOLID") {
      const c = cssColor(paint.color, paint.opacity);
      if (i === list.length - 1) {
        layers.push("linear-gradient(0deg, " + c + " 0%, " + c + " 100%)");
      } else {
        layers.push(c);
      }
      continue;
    }
    if (String(paint.type).indexOf("GRADIENT_") === 0) {
      layers.push(gradientToCss(paint));
      continue;
    }
    if (paint.type === "IMAGE") {
      const w = Math.max(1, Math.round(width || 1));
      const h = Math.max(1, Math.round(height || 1));
      layers.push("url('https://via.placeholder.com/" + w + "x" + h + "')");
    }
  }
  return layers.join(", ");
}

function parseTextModel(figmaNode, uniqueNodeName) {
  if (!figmaNode || figmaNode.type !== "TEXT") return null;

  let fontFamily = null;
  let fontWeight = null;
  if (figmaNode.fontName && figmaNode.fontName !== figma.mixed && typeof figmaNode.fontName === "object") {
    fontFamily = figmaNode.fontName.family || null;
    const match = String(figmaNode.fontName.style || "").match(/([0-9]{3})/);
    fontWeight = match ? Number(match[1]) : null;
  }

  const model = {
    characters: figmaNode.characters || "",
    fontSize: figmaNode.fontSize === figma.mixed ? null : Number(figmaNode.fontSize) || null,
    lineHeight: parseLineHeight(figmaNode.lineHeight),
    letterSpacing: parseLetterSpacing(figmaNode.letterSpacing),
    textAlignHorizontal: figmaNode.textAlignHorizontal || "LEFT",
    textAutoResize: figmaNode.textAutoResize || "NONE",
    fontFamily: fontFamily,
    fontWeight: fontWeight,
    segments: [],
  };

  if (typeof figmaNode.getStyledTextSegments === "function") {
    try {
      const segments = figmaNode.getStyledTextSegments(["fontName", "fontSize", "fills"]);
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        model.segments.push({
          id: uniqueNodeName + "_seg_" + String(i + 1).padStart(2, "0"),
          characters: seg.characters || "",
          fontSize: seg.fontSize === figma.mixed ? null : Number(seg.fontSize) || null,
        });
      }
    } catch (_err) {
      // ignore segment failures
    }
  }

  return model;
}

function normalizeLayout(raw, figmaNode) {
  return {
    mode: raw.layoutMode || ("layoutMode" in figmaNode ? figmaNode.layoutMode : "NONE") || "NONE",
    itemSpacing: Number.isFinite(raw.itemSpacing) ? Math.round(raw.itemSpacing) : ("itemSpacing" in figmaNode && Number.isFinite(figmaNode.itemSpacing) ? Math.round(figmaNode.itemSpacing) : 0),
    paddingTop: Number.isFinite(raw.paddingTop) ? Math.round(raw.paddingTop) : ("paddingTop" in figmaNode && Number.isFinite(figmaNode.paddingTop) ? Math.round(figmaNode.paddingTop) : 0),
    paddingRight: Number.isFinite(raw.paddingRight) ? Math.round(raw.paddingRight) : ("paddingRight" in figmaNode && Number.isFinite(figmaNode.paddingRight) ? Math.round(figmaNode.paddingRight) : 0),
    paddingBottom: Number.isFinite(raw.paddingBottom) ? Math.round(raw.paddingBottom) : ("paddingBottom" in figmaNode && Number.isFinite(figmaNode.paddingBottom) ? Math.round(figmaNode.paddingBottom) : 0),
    paddingLeft: Number.isFinite(raw.paddingLeft) ? Math.round(raw.paddingLeft) : ("paddingLeft" in figmaNode && Number.isFinite(figmaNode.paddingLeft) ? Math.round(figmaNode.paddingLeft) : 0),
    primaryAxisAlignItems: raw.primaryAxisAlignItems || ("primaryAxisAlignItems" in figmaNode ? figmaNode.primaryAxisAlignItems : "MIN") || "MIN",
    counterAxisAlignItems: raw.counterAxisAlignItems || ("counterAxisAlignItems" in figmaNode ? figmaNode.counterAxisAlignItems : "MIN") || "MIN",
    layoutWrap: raw.layoutWrap || ("layoutWrap" in figmaNode ? figmaNode.layoutWrap : "NO_WRAP") || "NO_WRAP",
  };
}

function isAbsolutePosition(node, parent) {
  if (node.positioning === "ABSOLUTE") return true;
  if (!parent) return false;
  if (!parent.layout || parent.layout.mode === "NONE") return true;
  return false;
}

function adjustChildrenOrder(node) {
  if (!node.itemReverseZIndex || !Array.isArray(node.children) || node.layout.mode === "NONE") return;
  const abs = [];
  const normal = [];
  for (let i = node.children.length - 1; i >= 0; i--) {
    const c = node.children[i];
    if (c.positioning === "ABSOLUTE") abs.push(c);
    else normal.unshift(c);
  }
  node.children = abs.concat(normal);
}

async function processNodePair(raw, figNode, ctx, parentModel, parentRaw, parentRotation) {
  if (!raw || raw.visible === false || !figNode) return null;
  if (raw.type === "SLICE") return null;

  let nodeType = raw.type;
  if (nodeType === "GROUP") {
    nodeType = "FRAME";
    raw.type = "FRAME";
    addWarning(ctx, "GROUP_NORMALIZED", "GROUP node normalized to FRAME.", raw.id, raw.name);
  }

  if ((nodeType === "FRAME" || nodeType === "INSTANCE" || nodeType === "COMPONENT") && (!raw.children || raw.children.length === 0)) {
    nodeType = "RECTANGLE";
    raw.type = "RECTANGLE";
  }

  let nodeRotation = 0;
  if (Number.isFinite(raw.rotation)) nodeRotation = -raw.rotation * (180 / Math.PI);

  let x = Number.isFinite(figNode.x) ? round(figNode.x) : 0;
  let y = Number.isFinite(figNode.y) ? round(figNode.y) : 0;
  let width = Number.isFinite(figNode.width) ? round(figNode.width) : 0;
  let height = Number.isFinite(figNode.height) ? round(figNode.height) : 0;

  if (raw.absoluteBoundingBox) {
    if (parentRaw && parentRaw.absoluteBoundingBox) {
      const rect = calculateRectangleFromBoundingBox(
        {
          width: raw.absoluteBoundingBox.width,
          height: raw.absoluteBoundingBox.height,
          x: raw.absoluteBoundingBox.x - parentRaw.absoluteBoundingBox.x,
          y: raw.absoluteBoundingBox.y - parentRaw.absoluteBoundingBox.y,
        },
        -(nodeRotation + (parentRotation || 0)),
      );
      x = rect.left;
      y = rect.top;
      width = rect.width;
      height = rect.height;
    } else {
      x = 0;
      y = 0;
      width = round(raw.absoluteBoundingBox.width);
      height = round(raw.absoluteBoundingBox.height);
    }
  }

  const name = raw.name || figNode.name || figNode.type;
  const unique = uniqueName(name, ctx);

  const model = {
    id: raw.id || figNode.id,
    parentId: parentModel ? parentModel.id : null,
    name: name,
    uniqueName: unique,
    type: nodeType,
    originalType: raw.type || figNode.type,
    x: x,
    y: y,
    width: width,
    height: height,
    rotation: round(nodeRotation),
    opacity: Number.isFinite(raw.opacity) ? round(raw.opacity, 3) : (Number.isFinite(figNode.opacity) ? round(figNode.opacity, 3) : 1),
    positioning: raw.layoutPositioning || ("layoutPositioning" in figNode ? figNode.layoutPositioning : "AUTO") || "AUTO",
    layout: normalizeLayout(raw, figNode),
    layoutGrow: Number.isFinite(raw.layoutGrow) ? raw.layoutGrow : ("layoutGrow" in figNode && Number.isFinite(figNode.layoutGrow) ? figNode.layoutGrow : 0),
    layoutSizingHorizontal: raw.layoutSizingHorizontal || ("layoutSizingHorizontal" in figNode ? figNode.layoutSizingHorizontal : "FIXED") || "FIXED",
    layoutSizingVertical: raw.layoutSizingVertical || ("layoutSizingVertical" in figNode ? figNode.layoutSizingVertical : "FIXED") || "FIXED",
    minWidth: Number.isFinite(raw.minWidth) ? round(raw.minWidth) : null,
    maxWidth: Number.isFinite(raw.maxWidth) ? round(raw.maxWidth) : null,
    minHeight: Number.isFinite(raw.minHeight) ? round(raw.minHeight) : null,
    maxHeight: Number.isFinite(raw.maxHeight) ? round(raw.maxHeight) : null,
    cornerRadius: Number.isFinite(raw.cornerRadius) ? round(raw.cornerRadius) : ("cornerRadius" in figNode && Number.isFinite(figNode.cornerRadius) ? round(figNode.cornerRadius) : 0),
    clipsContent: !!raw.clipsContent,
    fills: parsePaints(raw.fills, ctx, raw.id, name),
    strokes: parsePaints(raw.strokes, ctx, raw.id, name),
    effects: parseEffects(raw.effects, ctx, raw.id, name),
    blendMode: raw.blendMode || "PASS_THROUGH",
    isMask: !!raw.isMask,
    isVectorLike: detectVectorLike(nodeType),
    text: parseTextModel(figNode, unique),
    isRelative: false,
    itemReverseZIndex: !!raw.itemReverseZIndex,
    strokeWeight: Number.isFinite(raw.strokeWeight) ? round(raw.strokeWeight) : ("strokeWeight" in figNode && Number.isFinite(figNode.strokeWeight) ? round(figNode.strokeWeight) : 0),
    dashPattern: Array.isArray(raw.dashPattern) ? raw.dashPattern.slice() : ("dashPattern" in figNode && Array.isArray(figNode.dashPattern) ? figNode.dashPattern.slice() : []),
    children: [],
  };

  if (model.blendMode !== "PASS_THROUGH" && model.blendMode !== "NORMAL") {
    addWarning(ctx, "BLEND_SIMPLIFIED", "Blend mode " + model.blendMode + " may need manual edits.", model.id, model.name);
  }
  if (model.isMask) {
    addWarning(ctx, "MASK_SIMPLIFIED", "Mask behavior is simplified in generated output.", model.id, model.name);
  }
  if (model.isVectorLike) {
    addWarning(ctx, "VECTOR_SIMPLIFIED", "Vector-like node converted to generic block/widget.", model.id, model.name);
  }

  if (Array.isArray(raw.children) && "children" in figNode) {
    const figChildren = new Map();
    for (let i = 0; i < figNode.children.length; i++) figChildren.set(figNode.children[i].id, figNode.children[i]);

    for (let i = 0; i < raw.children.length; i++) {
      const rawChild = raw.children[i];
      if (!rawChild || rawChild.visible === false) continue;
      const figChild = figChildren.get(rawChild.id);
      if (!figChild) continue;
      const child = await processNodePair(rawChild, figChild, ctx, model, raw, parentRotation || 0);
      if (child) model.children.push(child);
    }
  }

  if (model.layout.mode === "NONE") model.isRelative = true;
  for (let i = 0; i < model.children.length; i++) {
    if (model.children[i].positioning === "ABSOLUTE") {
      model.isRelative = true;
      break;
    }
  }

  adjustChildrenOrder(model);
  return model;
}

async function nodesToModel(selection, ctx) {
  ctx.nameCounts.clear();
  const out = [];

  for (let i = 0; i < selection.length; i++) {
    const node = selection[i];
    let exported = null;
    try {
      exported = await node.exportAsync({ format: "JSON_REST_V1" });
    } catch (err) {
      addWarning(ctx, "JSON_EXPORT_FAILED", "JSON export failed: " + String(err), node.id, node.name);
      continue;
    }

    const raw = exported && exported.document ? exported.document : null;
    if (!raw) continue;

    if (node.type === "GROUP") {
      raw.type = "FRAME";
      raw.rotation = 0;
    }

    const converted = await processNodePair(raw, node, ctx, null, null, 0);
    if (converted) out.push(converted);
  }

  return out;
}

function countNodes(nodes) {
  let total = 0;
  const list = safeArray(nodes);
  for (let i = 0; i < list.length; i++) total += 1 + countNodes(list[i].children);
  return total;
}

function collectPalette(nodes) {
  const colorSet = new Set();
  const gradientSet = new Set();

  function walk(node) {
    const paints = safeArray(node.fills).concat(safeArray(node.strokes));
    for (let i = 0; i < paints.length; i++) {
      const p = paints[i];
      if (p.type === "SOLID") colorSet.add(cssColor(p.color, p.opacity));
      if (String(p.type).indexOf("GRADIENT_") === 0) gradientSet.add(gradientToCss(p));
    }
    for (let c = 0; c < node.children.length; c++) walk(node.children[c]);
  }

  const roots = safeArray(nodes);
  for (let i = 0; i < roots.length; i++) walk(roots[i]);

  return { colors: Array.from(colorSet), gradients: Array.from(gradientSet) };
}

function mapJustifyCss(value) {
  const v = String(value || "MIN").toUpperCase();
  if (v === "CENTER") return "center";
  if (v === "MAX") return "flex-end";
  if (v === "SPACE_BETWEEN") return "space-between";
  return "flex-start";
}

function mapAlignCss(value) {
  const v = String(value || "MIN").toUpperCase();
  if (v === "CENTER") return "center";
  if (v === "MAX") return "flex-end";
  if (v === "BASELINE") return "baseline";
  return "flex-start";
}

function mapJustifyTw(value) {
  const v = String(value || "MIN").toUpperCase();
  if (v === "CENTER") return "justify-center";
  if (v === "MAX") return "justify-end";
  if (v === "SPACE_BETWEEN") return "justify-between";
  return "justify-start";
}

function mapAlignTw(value) {
  const v = String(value || "MIN").toUpperCase();
  if (v === "CENTER") return "items-center";
  if (v === "MAX") return "items-end";
  if (v === "BASELINE") return "items-baseline";
  return "items-start";
}

function pxClass(prefix, value) {
  if (!Number.isFinite(value)) return "";
  const v = Math.round(value);
  if (v === 0) return prefix + "-0";
  return prefix + "-[" + v + "px]";
}

function buildTailwindClasses(node, parent, isText) {
  const out = [];

  if (node.layout.mode !== "NONE") {
    const parentMode = parent && parent.layout ? parent.layout.mode : "NONE";
    out.push(parentMode === node.layout.mode ? "flex" : "inline-flex");
    out.push(node.layout.mode === "HORIZONTAL" ? "flex-row" : "flex-col");
    out.push(mapJustifyTw(node.layout.primaryAxisAlignItems));
    out.push(mapAlignTw(node.layout.counterAxisAlignItems));
    if (node.layout.itemSpacing > 0 && String(node.layout.primaryAxisAlignItems || "").toUpperCase() !== "SPACE_BETWEEN") {
      out.push(pxClass("gap", node.layout.itemSpacing));
    }
  }

  if (node.layout.paddingTop > 0) out.push(pxClass("pt", node.layout.paddingTop));
  if (node.layout.paddingRight > 0) out.push(pxClass("pr", node.layout.paddingRight));
  if (node.layout.paddingBottom > 0) out.push(pxClass("pb", node.layout.paddingBottom));
  if (node.layout.paddingLeft > 0) out.push(pxClass("pl", node.layout.paddingLeft));

  if (isAbsolutePosition(node, parent)) {
    out.push("absolute", pxClass("left", node.x), pxClass("top", node.y));
  } else if (node.isRelative || node.type === "GROUP") {
    out.push("relative");
  }

  if (node.layoutSizingHorizontal === "FIXED") out.push(pxClass("w", node.width));
  if (node.layoutSizingVertical === "FIXED") out.push(pxClass("h", node.height));
  if (node.layoutSizingHorizontal === "FILL") out.push(parent && parent.layout.mode === "HORIZONTAL" ? "flex-1" : "self-stretch");
  if (node.layoutSizingVertical === "FILL") out.push(parent && parent.layout.mode === "VERTICAL" ? "flex-1" : "self-stretch");

  if (node.maxWidth !== null && node.maxWidth !== undefined) out.push(pxClass("max-w", node.maxWidth));
  if (node.minWidth !== null && node.minWidth !== undefined) out.push(pxClass("min-w", node.minWidth));
  if (node.maxHeight !== null && node.maxHeight !== undefined) out.push(pxClass("max-h", node.maxHeight));
  if (node.minHeight !== null && node.minHeight !== undefined) out.push(pxClass("min-h", node.minHeight));

  if (node.cornerRadius > 0) out.push(pxClass("rounded", node.cornerRadius));
  if (node.clipsContent) out.push("overflow-hidden");
  if (isText) out.push("whitespace-pre-wrap");

  const dedup = [];
  const seen = new Set();
  for (let i = 0; i < out.length; i++) {
    const t = String(out[i] || "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    dedup.push(t);
  }
  return dedup.join(" ");
}

function styleBorder(node) {
  const stroke = firstPaintOfType(node.strokes, "SOLID");
  if (!stroke || !(node.strokeWeight > 0)) return "";
  const borderStyle = node.dashPattern && node.dashPattern.length > 0 ? "dotted" : "solid";
  return node.strokeWeight + "px " + borderStyle + " " + cssColor(stroke.color, stroke.opacity);
}

function boxShadowCss(effects) {
  const list = safeArray(effects);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.type !== "DROP_SHADOW" && e.type !== "INNER_SHADOW") continue;
    const c = cssColor(e.color, round((Number(e.colorOpacity) || 1) * (Number(e.opacity) || 1), 3));
    out.push((e.type === "INNER_SHADOW" ? "inset " : "") + round(e.offsetX) + "px " + round(e.offsetY) + "px " + round(e.radius) + "px " + round(e.spread) + "px " + c);
  }
  return out.join(", ");
}

function buildHtmlStyle(node, parent, isText) {
  const s = [];

  if (node.layout.mode !== "NONE") {
    const parentMode = parent && parent.layout ? parent.layout.mode : "NONE";
    s.push("display:" + (parentMode === node.layout.mode ? "flex" : "inline-flex"));
    s.push("flex-direction:" + (node.layout.mode === "HORIZONTAL" ? "row" : "column"));
    s.push("justify-content:" + mapJustifyCss(node.layout.primaryAxisAlignItems));
    s.push("align-items:" + mapAlignCss(node.layout.counterAxisAlignItems));
    if (node.layout.itemSpacing > 0 && String(node.layout.primaryAxisAlignItems || "").toUpperCase() !== "SPACE_BETWEEN") s.push("gap:" + node.layout.itemSpacing + "px");
  }

  if (isAbsolutePosition(node, parent)) {
    s.push("position:absolute", "left:" + round(node.x) + "px", "top:" + round(node.y) + "px");
  } else if (node.isRelative || node.type === "GROUP") {
    s.push("position:relative");
  }

  if (node.layoutSizingHorizontal === "FIXED") s.push("width:" + round(node.width) + "px");
  if (node.layoutSizingVertical === "FIXED") s.push("height:" + round(node.height) + "px");

  if (node.layout.paddingTop > 0) s.push("padding-top:" + node.layout.paddingTop + "px");
  if (node.layout.paddingRight > 0) s.push("padding-right:" + node.layout.paddingRight + "px");
  if (node.layout.paddingBottom > 0) s.push("padding-bottom:" + node.layout.paddingBottom + "px");
  if (node.layout.paddingLeft > 0) s.push("padding-left:" + node.layout.paddingLeft + "px");

  if (node.cornerRadius > 0) s.push("border-radius:" + node.cornerRadius + "px");
  if (node.clipsContent) s.push("overflow:hidden");

  const bg = !isText ? buildBackgroundCss(node.fills, node.width, node.height) : "";
  if (bg) s.push("background:" + bg);
  if (hasImagePaint(node.fills)) s.push("background-size:cover", "background-position:center");

  const border = styleBorder(node);
  if (border) s.push("border:" + border);

  const shadow = boxShadowCss(node.effects);
  if (shadow) s.push("box-shadow:" + shadow);

  if (node.opacity < 1) s.push("opacity:" + round(node.opacity, 3));
  if (Math.abs(node.rotation) > 0.01) s.push("transform:rotate(" + round(node.rotation, 2) + "deg)");

  if (isText && node.text) {
    const fill = firstPaintOfType(node.fills, "SOLID");
    if (fill) s.push("color:" + cssColor(fill.color, fill.opacity));
    if (node.text.fontSize) s.push("font-size:" + round(node.text.fontSize) + "px");
    if (node.text.lineHeight) s.push("line-height:" + round(node.text.lineHeight) + "px");
    if (node.text.letterSpacing) s.push("letter-spacing:" + round(node.text.letterSpacing) + "px");
    if (node.text.fontFamily) s.push("font-family:" + node.text.fontFamily);
    if (node.text.fontWeight) s.push("font-weight:" + Math.round(node.text.fontWeight));
    s.push("white-space:pre-wrap");
    s.push("text-align:" + String(node.text.textAlignHorizontal || "LEFT").toLowerCase());
  }

  return s.join("; ");
}

function renderHtmlNode(node, parent, depth) {
  const pad = "  ".repeat(depth);
  const isText = !!node.text;
  const tag = isText ? "p" : "div";
  const classes = buildTailwindClasses(node, parent, isText);
  const style = buildHtmlStyle(node, parent, isText);
  const classAttr = classes ? ' class="' + escapeAttr(classes) + '"' : "";
  const styleAttr = style ? ' style="' + escapeAttr(style) + '"' : "";
  const dataAttr = ' data-node="' + escapeAttr(node.uniqueName) + '"';

  if (isText) return pad + "<" + tag + classAttr + dataAttr + styleAttr + ">" + escapeHtml(node.text.characters || "") + "</" + tag + ">";
  if (!node.children.length) return pad + "<" + tag + classAttr + dataAttr + styleAttr + "></" + tag + ">";

  const children = [];
  for (let i = 0; i < node.children.length; i++) children.push(renderHtmlNode(node.children[i], node, depth + 1));
  return pad + "<" + tag + classAttr + dataAttr + styleAttr + ">\n" + children.join("\n") + "\n" + pad + "</" + tag + ">";
}

function generateHtmlTailwind(nodes) {
  if (!nodes.length) return "<!-- Select one or more layers to generate HTML + Tailwind -->";
  const lines = ["<!-- Generated locally from selected Figma layers -->", '<div class="flex flex-col gap-4">'];
  for (let i = 0; i < nodes.length; i++) lines.push(renderHtmlNode(nodes[i], null, 1));
  lines.push("</div>");
  return lines.join("\n");
}

function reactLiteral(v) {
  return typeof v === "number" ? String(round(v, 3)) : JSON.stringify(v);
}

function reactStyle(node, parent, isText) {
  const e = [];
  if (node.layout.mode !== "NONE") {
    const parentMode = parent && parent.layout ? parent.layout.mode : "NONE";
    e.push(["display", parentMode === node.layout.mode ? "flex" : "inline-flex"]);
    e.push(["flexDirection", node.layout.mode === "HORIZONTAL" ? "row" : "column"]);
    e.push(["justifyContent", mapJustifyCss(node.layout.primaryAxisAlignItems)]);
    e.push(["alignItems", mapAlignCss(node.layout.counterAxisAlignItems)]);
    if (node.layout.itemSpacing > 0) e.push(["gap", node.layout.itemSpacing]);
  }

  if (isAbsolutePosition(node, parent)) e.push(["position", "absolute"], ["left", node.x], ["top", node.y]);
  else if (node.isRelative || node.type === "GROUP") e.push(["position", "relative"]);

  if (node.layoutSizingHorizontal === "FIXED") e.push(["width", node.width]);
  if (node.layoutSizingVertical === "FIXED") e.push(["height", node.height]);

  if (node.layout.paddingTop > 0) e.push(["paddingTop", node.layout.paddingTop]);
  if (node.layout.paddingRight > 0) e.push(["paddingRight", node.layout.paddingRight]);
  if (node.layout.paddingBottom > 0) e.push(["paddingBottom", node.layout.paddingBottom]);
  if (node.layout.paddingLeft > 0) e.push(["paddingLeft", node.layout.paddingLeft]);

  const bg = !isText ? buildBackgroundCss(node.fills, node.width, node.height) : "";
  if (bg) e.push(["background", bg]);

  const border = styleBorder(node);
  if (border) e.push(["border", border]);

  const shadow = boxShadowCss(node.effects);
  if (shadow) e.push(["boxShadow", shadow]);

  if (node.cornerRadius > 0) e.push(["borderRadius", node.cornerRadius]);
  if (node.clipsContent) e.push(["overflow", "hidden"]);
  if (node.opacity < 1) e.push(["opacity", node.opacity]);
  if (Math.abs(node.rotation) > 0.01) e.push(["transform", "rotate(" + round(node.rotation, 2) + "deg)"]);

  if (isText && node.text) {
    const fill = firstPaintOfType(node.fills, "SOLID");
    if (fill) e.push(["color", cssColor(fill.color, fill.opacity)]);
    if (node.text.fontSize) e.push(["fontSize", node.text.fontSize]);
    if (node.text.lineHeight) e.push(["lineHeight", node.text.lineHeight]);
    if (node.text.letterSpacing) e.push(["letterSpacing", node.text.letterSpacing]);
    if (node.text.fontFamily) e.push(["fontFamily", node.text.fontFamily]);
    if (node.text.fontWeight) e.push(["fontWeight", node.text.fontWeight]);
    e.push(["whiteSpace", "pre-wrap"]);
    e.push(["textAlign", String(node.text.textAlignHorizontal || "LEFT").toLowerCase()]);
  }

  if (!e.length) return "";
  const parts = [];
  for (let i = 0; i < e.length; i++) parts.push(e[i][0] + ": " + reactLiteral(e[i][1]));
  return " style={{ " + parts.join(", ") + " }}";
}

function renderReactNode(node, parent, depth) {
  const pad = "  ".repeat(depth);
  const isText = !!node.text;
  const tag = isText ? "p" : "div";
  const attrs = ' data-node="' + escapeAttr(node.uniqueName) + '"' + reactStyle(node, parent, isText);

  if (isText) return pad + "<" + tag + attrs + ">{" + JSON.stringify(node.text.characters || "") + "}</" + tag + ">";
  if (!node.children.length) return pad + "<" + tag + attrs + " />";

  const children = [];
  for (let i = 0; i < node.children.length; i++) children.push(renderReactNode(node.children[i], node, depth + 1));
  return pad + "<" + tag + attrs + ">\n" + children.join("\n") + "\n" + pad + "</" + tag + ">";
}

function generateReact(nodes) {
  const lines = ['import React from "react";', "", "export default function GeneratedLayout() {", "  return ("];
  if (!nodes.length) {
    lines.push("    <div>Select one or more layers to generate React code.</div>");
  } else if (nodes.length === 1) {
    lines.push(renderReactNode(nodes[0], null, 2));
  } else {
    lines.push('    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>');
    for (let i = 0; i < nodes.length; i++) lines.push(renderReactNode(nodes[i], null, 3));
    lines.push("    </div>");
  }
  lines.push("  );", "}");
  return lines.join("\n");
}

function compactId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9]/g, "").slice(-8).padStart(8, "0");
}

function headingSize(fontSize) {
  const px = Number(fontSize) || 0;
  if (px >= 44) return "xxl";
  if (px >= 34) return "xl";
  if (px >= 28) return "large";
  if (px >= 22) return "medium";
  return "small";
}

function nodeToElementor(node, parent, ctx) {
  const solid = firstPaintOfType(node.fills, "SOLID");
  const stroke = firstPaintOfType(node.strokes, "SOLID");

  if (node.text) {
    const heading = (node.text.fontSize || 0) >= 28;
    const widgetType = heading ? "heading" : "text-editor";
    const settingsObj = heading
      ? { title: node.text.characters || "", size: headingSize(node.text.fontSize) }
      : { editor: "<p>" + escapeHtml(node.text.characters || "") + "</p>" };
    if (solid) settingsObj.text_color = cssColor(solid.color, solid.opacity);
    if (node.text.fontFamily) settingsObj.typography_font_family = node.text.fontFamily;
    if (node.text.fontSize) settingsObj.typography_font_size = { unit: "px", size: Math.round(node.text.fontSize) };
    return { id: compactId(node.id), elType: "widget", widgetType: widgetType, settings: settingsObj, elements: [], _title: node.name };
  }

  if (hasImagePaint(node.fills)) {
    const w = Math.max(1, Math.round(node.width || 1));
    const h = Math.max(1, Math.round(node.height || 1));
    return {
      id: compactId(node.id),
      elType: "widget",
      widgetType: "image",
      settings: { image: { url: "https://via.placeholder.com/" + w + "x" + h } },
      elements: [],
      _title: node.name,
    };
  }

  if (node.isVectorLike) {
    return {
      id: compactId(node.id),
      elType: "widget",
      widgetType: "html",
      settings: { html: "<!-- Vector placeholder: " + escapeHtml(node.name) + " -->" },
      elements: [],
      _title: node.name,
    };
  }

  const c = { content_width: "full" };
  if (node.layout.mode === "HORIZONTAL") c.flex_direction = "row";
  if (node.layout.mode === "VERTICAL") c.flex_direction = "column";
  if (node.layout.mode !== "NONE") {
    c.justify_content = mapJustifyCss(node.layout.primaryAxisAlignItems).replace("flex-", "");
    c.align_items = mapAlignCss(node.layout.counterAxisAlignItems).replace("flex-", "");
    if (node.layout.itemSpacing > 0) c.gap = { unit: "px", size: node.layout.itemSpacing };
  }
  if (node.layout.paddingTop || node.layout.paddingRight || node.layout.paddingBottom || node.layout.paddingLeft) {
    c.padding = { unit: "px", top: node.layout.paddingTop, right: node.layout.paddingRight, bottom: node.layout.paddingBottom, left: node.layout.paddingLeft, isLinked: false };
  }
  if (solid) {
    c.background_background = "classic";
    c.background_color = cssColor(solid.color, solid.opacity);
  }
  const gradient = firstGradient(node.fills);
  if (!solid && gradient) {
    c.custom_background_css = gradientToCss(gradient);
    addWarning(ctx, "ELEMENTOR_GRADIENT_APPROX", "Elementor gradient mapped as custom CSS hint.", node.id, node.name);
  }
  if (stroke && node.strokeWeight > 0) {
    c.border_border = "solid";
    c.border_color = cssColor(stroke.color, stroke.opacity);
    c.border_width = { unit: "px", top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight, isLinked: true };
  }
  if (node.cornerRadius > 0) {
    c.border_radius = { unit: "px", top: node.cornerRadius, right: node.cornerRadius, bottom: node.cornerRadius, left: node.cornerRadius, isLinked: true };
  }
  if (isAbsolutePosition(node, parent)) {
    c.position = "absolute";
    c._position = { x: node.x, y: node.y };
  }
  if (node.layoutSizingHorizontal === "FIXED") c.width = { unit: "px", size: Math.round(node.width) };
  if (node.layoutSizingVertical === "FIXED") c.min_height = { unit: "px", size: Math.round(node.height) };

  const children = [];
  for (let i = 0; i < node.children.length; i++) children.push(nodeToElementor(node.children[i], node, ctx));

  return { id: compactId(node.id), elType: "container", isInner: !!parent, settings: c, elements: children, _title: node.name };
}

function generateElementor(nodes, ctx) {
  const content = [];
  for (let i = 0; i < nodes.length; i++) content.push(nodeToElementor(nodes[i], null, ctx));
  return JSON.stringify({ version: "0.4", title: "Generated from Figma selection", type: "page", status: "publish", content: content, page_settings: [] }, null, 2);
}

function generateOutputs(nodes, ctx) {
  return {
    "html-tailwind": generateHtmlTailwind(nodes),
    react: generateReact(nodes),
    "wordpress-elementor": generateElementor(nodes, ctx),
  };
}

async function buildPayload(sourceNodes, forcedFramework) {
  const selection = Array.isArray(sourceNodes) ? sourceNodes : figma.currentPage.selection;
  const framework = FRAMEWORKS.includes(forcedFramework) ? forcedFramework : settings.framework;

  if (!selection || selection.length === 0) {
    const emptyOutputs = generateOutputs([], createContext());
    return {
      framework: framework,
      outputs: emptyOutputs,
      activeCode: emptyOutputs[framework],
      warnings: [{ code: "EMPTY_SELECTION", message: "Select one or more layers to generate code.", nodeId: null, nodeName: null }],
      palettes: { colors: [], gradients: [] },
      selectionCount: 0,
      nodeCount: 0,
      model: [],
      modelJSON: "[]",
      mode: figma.mode,
      reason: "Select one or more layers to generate code.",
    };
  }

  const ctx = createContext();
  const model = await nodesToModel(selection, ctx);
  const outputs = generateOutputs(model, ctx);

  return {
    framework: framework,
    outputs: outputs,
    activeCode: outputs[framework],
    warnings: ctx.warnings,
    palettes: collectPalette(model),
    selectionCount: selection.length,
    nodeCount: countNodes(model),
    model: model,
    modelJSON: JSON.stringify(model, null, 2),
    mode: figma.mode,
    reason: model.length ? "" : "No visible/convertible nodes found in selection.",
  };
}

async function loadSettings() {
  try {
    const raw = await figma.clientStorage.getAsync(STORAGE_KEY);
    if (!raw || typeof raw !== "object") return { framework: DEFAULT_SETTINGS.framework };
    return { framework: FRAMEWORKS.includes(raw.framework) ? raw.framework : DEFAULT_SETTINGS.framework };
  } catch (_err) {
    return { framework: DEFAULT_SETTINGS.framework };
  }
}

async function saveSettings() {
  try {
    await figma.clientStorage.setAsync(STORAGE_KEY, settings);
  } catch (_err) {
    // ignore
  }
}

async function postConversion(trigger) {
  const payload = await buildPayload(null, null);
  figma.ui.postMessage({ type: "CONVERSION_RESULT", payload: Object.assign({}, payload, { trigger: trigger }) });
}

function runSafe(trigger) {
  if (isRunning) {
    queuedTrigger = trigger;
    return;
  }

  isRunning = true;
  postConversion(trigger)
    .catch(function (err) {
      figma.ui.postMessage({ type: "CONVERSION_ERROR", payload: { message: String(err) } });
    })
    .finally(function () {
      isRunning = false;
      if (queuedTrigger) {
        const next = queuedTrigger;
        queuedTrigger = null;
        runSafe(next);
      }
    });
}

function frameworkFromCodegenLanguage(language) {
  if (language === "HTML_TAILWIND" || language === "HTML") return "html-tailwind";
  if (language === "REACT" || language === "JAVASCRIPT" || language === "TYPESCRIPT") return "react";
  if (language === "WORDPRESS_ELEMENTOR" || language === "JSON") return "wordpress-elementor";
  return settings.framework;
}

function codegenTitle(framework) {
  if (framework === "react") return "React JSX";
  if (framework === "wordpress-elementor") return "WordPress Elementor JSON";
  return "HTML + Tailwind";
}

function initializeCodegenMode() {
  figma.codegen.on("generate", async function (event) {
    const framework = frameworkFromCodegenLanguage(event.language);
    const payload = await buildPayload([event.node], framework);
    return [{ title: codegenTitle(framework), code: payload.activeCode }];
  });
}

function initializePluginMode() {
  figma.showUI(__html__, { width: 1000, height: 760, themeColors: true });

  figma.on("selectionchange", function () { runSafe("selectionchange"); });
  figma.on("documentchange", function () { runSafe("documentchange"); });

  figma.ui.onmessage = function (msg) {
    if (!msg || !msg.type) return;

    if (msg.type === "RUN_CONVERSION") {
      runSafe("manual");
      return;
    }

    if (msg.type === "SET_FRAMEWORK") {
      if (FRAMEWORKS.includes(msg.framework)) {
        settings.framework = msg.framework;
        void saveSettings();
        runSafe("framework-change");
      }
      return;
    }

    if (msg.type === "SELECT_NODE" && msg.nodeId) {
      const node = figma.getNodeById(msg.nodeId);
      if (node) {
        figma.currentPage.selection = [node];
        figma.viewport.scrollAndZoomIntoView([node]);
      }
    }
  };

  loadSettings().then(function (loaded) {
    settings = loaded;
    runSafe("init");
  });
}

if (figma.mode === "codegen") initializeCodegenMode();
else initializePluginMode();
