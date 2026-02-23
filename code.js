figma.showUI(__html__, { width: 560, height: 740 });

const RULE_WEIGHTS = {
  CRITICAL: 20,
  WARNING: 10,
  MINOR: 5,
};

let lastPreviewFixes = [];

function issue(code, message, severity) {
  return { code, message, severity };
}

function isStructuralFrame(node) {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
}

function isAutoLayoutContainer(node) {
  return "layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE";
}

function checkStructure(node) {
  const issues = [];

  if (isStructuralFrame(node) && "layoutMode" in node && node.layoutMode === "NONE" && node.children && node.children.length > 0) {
    issues.push(issue("STRUCT_NO_AUTO_LAYOUT", "Structural frame is not using Auto Layout", "CRITICAL"));
  }

  if ("children" in node && node.children.length > 8) {
    issues.push(issue("STRUCT_DEEP_NEST", "Too many direct children in one container (over 8)", "WARNING"));
  }

  if ("children" in node) {
    const hasAbsoluteChild = node.children.some((c) => "layoutPositioning" in c && c.layoutPositioning === "ABSOLUTE");
    if (!isAutoLayoutContainer(node) && hasAbsoluteChild) {
      issues.push(issue("STRUCT_WEAK_HIERARCHY", "Non-auto-layout parent contains absolute-positioned children", "WARNING"));
    }
  }

  return issues;
}

function checkSpacing(node) {
  const issues = [];

  if ("layoutMode" in node && node.layoutMode === "HORIZONTAL" && "children" in node && node.children.length > 1) {
    const visibleChildren = node.children.filter((c) => c.visible !== false);
    const hasFixed = visibleChildren.some((c) => "layoutGrow" in c && c.layoutGrow === 0);
    const hasFill = visibleChildren.some((c) => "layoutGrow" in c && c.layoutGrow === 1);

    if (hasFixed && hasFill) {
      issues.push(issue("SPACE_MIXED_SIZING", "Mixed fixed and fill widths in same horizontal row", "WARNING"));
    }

    if ("itemSpacing" in node && node.itemSpacing !== 0) {
      const manualXOffsets = visibleChildren.some((c) => "x" in c && Math.abs(c.x) > 0 && "layoutPositioning" in c && c.layoutPositioning !== "AUTO");
      if (manualXOffsets) {
        issues.push(issue("SPACE_INCONSISTENT", "Detected manual offsets with Auto Layout spacing", "MINOR"));
      }
    }
  }

  if ("children" in node && node.children.length > 1) {
    const overlaps = hasBoundingBoxOverlap(node.children);
    if (overlaps) {
      issues.push(issue("SPACE_OVERLAP", "Overlapping siblings detected in same container", "CRITICAL"));
    }
  }

  return issues;
}

function checkResponsive(node) {
  const issues = [];

  if ("layoutPositioning" in node && node.layoutPositioning === "ABSOLUTE") {
    issues.push(issue("RESP_ABSOLUTE", "Absolute positioning may break responsiveness", "WARNING"));
  }

  if (node.type === "TEXT" && "width" in node && node.width > 0 && node.width < 100) {
    issues.push(issue("RESP_TEXT_NARROW", "Text layer width is too narrow for responsive behavior", "MINOR"));
  }

  if (isStructuralFrame(node) && "children" in node && node.children.length > 0 && (!("layoutMode" in node) || node.layoutMode === "NONE")) {
    issues.push(issue("RESP_CONTAINER_NOT_FLEX", "Responsive container is missing Auto Layout", "CRITICAL"));
  }

  return issues;
}

function checkDesignType(node) {
  const issues = [];

  if ("effects" in node && Array.isArray(node.effects) && node.effects.filter((e) => e.visible !== false).length > 3) {
    issues.push(issue("TYPE_HEAVY_EFFECTS", "Heavy decorative effects may not convert correctly", "MINOR"));
  }

  if ("isMask" in node && node.isMask) {
    issues.push(issue("TYPE_MASK", "Masks have limited conversion support", "WARNING"));
  }

  if ("blendMode" in node && node.blendMode && node.blendMode !== "PASS_THROUGH" && node.blendMode !== "NORMAL") {
    issues.push(issue("TYPE_BLEND", "Advanced blend mode may not map to Elementor", "MINOR"));
  }

  return issues;
}

function rect(node) {
  if (!("absoluteRenderBounds" in node) || !node.absoluteRenderBounds) {
    return null;
  }
  const b = node.absoluteRenderBounds;
  return { x1: b.x, y1: b.y, x2: b.x + b.width, y2: b.y + b.height };
}

function intersects(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function hasBoundingBoxOverlap(children) {
  const boxes = children
    .filter((c) => c.visible !== false)
    .map((c) => ({ id: c.id, rect: rect(c) }))
    .filter((x) => x.rect !== null);

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (intersects(boxes[i].rect, boxes[j].rect)) {
        return true;
      }
    }
  }

  return false;
}

function validateNode(node) {
  return [
    ...checkStructure(node),
    ...checkSpacing(node),
    ...checkResponsive(node),
    ...checkDesignType(node),
  ];
}

function scanTree(node, results = []) {
  const issues = validateNode(node);

  if (issues.length > 0) {
    results.push({
      nodeId: node.id,
      nodeName: node.name,
      nodeType: node.type,
      issues,
    });
  }

  if ("children" in node) {
    for (const child of node.children) {
      scanTree(child, results);
    }
  }

  return results;
}

function calculateScore(results) {
  let score = 100;

  for (const item of results) {
    for (const i of item.issues) {
      score -= RULE_WEIGHTS[i.severity] || 10;
    }
  }

  return Math.max(score, 0);
}

function summarize(results) {
  const counts = { CRITICAL: 0, WARNING: 0, MINOR: 0 };
  for (const r of results) {
    for (const i of r.issues) {
      counts[i.severity] = (counts[i.severity] || 0) + 1;
    }
  }
  return counts;
}

function getSelectionResults() {
  const selection = figma.currentPage.selection;

  if (!selection || selection.length === 0) {
    return {
      score: 0,
      blocked: true,
      reason: "Select at least one top-level frame or section to validate.",
      results: [],
      summary: { CRITICAL: 0, WARNING: 0, MINOR: 0 },
    };
  }

  const results = [];
  for (const node of selection) {
    scanTree(node, results);
  }

  const score = calculateScore(results);
  const summary = summarize(results);
  const hasCritical = summary.CRITICAL > 0;
  const blocked = hasCritical || score < 70;

  return {
    score,
    blocked,
    results,
    summary,
    reason: blocked
      ? hasCritical
        ? "Critical compatibility issues detected. Fix before export."
        : "Compatibility score below 70. Fix issues before export."
      : "Design is safe for conversion export.",
  };
}

function runValidation() {
  figma.ui.postMessage({
    type: "VALIDATION_RESULT",
    payload: getSelectionResults(),
  });
}

function inferAutoLayoutMode(node) {
  if (!("children" in node) || node.children.length < 2) return "VERTICAL";
  const visible = node.children.filter((c) => c.visible !== false);
  if (visible.length < 2) return "VERTICAL";

  const xs = visible.map((c) => c.x);
  const ys = visible.map((c) => c.y);
  const spreadX = Math.max(...xs) - Math.min(...xs);
  const spreadY = Math.max(...ys) - Math.min(...ys);
  return spreadX > spreadY ? "HORIZONTAL" : "VERTICAL";
}

function inferSpacing(node, mode) {
  if (!("children" in node) || node.children.length < 2) return 0;

  const visible = node.children
    .filter((c) => c.visible !== false)
    .slice()
    .sort((a, b) => (mode === "HORIZONTAL" ? a.x - b.x : a.y - b.y));

  if (visible.length < 2) return 0;

  const gaps = [];
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    const curr = visible[i];
    const gap = mode === "HORIZONTAL" ? curr.x - (prev.x + prev.width) : curr.y - (prev.y + prev.height);
    if (gap >= 0 && Number.isFinite(gap)) gaps.push(gap);
  }

  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return Math.round(gaps[Math.floor(gaps.length / 2)]);
}

function createFixId(type, nodeId, extra) {
  return `${type}:${nodeId}:${extra || "base"}`;
}

function buildFixProposals(node, proposals = []) {
  proposeAutoLayoutFix(node, proposals);
  proposeAbsolutePositionFix(node, proposals);
  proposeNarrowTextFix(node, proposals);
  proposeMixedSizingFix(node, proposals);

  if ("children" in node) {
    for (const child of node.children) {
      buildFixProposals(child, proposals);
    }
  }

  return proposals;
}

function proposeAutoLayoutFix(node, proposals) {
  if (!isStructuralFrame(node) || !("layoutMode" in node) || node.layoutMode !== "NONE" || !("children" in node) || node.children.length === 0) {
    return;
  }

  const hasAbsoluteChild = node.children.some((c) => "layoutPositioning" in c && c.layoutPositioning === "ABSOLUTE");
  const overlaps = hasBoundingBoxOverlap(node.children);

  if (hasAbsoluteChild || overlaps) {
    proposals.push({
      id: createFixId("AUTO_LAYOUT", node.id),
      type: "AUTO_LAYOUT",
      nodeId: node.id,
      nodeName: node.name,
      action: "Convert container to Auto Layout",
      safe: false,
      reason: hasAbsoluteChild
        ? "Contains absolute-positioned children; convert those first."
        : "Children overlap; manual layout cleanup required.",
      params: {},
    });
    return;
  }

  const mode = inferAutoLayoutMode(node);
  const spacing = inferSpacing(node, mode);

  proposals.push({
    id: createFixId("AUTO_LAYOUT", node.id),
    type: "AUTO_LAYOUT",
    nodeId: node.id,
    nodeName: node.name,
    action: `Convert to ${mode} Auto Layout`,
    safe: true,
    reason: "",
    params: { mode, spacing },
  });
}

function proposeAbsolutePositionFix(node, proposals) {
  if (!("layoutPositioning" in node) || node.layoutPositioning !== "ABSOLUTE" || !node.parent) {
    return;
  }

  if (!isAutoLayoutContainer(node.parent)) {
    proposals.push({
      id: createFixId("ABSOLUTE_TO_AUTO", node.id),
      type: "ABSOLUTE_TO_AUTO",
      nodeId: node.id,
      nodeName: node.name,
      action: "Normalize absolute positioning",
      safe: false,
      reason: "Parent is not Auto Layout; needs structural changes first.",
      params: {},
    });
    return;
  }

  proposals.push({
    id: createFixId("ABSOLUTE_TO_AUTO", node.id),
    type: "ABSOLUTE_TO_AUTO",
    nodeId: node.id,
    nodeName: node.name,
    action: "Set positioning to AUTO in Auto Layout parent",
    safe: true,
    reason: "",
    params: {},
  });
}

function proposeNarrowTextFix(node, proposals) {
  if (node.type !== "TEXT" || !("textAutoResize" in node) || node.width >= 100 || node.textAutoResize === "HEIGHT") {
    return;
  }

  proposals.push({
    id: createFixId("TEXT_AUTOSIZE", node.id),
    type: "TEXT_AUTOSIZE",
    nodeId: node.id,
    nodeName: node.name,
    action: "Enable text auto-resize (HEIGHT)",
    safe: true,
    reason: "",
    params: {},
  });
}

function proposeMixedSizingFix(node, proposals) {
  if (!("layoutMode" in node) || node.layoutMode !== "HORIZONTAL" || !("children" in node) || node.children.length < 2) {
    return;
  }

  const visible = node.children.filter((c) => c.visible !== false && "layoutGrow" in c);
  if (visible.length < 2) return;

  const fixed = visible.filter((c) => c.layoutGrow === 0);
  const fill = visible.filter((c) => c.layoutGrow === 1);
  if (fixed.length === 0 || fill.length === 0) return;

  const majorityGrow = fixed.length >= fill.length ? 0 : 1;
  const minority = majorityGrow === 0 ? fill : fixed;

  if (minority.length !== 1) {
    proposals.push({
      id: createFixId("MIXED_SIZING", node.id),
      type: "MIXED_SIZING",
      nodeId: node.id,
      nodeName: node.name,
      action: "Resolve mixed fixed/fill widths",
      safe: false,
      reason: "Ambiguous sizing pattern; requires manual decision.",
      params: {},
    });
    return;
  }

  proposals.push({
    id: createFixId("MIXED_SIZING", node.id, minority[0].id),
    type: "MIXED_SIZING",
    nodeId: node.id,
    nodeName: node.name,
    action: `Align ${minority[0].name} width behavior with siblings`,
    safe: true,
    reason: "",
    params: { targetNodeId: minority[0].id, layoutGrow: majorityGrow },
  });
}

function getPreviewPayload() {
  const selection = figma.currentPage.selection;

  if (!selection || selection.length === 0) {
    return {
      safeFixes: [],
      manualFixes: [],
      total: 0,
      validation: getSelectionResults(),
      reason: "Select at least one top-level frame or section.",
    };
  }

  const proposals = [];
  for (const node of selection) {
    buildFixProposals(node, proposals);
  }

  const unique = [];
  const seen = new Set();
  for (const p of proposals) {
    if (!seen.has(p.id)) {
      seen.add(p.id);
      unique.push(p);
    }
  }

  lastPreviewFixes = unique;

  return {
    safeFixes: unique.filter((p) => p.safe),
    manualFixes: unique.filter((p) => !p.safe),
    total: unique.length,
    validation: getSelectionResults(),
    reason: unique.length === 0 ? "No fix suggestions for this selection." : "",
  };
}

function runFixPreview() {
  figma.ui.postMessage({
    type: "FIX_PREVIEW_RESULT",
    payload: getPreviewPayload(),
  });
}

function applyFixByProposal(proposal) {
  switch (proposal.type) {
    case "AUTO_LAYOUT": {
      const node = figma.getNodeById(proposal.nodeId);
      if (!node || !("layoutMode" in node)) {
        throw new Error("Node unavailable or not layout-capable");
      }
      node.layoutMode = proposal.params.mode;
      node.primaryAxisSizingMode = "AUTO";
      node.counterAxisSizingMode = "FIXED";
      node.itemSpacing = proposal.params.spacing;
      return;
    }

    case "ABSOLUTE_TO_AUTO": {
      const node = figma.getNodeById(proposal.nodeId);
      if (!node || !("layoutPositioning" in node)) {
        throw new Error("Node unavailable or not positioning-capable");
      }
      node.layoutPositioning = "AUTO";
      return;
    }

    case "TEXT_AUTOSIZE": {
      const node = figma.getNodeById(proposal.nodeId);
      if (!node || node.type !== "TEXT" || !("textAutoResize" in node)) {
        throw new Error("Node unavailable or not text");
      }
      node.textAutoResize = "HEIGHT";
      return;
    }

    case "MIXED_SIZING": {
      const target = figma.getNodeById(proposal.params.targetNodeId);
      if (!target || !("layoutGrow" in target)) {
        throw new Error("Target node unavailable or not auto-layout child");
      }
      target.layoutGrow = proposal.params.layoutGrow;
      return;
    }

    default:
      throw new Error("Unsupported fix type");
  }
}

function runApplySelectedFixes(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    const preview = getPreviewPayload();
    figma.ui.postMessage({
      type: "APPLY_SELECTED_RESULT",
      payload: {
        requestedCount: 0,
        appliedCount: 0,
        applied: [],
        skipped: [],
        preview,
        validation: preview.validation,
      },
    });
    figma.notify("No fixes selected.");
    return;
  }

  if (!lastPreviewFixes || lastPreviewFixes.length === 0) {
    figma.notify("Run Preview Fixes first.");
    runFixPreview();
    return;
  }

  const selected = lastPreviewFixes.filter((p) => ids.includes(p.id) && p.safe);
  const applied = [];
  const skipped = [];

  for (const proposal of selected) {
    try {
      applyFixByProposal(proposal);
      applied.push(proposal);
    } catch (err) {
      skipped.push({ id: proposal.id, nodeName: proposal.nodeName, reason: String(err) });
    }
  }

  const refreshedPreview = getPreviewPayload();

  figma.ui.postMessage({
    type: "APPLY_SELECTED_RESULT",
    payload: {
      requestedCount: ids.length,
      appliedCount: applied.length,
      applied,
      skipped,
      preview: refreshedPreview,
      validation: refreshedPreview.validation,
    },
  });

  if (applied.length === 0) {
    figma.notify("No selected fixes were applied.");
  } else {
    figma.notify(`Applied ${applied.length} selected fix${applied.length > 1 ? "es" : ""}.`);
  }
}

function runAutoFix() {
  const preview = getPreviewPayload();
  const safeIds = preview.safeFixes.map((f) => f.id);

  if (safeIds.length === 0) {
    figma.ui.postMessage({
      type: "AUTO_FIX_RESULT",
      payload: {
        fixedCount: 0,
        fixed: [],
        preview,
        validation: preview.validation,
      },
    });
    figma.notify("No safe auto-fixes available for current selection.");
    return;
  }

  const applied = [];
  const skipped = [];

  for (const id of safeIds) {
    const proposal = lastPreviewFixes.find((p) => p.id === id);
    if (!proposal) continue;

    try {
      applyFixByProposal(proposal);
      applied.push(proposal);
    } catch (err) {
      skipped.push({ id: proposal.id, nodeName: proposal.nodeName, reason: String(err) });
    }
  }

  const refreshedPreview = getPreviewPayload();

  figma.ui.postMessage({
    type: "AUTO_FIX_RESULT",
    payload: {
      fixedCount: applied.length,
      fixed: applied,
      skipped,
      preview: refreshedPreview,
      validation: refreshedPreview.validation,
    },
  });

  if (applied.length === 0) {
    figma.notify("No safe auto-fixes were applied.");
  } else {
    figma.notify(`Auto-fix applied ${applied.length} change${applied.length > 1 ? "s" : ""}.`);
  }
}

figma.ui.onmessage = (msg) => {
  if (!msg || !msg.type) return;

  if (msg.type === "RUN_VALIDATION") {
    runValidation();
    return;
  }

  if (msg.type === "RUN_FIX_PREVIEW") {
    runFixPreview();
    return;
  }

  if (msg.type === "APPLY_SELECTED_FIXES") {
    runApplySelectedFixes(msg.ids || []);
    return;
  }

  if (msg.type === "RUN_AUTO_FIX") {
    runAutoFix();
    return;
  }

  if (msg.type === "SELECT_NODE") {
    const node = figma.getNodeById(msg.nodeId);
    if (node) {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
    return;
  }

  if (msg.type === "EXPORT_REQUEST") {
    const payload = getSelectionResults();

    if (payload.blocked) {
      figma.notify("Export blocked: fix compliance issues first.");
      figma.ui.postMessage({
        type: "EXPORT_BLOCKED",
        payload: { score: payload.score, summary: payload.summary },
      });
      return;
    }

    figma.notify("Compliance passed. Export can proceed.");
    figma.ui.postMessage({
      type: "EXPORT_ALLOWED",
      payload: { score: payload.score, summary: payload.summary },
    });
  }
};
