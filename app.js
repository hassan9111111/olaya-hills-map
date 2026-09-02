/**
 * Olaya Hills Interactive Map — Stage 2 (plot-level interaction)
 * ----------------------------------------------------------------
 * Data model (kept deliberately decoupled for future stages):
 *
 *   blocks-data.json  -> one entry per block/facility.
 *                        A "block" is just an aggregation: it knows its own
 *                        outline (for the badge hit-circle) and the list of
 *                        plot ids that belong to it. It does NOT own plot
 *                        geometry or plot attributes.
 *
 *   plots-data.json   -> one entry per plot, fully independent object:
 *                        { block, plot, area, usage, polygon, precision,
 *                          status, price, deedNo, owner, notes }
 *                        Future stages (status colors, price, search...)
 *                        only need to edit THIS file / this layer.
 *
 * Interaction layers (see index.html):
 *   #facilities-layer -> one polygon per facility, opens facility modal
 *   #plots-layer       -> one polygon per plot, opens plot modal
 *   #badges-layer       -> one small circle per block (drawn last = on top),
 *                          opens the full block modal
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const BLOCKS_URL = "blocks-data.json";
const PLOTS_URL = "plots-data.json";
const BADGE_RADIUS = 6; // pt, small enough to avoid covering nearby plot centers

// Sales reps: whoever opens the link with ?m=<key> gets all "أنا مهتم"
// WhatsApp buttons routed to their own number, so a lead from a shared
// link always reaches the rep who actually sent it. No key present ->
// falls back to the manager.
const SALES_REPS = {
  abdulrahman: { name: "عبدالرحمن", phone: "966558075216" },
  ali: { name: "علي", phone: "966550017243" },
  hassan: { name: "حسن", phone: "966504669338" },
};
const DEFAULT_REP_KEY = "hassan";

function getActiveRep() {
  const params = new URLSearchParams(window.location.search);
  const key = params.get("m");
  return SALES_REPS[key] || SALES_REPS[DEFAULT_REP_KEY];
}

let blocksData = {};
let plotsData = {};
let highlightedPlotId = null;

async function loadData() {
  const [blocksRes, plotsRes] = await Promise.all([fetch(BLOCKS_URL), fetch(PLOTS_URL)]);
  if (!blocksRes.ok) throw new Error(`Failed to load ${BLOCKS_URL}: ${blocksRes.status}`);
  if (!plotsRes.ok) throw new Error(`Failed to load ${PLOTS_URL}: ${plotsRes.status}`);
  blocksData = await blocksRes.json();
  plotsData = await plotsRes.json();
}

function pointsToAttr(polygon) {
  return polygon.map((p) => `${p[0]},${p[1]}`).join(" ");
}

/* ---------------- Rendering (one function per layer) ---------------- */

function renderBlockOutlines() {
  const layer = document.getElementById("block-outlines-layer");
  const fragment = document.createDocumentFragment();

  Object.entries(blocksData).forEach(([blockId, block]) => {
    if (!block.polygon) return; // not_extracted — nothing real to draw
    // Black halo drawn first (underneath) so the bright outline reads
    // clearly even against dark facility icons (e.g. civil defense navy).
    const halo = document.createElementNS(SVG_NS, "polygon");
    halo.setAttribute("points", pointsToAttr(block.polygon));
    halo.classList.add("block-outline-halo");
    fragment.appendChild(halo);

    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", pointsToAttr(block.polygon));
    el.setAttribute("data-block-outline-id", blockId);
    el.classList.add("block-outline");
    fragment.appendChild(el);
  });

  layer.appendChild(fragment);
}

function renderFacilities() {
  const layer = document.getElementById("facilities-layer");
  const fragment = document.createDocumentFragment();

  Object.entries(blocksData)
    .filter(([, block]) => block.type === "facility")
    .forEach(([blockId, block]) => {
      if (!block.polygon) return; // not_extracted
      const el = document.createElementNS(SVG_NS, "polygon");
      el.setAttribute("points", pointsToAttr(block.polygon));
      el.setAttribute("data-facility-id", blockId);
      el.classList.add("facility-polygon");
      fragment.appendChild(el);
    });

  layer.appendChild(fragment);
}

function renderPlots() {
  const layer = document.getElementById("plots-layer");
  const fragment = document.createDocumentFragment();

  Object.entries(plotsData).forEach(([plotId, plot]) => {
    if (!plot.polygon) return; // not_extracted — skip rather than guess
    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", pointsToAttr(plot.polygon));
    el.setAttribute("data-plot-id", plotId);
    el.classList.add("plot-polygon");
    fragment.appendChild(el);
  });

  layer.appendChild(fragment);
}

function renderBadges() {
  const layer = document.getElementById("badges-layer");
  const fragment = document.createDocumentFragment();

  // Enlarge the tap AREA (not the visual artwork) on touch devices by
  // setting a bigger "r" attribute directly — this works identically on
  // every browser, unlike a CSS transform (which depends on transform-box
  // support that some mobile browsers, notably older Samsung Internet,
  // handle inconsistently and can shift the tap target off-circle).
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  const TOUCH_SCALE = 2;

  Object.entries(blocksData)
    .filter(([, block]) => block.type === "block")
    .forEach(([blockId, block]) => {
      if (!block.centroid) return; // not_extracted
      const realRadius = block.badge_radius || BADGE_RADIUS;
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", block.centroid[0]);
      el.setAttribute("cy", block.centroid[1]);
      el.setAttribute("r", isTouch ? realRadius * TOUCH_SCALE : realRadius);
      el.setAttribute("data-block-id", blockId);
      el.classList.add("block-badge");
      fragment.appendChild(el);
    });

  layer.appendChild(fragment);
}

/* ---------------- Sale status overlay (available / sold) ----------------
   Purely visual, non-interactive layer. Click resolution never reads DOM
   hit-testing (see resolveMapClick), so this layer can sit anywhere in the
   stack with pointer-events:none and never affect any click behavior. ---- */

// Minimal convex hull (Andrew's monotone chain) — used only to draw a tight
// OUTER stroke around a block's real plots, never for the fill itself.
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

// The stored block.polygon field (originally computed for badge placement)
// is noticeably LOOSER than a block's true footprint for many blocks —
// bleeding into streets/medians when used for visual outlines. Everywhere
// a block's outline is drawn on the map, use this tight hull (built
// directly from its own real, click-verified plot boundaries) instead.
// Cached per block since it never changes at runtime.
const blockTightHullCache = {};
// Traces a block's true outer silhouette by actually RASTERIZING every one
// of its plots onto a pixel grid (filled) and walking the resulting shape's
// contour — the same principle image-editing tools use for "select by
// color" outlines. This is immune to the vertex-matching edge cases that
// break pure vector boundary-tracing (e.g. a plot that only touches its
// neighbors at single points rather than full shared edges), because it
// never needs edges to match at all — it only cares whether a pixel is
// inside the union or not.
function getBlockRasterOutline(blockId) {
  const block = blocksData[blockId];
  if (!block || !block.plot_ids) return null;

  const SCALE = 4; // px per map unit — enough precision, still fast
  const MARGIN = 6;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const polys = [];
  block.plot_ids.forEach((pid) => {
    const plot = plotsData[pid];
    if (!plot || !plot.polygon) return;
    polys.push(plot.polygon);
    plot.polygon.forEach(([x, y]) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
  });
  if (polys.length === 0) return null;
  minX -= MARGIN;
  minY -= MARGIN;
  maxX += MARGIN;
  maxY += MARGIN;

  const w = Math.ceil((maxX - minX) * SCALE);
  const h = Math.ceil((maxY - minY) * SCALE);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  polys.forEach((poly) => {
    ctx.beginPath();
    poly.forEach(([x, y], i) => {
      const px = (x - minX) * SCALE;
      const py = (y - minY) * SCALE;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  });

  const imgData = ctx.getImageData(0, 0, w, h).data;
  const isFilled = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    return imgData[(y * w + x) * 4 + 3] > 128;
  };

  // Find a guaranteed boundary starting pixel: leftmost pixel of the
  // topmost filled row.
  let startX = -1,
    startY = -1;
  outer: for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (isFilled(x, y)) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX === -1) return null;

  // Moore-neighbor boundary tracing (8-connected).
  const dirs = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const contour = [];
  let cx = startX,
    cy = startY;
  let backtrackDir = 6; // came from "north" conceptually, matches first-pixel-found scan
  let safety = w * h * 4;
  do {
    contour.push([cx, cy]);
    let dir = (backtrackDir + 6) % 8; // start search from one step counter-clockwise of entry
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = dirs[(dir + i) % 8];
      const nx = cx + d[0],
        ny = cy + d[1];
      if (isFilled(nx, ny)) {
        backtrackDir = (dir + i) % 8;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break;
    safety--;
  } while ((cx !== startX || cy !== startY) && safety > 0);

  if (contour.length < 3) return null;

  // Simplify with a basic Douglas-Peucker pass so the SVG polygon isn't
  // thousands of single-pixel-step points.
  function perpDist(pt, a, b) {
    const [x, y] = pt,
      [x1, y1] = a,
      [x2, y2] = b;
    const dx = x2 - x1,
      dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(x - x1, y - y1);
    const t = ((x - x1) * dx + (y - y1) * dy) / len2;
    const px = x1 + t * dx,
      py = y1 + t * dy;
    return Math.hypot(x - px, y - py);
  }
  function simplify(points, epsilon) {
    if (points.length < 3) return points;
    let maxDist = 0,
      idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
      const d = perpDist(points[i], points[0], points[points.length - 1]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > epsilon) {
      const left = simplify(points.slice(0, idx + 1), epsilon);
      const right = simplify(points.slice(idx), epsilon);
      return left.slice(0, -1).concat(right);
    }
    return [points[0], points[points.length - 1]];
  }
  const simplified = simplify(contour, SCALE * 1.5);

  return simplified.map(([px, py]) => [
    Math.round((px / SCALE + minX) * 10) / 10,
    Math.round((py / SCALE + minY) * 10) / 10,
  ]);
}

function getBlockTightHull(blockId) {
  if (blockTightHullCache[blockId]) return blockTightHullCache[blockId];
  const block = blocksData[blockId];
  if (!block || !block.plot_ids) return null;
  const pts = [];
  block.plot_ids.forEach((pid) => {
    const plot = plotsData[pid];
    if (plot && plot.polygon) pts.push(...plot.polygon);
  });
  if (pts.length < 3) return null;
  const hull = convexHull(pts);
  blockTightHullCache[blockId] = hull;
  return hull;
}

function renderStatusOverlays() {
  const layer = document.getElementById("status-overlay-layer");
  layer.innerHTML = "";
  const fragment = document.createDocumentFragment();

  Object.entries(blocksData).forEach(([blockId, block]) => {
    if (block.type !== "block") return;

    if (block.sale_type === "كامل") {
      if (block.status === "مباع") {
        // Fill: each real plot polygon individually — guarantees the
        // shading never extends past a true plot boundary into a street,
        // sidewalk, median, or landscaped strip, no matter how irregular
        // the block's overall shape is.
        const allPoints = [];
        block.plot_ids.forEach((pid) => {
          const plot = plotsData[pid];
          if (!plot || !plot.polygon) return;
          allPoints.push(...plot.polygon);
          const fillEl = document.createElementNS(SVG_NS, "polygon");
          fillEl.setAttribute("points", pointsToAttr(plot.polygon));
          fillEl.classList.add("sold-overlay-fill");
          fragment.appendChild(fillEl);
        });
        // Stroke: the shared tight hull, so the outer outline hugs the
        // actual block silhouette instead of a looser pre-computed shape.
        const hull = getBlockTightHull(blockId);
        if (hull) {
          const strokeEl = document.createElementNS(SVG_NS, "polygon");
          strokeEl.setAttribute("points", pointsToAttr(hull));
          strokeEl.classList.add("sold-overlay-stroke");
          fragment.appendChild(strokeEl);
        }
      }
    } else if (block.sale_type === "بالقطعة") {
      // dashed outline tracing this block's real outer silhouette — reads
      // at the block level from a glance, not just as a small badge detail
      const hull = getBlockTightHull(blockId);
      if (hull) {
        const outlineEl = document.createElementNS(SVG_NS, "polygon");
        outlineEl.setAttribute("points", pointsToAttr(hull));
        outlineEl.classList.add("by-plot-block-outline");
        fragment.appendChild(outlineEl);
      }
      // individual sold plots within this block
      block.plot_ids.forEach((pid) => {
        const plot = plotsData[pid];
        if (plot && plot.status === "مباعة" && plot.polygon) {
          const el = document.createElementNS(SVG_NS, "polygon");
          el.setAttribute("points", pointsToAttr(plot.polygon));
          el.classList.add("sold-overlay");
          fragment.appendChild(el);
        }
      });
    }
  });

  layer.appendChild(fragment);
}

/* ---------------- Interaction wiring ---------------- */

// Point-in-polygon test (ray casting).
function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInCircle(x, y, cx, cy, r) {
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
}

// Resolve a click/tap to exactly one target, using shape priority rather
// than DOM stacking order. Three tiers:
//   1. The badge's small "core" — tapping the printed number itself always
//      opens that block directly, even if a plot polygon technically
//      reaches under it. This preserves one-tap block access everywhere.
//   2. Real plot/facility polygons — win over the WIDER touch-enlarged badge
//      area, so an enlarged badge can never swallow a nearby plot's tap.
//   3. The full touch-enlarged badge radius — fallback for open space near
//      the badge that no plot actually covers.
//
// A few single-plot commercial blocks (25, 28, 31) have their one plot's
// centroid sitting almost exactly on the badge center, which made that
// plot's natural center point unreachable under the default core radius.
// Rather than changing behavior for all 44 blocks, these three get a much
// smaller core override — block access still works with a precise tap,
// while the rest of their (large) plot area opens normally.
const BADGE_CORE_RADIUS_OVERRIDES = { 25: 2, 28: 2, 31: 2 };

function resolveMapClick(svgX, svgY) {
  // The by-plot blocks' printed number needs to reliably open the block's
  // own details (full plot table) even when the badge center happens to
  // sit inside one of its own plots — a small precise "core" around the
  // number wins first, before plot polygons get their turn.
  const BADGE_CORE_RADIUS = 6;
  for (const [blockId, block] of Object.entries(blocksData)) {
    if (block.type === "block" && block.sale_type === "بالقطعة" && block.centroid) {
      if (pointInCircle(svgX, svgY, block.centroid[0], block.centroid[1], BADGE_CORE_RADIUS)) {
        return { type: "block", id: blockId };
      }
    }
  }

  // Whole-sale blocks are sold as one unit, so tapping ANY of their plots
  // opens that block's own details — not the individual plot. Only the
  // three sale-by-plot blocks keep true plot-level tapping.
  for (const [plotId, plot] of Object.entries(plotsData)) {
    if (plot.polygon && pointInPolygon(svgX, svgY, plot.polygon)) {
      const parentBlock = blocksData[plot.block];
      if (parentBlock && parentBlock.sale_type === "بالقطعة") {
        return { type: "plot", id: plotId };
      }
      return { type: "block", id: plot.block };
    }
  }
  for (const [blockId, block] of Object.entries(blocksData)) {
    if (block.type === "facility" && block.polygon && pointInPolygon(svgX, svgY, block.polygon)) {
      return { type: "facility", id: blockId };
    }
  }

  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  for (const [blockId, block] of Object.entries(blocksData)) {
    if (block.type === "block" && block.centroid) {
      const r = (block.badge_radius || BADGE_RADIUS) * (isTouch ? 2 : 1);
      if (pointInCircle(svgX, svgY, block.centroid[0], block.centroid[1], r)) {
        return { type: "block", id: blockId };
      }
    }
  }
  return null;
}

function attachInteractions() {
  const overlay = document.getElementById("overlay");

  // pointerup (not click) fires immediately and reliably on touch-release
  // across modern mobile browsers (Chrome Android, Samsung Internet, iOS
  // Safari) — a bare "click" listener needed an extra first tap on some of
  // them before it would respond.
  overlay.addEventListener("pointerup", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;

    const pt = overlay.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgP = pt.matrixTransform(overlay.getScreenCTM().inverse());

    const hit = resolveMapClick(svgP.x, svgP.y);
    if (!hit) return;
    if (hit.type === "plot") openPlotModal(hit.id);
    else if (hit.type === "facility") openFacilityModal(hit.id);
    else if (hit.type === "block") openBlockModal(hit.id);
  });

  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

/* ---------------- Plot highlight (visual context on the map) ----------
   Whenever a plot's details are opened — by direct click, by search, or
   by tapping a row in the block table — this makes its shape clearly
   visible on the map (own outline + neighbors + street), and keeps it
   visible even after the info panel is closed, until another plot is
   picked. It never changes hover/click hit-testing, only adds a visual
   layer on top. ---------------------------------------------------- */

function clearPlotHighlight() {
  const prev = document.querySelector(".plot-polygon.is-selected");
  if (prev) prev.classList.remove("is-selected", "is-sold-selected");
  highlightedPlotId = null;
  const prevBlockOutline = document.querySelector(".block-select-outline");
  if (prevBlockOutline) prevBlockOutline.remove();
}

function highlightPlotOnMap(plotId) {
  clearPlotHighlight();
  const el = document.querySelector(`.plot-polygon[data-plot-id="${plotId}"]`);
  if (!el) return;
  el.classList.add("is-selected");
  const plot = plotsData[plotId];
  const parentBlock = plot ? blocksData[plot.block] : null;
  const isSold =
    (plot && plot.status === "مباعة") ||
    (parentBlock && parentBlock.sale_type === "كامل" && parentBlock.status === "مباع");
  if (isSold) el.classList.add("is-sold-selected");
  highlightedPlotId = plotId;

  // Bring it into view, positioned toward the TOP of the viewport so it
  // stays visible above a bottom-sheet modal on mobile, and isn't hidden
  // behind the centered modal on desktop either.
  const rect = el.getBoundingClientRect();
  const margin = window.innerHeight * 0.22;
  const isComfortablyVisible = rect.top > 60 && rect.bottom < window.innerHeight - margin;
  if (!isComfortablyVisible) {
    const targetY = window.scrollY + rect.top - Math.max(70, window.innerHeight * 0.18);
    window.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" });
  }
}

// Traces a block's TRUE outer silhouette from its real plot boundaries —
// unlike a convex hull, this follows concave/elongated shapes exactly,
// since it's built from the actual shared/unshared edges between plots,
// not an approximation.
function getBlockTrueOutline(blockId) {
  const block = blocksData[blockId];
  if (!block || !block.plot_ids) return null;

  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const edgeCount = new Map();
  const edgeList = [];

  block.plot_ids.forEach((pid) => {
    const plot = plotsData[pid];
    if (!plot || !plot.polygon) return;
    const poly = plot.polygon;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const k1 = key(a[0], a[1]) + "|" + key(b[0], b[1]);
      const k2 = key(b[0], b[1]) + "|" + key(a[0], a[1]);
      const canonical = k1 < k2 ? k1 : k2;
      if (edgeCount.has(canonical)) {
        edgeCount.set(canonical, edgeCount.get(canonical) + 1);
      } else {
        edgeCount.set(canonical, 1);
        edgeList.push({ canonical, a, b });
      }
    }
  });

  const boundaryEdges = edgeList.filter((e) => edgeCount.get(e.canonical) === 1);
  if (boundaryEdges.length < 3) return null;

  const TOLERANCE = 3; // units — bridges small numeric gaps between adjacent plots
  const used = new Array(boundaryEdges.length).fill(false);

  function traceLoopFrom(startIdx) {
    const loop = [boundaryEdges[startIdx].a, boundaryEdges[startIdx].b];
    used[startIdx] = true;
    let safety = boundaryEdges.length * 2;
    while (safety-- > 0) {
      const tail = loop[loop.length - 1];
      let bestDist = TOLERANCE,
        bestIdx = -1,
        bestPoint = null;
      for (let i = 0; i < boundaryEdges.length; i++) {
        if (used[i]) continue;
        const e = boundaryEdges[i];
        const dA = Math.hypot(e.a[0] - tail[0], e.a[1] - tail[1]);
        const dB = Math.hypot(e.b[0] - tail[0], e.b[1] - tail[1]);
        if (dA < bestDist) {
          bestDist = dA;
          bestIdx = i;
          bestPoint = e.b;
        }
        if (dB < bestDist) {
          bestDist = dB;
          bestIdx = i;
          bestPoint = e.a;
        }
      }
      if (bestIdx === -1) break;
      loop.push(bestPoint);
      used[bestIdx] = true;
    }
    return loop;
  }

  function loopArea(loop) {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = loop[i];
      const [x2, y2] = loop[(i + 1) % loop.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  }

  // A block's plots aren't always fully edge-connected to every neighbor
  // (a real geometry gap around one plot is possible) — that splits the
  // boundary into more than one closed loop. Trace every loop and use
  // whichever encloses the most area as the block's true main silhouette,
  // rather than the first (possibly small/wrong) one found.
  const loops = [];
  for (let i = 0; i < boundaryEdges.length; i++) {
    if (used[i]) continue;
    loops.push(traceLoopFrom(i));
  }
  if (loops.length === 0) return null;
  const path = loops.reduce((best, l) => (loopArea(l) > loopArea(best) ? l : best));

  // A genuinely closed loop must connect back to its own starting point —
  // otherwise this is an open chain that happened to stop extending, and
  // drawing it as a polygon would auto-close with an incorrect straight
  // line across the block. Reject and let the caller fall back to the hull.
  const closureGap = Math.hypot(path[0][0] - path[path.length - 1][0], path[0][1] - path[path.length - 1][1]);
  if (closureGap > TOLERANCE) return null;
  return path;
}

function highlightBlockOnMap(blockId) {
  clearPlotHighlight();
  const block = blocksData[blockId];
  const outline = getBlockRasterOutline(blockId) || getBlockTrueOutline(blockId) || getBlockTightHull(blockId);
  if (!block || !outline) return;
  const el = document.createElementNS(SVG_NS, "polygon");
  el.setAttribute("points", pointsToAttr(outline));
  el.classList.add("block-select-outline");
  if (block.sale_type === "كامل" && block.status === "مباع") {
    el.classList.add("is-sold-selected");
  }
  document.getElementById("status-overlay-layer").appendChild(el);
}


function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

function buildInterestBtn(message, label, analyticsType, analyticsId) {
  const rep = getActiveRep();
  const url = `https://wa.me/${rep.phone}?text=${encodeURIComponent(message)}`;
  return `<a class="modal-action modal-action-interest" href="${url}" target="_blank" rel="noopener"
      data-analytics-type="${analyticsType}" data-analytics-id="${analyticsId}" data-analytics-rep="${rep.name}">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38a9.9 9.9 0 0 0 4.74 1.21h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2Zm5.8 14.1c-.24.68-1.4 1.3-1.94 1.38-.5.08-1.11.11-1.79-.11-.41-.13-.94-.31-1.61-.6-2.84-1.23-4.69-4.09-4.83-4.28-.14-.19-1.15-1.53-1.15-2.92 0-1.39.73-2.07.99-2.35.26-.28.57-.35.76-.35.19 0 .38 0 .55.01.18.01.41-.07.64.49.24.58.81 2 .88 2.14.07.14.12.31.02.5-.09.19-.14.31-.28.48-.14.17-.29.37-.42.5-.14.14-.28.29-.12.57.16.28.72 1.19 1.55 1.93 1.06.95 1.96 1.24 2.24 1.38.28.14.44.12.61-.07.16-.19.7-.81.89-1.09.19-.28.37-.23.63-.14.26.1 1.65.78 1.94.92.28.14.47.21.54.33.07.12.07.68-.17 1.36Z"/></svg>
      ${label}
    </a>`;
}

function buildPlotModalHTML(plotId, plot) {
  const mapsBtn =
    plot.lat != null && plot.lng != null
      ? `<a class="modal-action modal-action-maps" href="https://www.google.com/maps?q=${plot.lat},${plot.lng}" target="_blank" rel="noopener">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>
           فتح الموقع في خرائط جوجل
         </a>`
      : "";

  const parentBlock = blocksData[plot.block];
  const isByPlotBlock = parentBlock && parentBlock.sale_type === "بالقطعة";
  const isInSoldWholeBlock =
    parentBlock && parentBlock.sale_type === "كامل" && parentBlock.status === "مباع";
  const isInAvailableWholeBlock =
    parentBlock && parentBlock.sale_type === "كامل" && parentBlock.status === "متاح";

  const interestBtn =
    isByPlotBlock && plot.status === "متاحة"
      ? buildInterestBtn(`مرحباً، أنا مهتم بقطعة رقم ${plot.plot}، بلوك ${plot.block}، مساحة ${formatNumber(plot.area)} م²، من مخطط العليا هيلز.`, "أنا مهتم بهذي القطعة", "plot", `${plot.block}__${plot.plot}`)
      : "";

  const soldBanner =
    plot.status === "مباعة"
      ? `<div class="sold-banner"><span class="dot"></span>مباعة</div>`
      : isInSoldWholeBlock
        ? `<div class="sold-banner"><span class="dot"></span>هذه القطعة ضمن بلوك مباع بالكامل</div>`
        : "";

  const notIndividualNote =
    isInAvailableWholeBlock && plot.status !== "مباعة"
      ? `<div class="info-note">هذه القطعة ضمن بلوك يُباع بالكامل ولا تُباع بشكل منفرد.</div>`
      : "";

  return `
    ${soldBanner}
    <span class="badge usage-${plot.usage}">${plot.usage}</span>
    <h2 class="modal-title">قطعة ${plot.plot}</h2>
    <p class="modal-subtitle">داخل بلوك ${plot.block}</p>

    <div class="modal-stats modal-stats-single">
      <div>
        <p class="modal-stat-label">المساحة</p>
        <p class="modal-stat-value modal-stat-value-lg">${formatNumber(plot.area)} م²</p>
      </div>
    </div>
    ${notIndividualNote}

    <button class="modal-action" id="view-block-btn" data-block-id="${plot.block}">
      عرض تفاصيل البلوك
    </button>
    ${interestBtn}
    ${mapsBtn}
  `;
}

function buildBlockModalHTML(blockId, block) {
  const mapsBtn =
    block.lat != null && block.lng != null
      ? `<a class="modal-action modal-action-maps" href="https://www.google.com/maps?q=${block.lat},${block.lng}" target="_blank" rel="noopener">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>
           فتح الموقع في خرائط جوجل
         </a>`
      : "";

  const rows = block.plot_ids
    .map((pid) => {
      const p = plotsData[pid];
      const rowStatus = p.status
        ? `<span class="status-pill ${p.status === "متاحة" ? "status-available" : "status-sold"}" style="padding:2px 8px;font-size:11px;">${p.status}</span>`
        : "";
      return `
      <tr class="modal-table-row" data-plot-id="${pid}">
        <td>${p.plot}</td>
        <td>${formatNumber(p.area)} م²</td>
        <td>${rowStatus}</td>
      </tr>`;
    })
    .join("");

  const isByPlot = block.sale_type === "بالقطعة";
  const hasAnyPlotStatus = block.plot_ids.some((pid) => plotsData[pid] && plotsData[pid].status);
  const soldBanner =
    !isByPlot && block.status === "مباع"
      ? `<div class="sold-banner"><span class="dot"></span>البلوك مباع بالكامل</div>`
      : "";
  const extraCol = isByPlot || hasAnyPlotStatus ? "<th></th>" : "";

  return `
    ${soldBanner}
    <span class="badge usage-${block.usage}">${block.usage}</span>
    <h2 class="modal-title">بلوك ${blockId}</h2>
    <p class="modal-subtitle">تفاصيل القطع داخل هذا البلوك</p>
    <p class="sale-type-line">نوع البيع: ${isByPlot ? "يُباع بالقطعة" : "يُباع كاملاً"}</p>

    <div class="modal-stats">
      <div>
        <p class="modal-stat-label">عدد القطع</p>
        <p class="modal-stat-value">${block.plot_count}</p>
      </div>
      <div>
        <p class="modal-stat-label">إجمالي المساحة</p>
        <p class="modal-stat-value">${formatNumber(block.total_area)} م²</p>
      </div>
    </div>

    <div class="modal-table-wrap">
      <table class="modal-table">
        <thead>
          <tr>
            <th>رقم القطعة</th>
            <th>المساحة</th>
            ${extraCol}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${!isByPlot && block.status === "متاح" ? buildInterestBtn(`مرحباً، أنا مهتم ببلوك رقم ${blockId} كامل، مساحة ${formatNumber(block.total_area)} م²، من مخطط العليا هيلز.`, "أنا مهتم بهذا البلوك", "block", blockId) : ""}
    ${mapsBtn}
  `;
}

function buildFacilityModalHTML(blockId, block) {
  const mapsBtn =
    block.lat != null && block.lng != null
      ? `<a class="modal-action modal-action-maps" href="https://www.google.com/maps?q=${block.lat},${block.lng}" target="_blank" rel="noopener">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 6-9 12-9 12s-9-6-9-12a9 9 0 0 1 18 0Z"/><circle cx="12" cy="10" r="3"/></svg>
           فتح الموقع في خرائط جوجل
         </a>`
      : "";

  return `
    <span class="badge usage-facility">مرفق</span>
    <h2 class="modal-title">${block.name}</h2>
    <p class="modal-subtitle">بلوك رقم ${blockId}</p>

    <div class="modal-stats">
      <div>
        <p class="modal-stat-label">اسم المرفق</p>
        <p class="modal-stat-value">${block.name}</p>
      </div>
      <div>
        <p class="modal-stat-label">النوع</p>
        <p class="modal-stat-value">مرفق خدمي</p>
      </div>
      <div>
        <p class="modal-stat-label">الحالة</p>
        <p class="modal-stat-value">غير معروض للبيع</p>
      </div>
    </div>
    ${mapsBtn}
  `;
}

/* ---------------- Modal open/close ---------------- */

function openPlotModal(plotId) {
  const plot = plotsData[plotId];
  if (!plot) return;

  highlightPlotOnMap(plotId);

  const body = document.getElementById("modal-body");
  body.innerHTML = buildPlotModalHTML(plotId, plot);
  document.getElementById("view-block-btn").addEventListener("click", () => {
    openBlockModal(plot.block);
  });

  openModalBackdrop();
}

function openBlockModal(blockId) {
  const block = blocksData[blockId];
  if (!block || block.type !== "block") return;

  highlightBlockOnMap(blockId);

  const body = document.getElementById("modal-body");
  body.innerHTML = buildBlockModalHTML(blockId, block);
  body.querySelectorAll(".modal-table-row[data-plot-id]").forEach((row) => {
    row.addEventListener("click", () => openPlotModal(row.getAttribute("data-plot-id")));
  });
  openModalBackdrop();
}

function openFacilityModal(blockId) {
  const block = blocksData[blockId];
  if (!block || block.type !== "facility") return;

  clearPlotHighlight();

  const body = document.getElementById("modal-body");
  body.innerHTML = buildFacilityModalHTML(blockId, block);
  openModalBackdrop();
}

// On mobile, a user who pinches in to zoom for an accurate tap, then taps
// a plot/block, ends up with the modal opening in the page's ORIGINAL
// (un-zoomed) layout position — which is now scrolled out of their
// zoomed-in view. It looks like "nothing happened" until they zoom back
// out. The reliable fix (this is the standard trick for this exact iOS
// Safari/Chrome quirk) is to force the browser's pinch-zoom back to 1.0
// right before the modal shows, by briefly tightening the viewport meta
// tag's max scale and then restoring it. This guarantees the modal is
// always shown in a predictable, fully-visible position — regardless of
// whatever zoom level the user was at.
function openModalBackdrop() {
  const backdrop = document.getElementById("modal-backdrop");
  backdrop.classList.add("is-open");
  // Force a synchronous style flush so the browser commits the "closed"
  // (pre-transition) state before "is-visible" is added — otherwise the
  // display and opacity/transform changes can get batched into a single
  // paint and the transition never visibly plays.
  void backdrop.offsetHeight;
  backdrop.classList.add("is-visible");
}

function closeModal() {
  const backdrop = document.getElementById("modal-backdrop");
  backdrop.classList.remove("is-visible");
  window.setTimeout(() => {
    backdrop.classList.remove("is-open");
  }, 200);
}

function attachDebugToggle() {
  // Internal QA tool only — hidden from every normal visitor. Add ?debug=1
  // to the URL to reveal it (e.g. https://.../?debug=1).
  const params = new URLSearchParams(window.location.search);
  if (params.get("debug") !== "1") return;

  const btn = document.createElement("button");
  btn.id = "debug-toggle";
  btn.className = "debug-toggle-btn";
  btn.textContent = "تفعيل وضع Debug";
  document.body.appendChild(btn);

  btn.addEventListener("click", () => {
    const isOn = document.body.classList.toggle("debug-mode");
    btn.classList.toggle("is-active", isOn);
    btn.textContent = isOn ? "إيقاف وضع Debug" : "تفعيل وضع Debug";
  });
}

/* ---------------- Direct search (plot / block / facility lookup) ----------
   Fully self-contained: builds its own index from blocksData/plotsData
   (already loaded by loadData) and only calls the existing
   openPlotModal / openBlockModal / openFacilityModal functions above.
   Does not touch rendering, hover, or click logic on the map itself. ---- */

let searchIndex = [];

function buildSearchIndex() {
  searchIndex = [];

  Object.entries(plotsData).forEach(([plotId, plot]) => {
    searchIndex.push({
      type: "plot",
      id: plotId,
      // numeric key used for "starts with" matching on the number itself
      number: plot.plot,
      main: `قطعة ${plot.plot}`,
      sub: `بلوك ${plot.block}`,
    });
  });

  Object.entries(blocksData).forEach(([blockId, block]) => {
    if (block.type === "block") {
      searchIndex.push({
        type: "block",
        id: blockId,
        number: blockId,
        main: `بلوك ${blockId}`,
        sub: `${block.usage} — ${block.plot_count} قطعة`,
      });
    } else if (block.type === "facility") {
      searchIndex.push({
        type: "facility",
        id: blockId,
        number: blockId,
        main: block.name,
        sub: `بلوك ${blockId}`,
      });
    }
  });
}

function searchMatch(query) {
  const q = query.trim();
  if (!q) return [];

  const isDigits = /^\d+$/.test(q);
  const results = [];

  for (const item of searchIndex) {
    let hit = false;
    if (isDigits) {
      // numeric query: match plot/block numbers that START WITH the digits
      // (most useful — typing "25" finds plot 25, 250-259, block 25...)
      hit = item.number.startsWith(q);
    } else {
      // text query: match facility names or "block"/"plot" containing it
      hit = item.main.includes(q) || item.sub.includes(q);
    }
    if (hit) results.push(item);
  }

  // Exact number matches first, then shorter (closer) matches, then the rest
  results.sort((a, b) => {
    const aExact = a.number === q ? 0 : 1;
    const bExact = b.number === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.number.length - b.number.length;
  });

  return results.slice(0, 8);
}

function renderSearchResults(results) {
  const list = document.getElementById("search-results");
  list.innerHTML = "";

  if (results.length === 0) {
    list.hidden = false;
    list.innerHTML = `<li class="search-result-empty">لا توجد نتائج مطابقة</li>`;
    return;
  }

  results.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "search-result-item" + (i === 0 ? " is-active" : "");
    li.setAttribute("data-type", item.type);
    li.setAttribute("data-id", item.id);
    li.innerHTML = `
      <span class="search-result-main">${item.main}</span>
      <span class="search-result-sub">${item.sub}</span>
    `;
    list.appendChild(li);
  });

  list.hidden = false;
}

function openSearchResult(item) {
  if (item.type === "plot") openPlotModal(item.id);
  else if (item.type === "block") openBlockModal(item.id);
  else if (item.type === "facility") openFacilityModal(item.id);
}

function attachSearch() {
  buildSearchIndex();

  const input = document.getElementById("search-input");
  const clearBtn = document.getElementById("search-clear");
  const list = document.getElementById("search-results");

  function closeResults() {
    list.hidden = true;
    list.innerHTML = "";
  }

  input.addEventListener("input", () => {
    const q = input.value;
    clearBtn.hidden = q.length === 0;
    if (q.trim() === "") {
      closeResults();
      return;
    }
    renderSearchResults(searchMatch(q));
  });

  input.addEventListener("focus", () => {
    if (input.value.trim() !== "") renderSearchResults(searchMatch(input.value));
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = list.querySelector(".search-result-item[data-id]");
      if (first) {
        openSearchResult({ type: first.getAttribute("data-type"), id: first.getAttribute("data-id") });
        input.blur();
        closeResults();
      }
    } else if (e.key === "Escape") {
      input.blur();
      closeResults();
    }
  });

  list.addEventListener("click", (e) => {
    const row = e.target.closest(".search-result-item[data-id]");
    if (!row) return;
    openSearchResult({ type: row.getAttribute("data-type"), id: row.getAttribute("data-id") });
    input.value = "";
    clearBtn.hidden = true;
    closeResults();
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    closeResults();
    input.focus();
  });

  // tapping outside the search bar closes the results dropdown
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#search-bar")) closeResults();
  });
}

/* ---------------- Stats bar (counts + click-to-highlight) ---------------- */

let activeStatsFilter = null;

function computeStatsCounts() {
  let blocksAvailable = 0,
    blocksSold = 0,
    plotsAvailable = 0,
    residentialAvailable = 0,
    commercialAvailable = 0,
    eduAvailable = 0,
    eduSold = 0,
    plotLevelSold = 0,
    plotLevelAvailable = 0;

  Object.values(blocksData).forEach((block) => {
    if (block.type !== "block") return;
    if (block.sale_type === "كامل") {
      if (block.status === "متاح") {
        blocksAvailable++;
        if (block.usage === "سكني") residentialAvailable++;
        else if (block.usage === "تجاري") commercialAvailable++;
        else if (block.usage === "تعليمية/خدمية") eduAvailable++;
      } else if (block.status === "مباع") {
        blocksSold++;
        if (block.usage === "تعليمية/خدمية") eduSold++;
      }
    }
  });

  Object.values(plotsData).forEach((plot) => {
    if (plot.status === "متاحة") plotsAvailable++;
  });

  // نسبة المباع (المعتمدة): تُحسب على مستوى القطعة الفردية، سكني وتجاري
  // فقط — الوحدات التعليمية/الخدمية مستبعدة. لبلوكات "كامل"، القطعة ترث
  // حالة البلوك ما لم يكن لها status صريح خاص بها (استثناء نادر).
  Object.entries(plotsData).forEach(([pid, plot]) => {
    const block = blocksData[plot.block];
    if (!block || block.usage === "تعليمية/خدمية") return;
    if (block.sale_type === "بالقطعة") {
      if (plot.status === "مباعة") plotLevelSold++;
      else if (plot.status === "متاحة") plotLevelAvailable++;
    } else if (block.sale_type === "كامل") {
      if (plot.status === "مباعة") plotLevelSold++;
      else if (plot.status === "متاحة") plotLevelAvailable++;
      else if (block.status === "مباع") plotLevelSold++;
      else if (block.status === "متاح") plotLevelAvailable++;
    }
  });

  return {
    blocksAvailable,
    blocksSold,
    plotsAvailable,
    residentialAvailable,
    commercialAvailable,
    eduAvailable,
    eduSold,
    plotLevelSold,
    plotLevelAvailable,
  };
}

// Smooth ease-out count-up (0 → target) — plays once on load, ~900ms,
// so the stats bar feels alive on first paint without being showy.
function animateCountUp(el, target, duration = 900, suffix = "") {
  const start = performance.now();
  function tick(now) {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const value = Math.round(target * eased);
    el.textContent = value + suffix;
    if (t < 1) requestAnimationFrame(tick);
    else el.textContent = target + suffix;
  }
  requestAnimationFrame(tick);
}

function renderStatsCounts() {
  const c = computeStatsCounts();
  animateCountUp(document.getElementById("count-blocks-sold"), c.blocksSold);
  animateCountUp(document.getElementById("count-plots-available"), c.plotsAvailable);
  animateCountUp(document.getElementById("count-residential-available"), c.residentialAvailable);
  animateCountUp(document.getElementById("count-commercial-available"), c.commercialAvailable);
  animateCountUp(document.getElementById("count-edu-available"), c.eduAvailable);

  // نسبة المباع تُحسب على بلوكات "سكني/تجاري" فقط — الوحدات
  // التعليمية/الخدمية مستثناة عمداً من هالحسبة بناءً على طلب صريح.
  // نسبة المباع (المعتمدة): على مستوى القطعة الفردية، سكني وتجاري فقط —
  // النص المعروض للمستخدم "نسبة المباع" يبقى كما هو، تغيّرت فقط طريقة
  // الحساب من عدّ البلوكات إلى عدّ القطع.
  const pctSold = c.plotLevelSold;
  const pctTotal = c.plotLevelSold + c.plotLevelAvailable;
  const soldPct = pctTotal > 0 ? Math.round((pctSold / pctTotal) * 100) : 0;
  document.getElementById("stats-progress-fill").style.width = soldPct + "%";
  animateCountUp(document.getElementById("stats-progress-pct"), soldPct, 900, "%");
}

function renderPermanentStatus() {
  ensureFocusImagesLoaded();
  const dimClip = document.getElementById("focus-dim-clip");
  const boostClip = document.getElementById("focus-boost-clip");
  dimClip.innerHTML = "";
  boostClip.innerHTML = "";
  const dimFrag = document.createDocumentFragment();
  const boostFrag = document.createDocumentFragment();
  const outlineFrag = document.createDocumentFragment();
  const badgeRingFrag = document.createDocumentFragment();
  const outlineLayer = document.getElementById("status-overlay-layer");
  outlineLayer.innerHTML = "";

  function addShape(frag, poly) {
    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", pointsToAttr(poly));
    frag.appendChild(el);
  }

  Object.entries(blocksData).forEach(([blockId, block]) => {
    if (block.type !== "block") return;

    if (block.sale_type === "كامل") {
      const target = block.status === "مباع" ? dimFrag : block.status === "متاح" ? boostFrag : null;
      if (!target) return;
      block.plot_ids.forEach((pid) => {
        const plot = plotsData[pid];
        if (!plot || !plot.polygon) return;
        // A plot's own explicit status (rare exception: individually sold
        // within an otherwise whole-sale block) always wins over the
        // block-level default.
        if (plot.status === "مباعة") addShape(dimFrag, plot.polygon);
        else if (plot.status === "متاحة") addShape(boostFrag, plot.polygon);
        else addShape(target, plot.polygon);
      });
    } else if (block.sale_type === "بالقطعة") {
      if (block.centroid) {
        const realRadius = block.badge_radius || BADGE_RADIUS;
        // A small purple dot INSIDE the original badge circle, just to the
        // right of the block number — the circle and number stay 100%
        // untouched, this just adds a small classification mark fused
        // into the badge itself. Sized and positioned with a verified
        // safety margin so it never reaches the circle's true edge.
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", block.centroid[0] + realRadius * 0.34);
        dot.setAttribute("cy", block.centroid[1]);
        dot.setAttribute("r", 3.0);
        dot.classList.add("by-plot-badge-dot");
        badgeRingFrag.appendChild(dot);
      }
      block.plot_ids.forEach((pid) => {
        const plot = plotsData[pid];
        if (!plot || !plot.polygon) return;
        if (plot.status === "مباعة") addShape(dimFrag, plot.polygon);
        else if (plot.status === "متاحة") addShape(boostFrag, plot.polygon);
      });
    }
  });

  dimClip.appendChild(dimFrag);
  boostClip.appendChild(boostFrag);
  outlineLayer.appendChild(outlineFrag);
  const ringLayer = document.getElementById("badge-ring-layer");
  ringLayer.innerHTML = "";
  ringLayer.appendChild(badgeRingFrag);
  document.body.classList.add("filters-active");
}

let focusImagesLoaded = false;
function ensureFocusImagesLoaded() {
  if (focusImagesLoaded) return;
  focusImagesLoaded = true;
  document.getElementById("focus-dim-image").setAttribute("href", "map-background-dim.webp");
  document.getElementById("focus-boost-image").setAttribute("href", "map-background-boost.webp");
}

function attachStatsBar() {
  renderStatsCounts();
}

function attachAnalyticsTracking() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".modal-action-interest");
    if (!btn || typeof gtag !== "function") return;
    gtag("event", "interest_click", {
      item_type: btn.getAttribute("data-analytics-type"),
      item_id: btn.getAttribute("data-analytics-id"),
      rep: btn.getAttribute("data-analytics-rep"),
    });
  });
}

// Custom zoom/pan for the map, replacing native browser pinch-zoom.
//
// Why: iOS Safari (and to a lesser extent Chrome/Android) has a long-
// standing, version-dependent quirk where `position: fixed` elements
// (our modal) don't reliably reposition after the user pinch-zooms the
// PAGE itself — the modal can open fully outside the zoomed-in area,
// looking like nothing happened. This is a native-browser-zoom problem,
// so the only fully reliable fix is to never let the browser itself zoom
// at all (see the viewport meta tag: user-scalable=no) and instead scale
// only our own map content via a CSS transform. Since the browser's own
// zoom level is now always 1, `position: fixed` behaves perfectly
// predictably for the modal, on every device, every time.
function attachCustomZoom() {
  const viewport = document.getElementById("map-zoom-viewport");
  const inner = document.getElementById("map-zoom-inner");
  const zoomInBtn = document.getElementById("zoom-in-btn");
  const zoomOutBtn = document.getElementById("zoom-out-btn");
  const resetBtn = document.getElementById("zoom-reset-btn");
  if (!viewport || !inner) return;

  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  let scale = 1;
  let tx = 0;
  let ty = 0;

  function apply() {
    inner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clampPan() {
    // keep the zoomed content from being dragged completely off-screen
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const contentW = vw * scale;
    const contentH = vh * scale;
    const minTx = Math.min(0, vw - contentW);
    const minTy = Math.min(0, vh - contentH);
    tx = Math.max(minTx, Math.min(0, tx));
    ty = Math.max(minTy, Math.min(0, ty));
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    if (newScale === scale) return;
    const ratio = newScale / scale;
    tx = px - (px - tx) * ratio;
    ty = py - (py - ty) * ratio;
    scale = newScale;
    if (scale === MIN_SCALE) {
      tx = 0;
      ty = 0;
    }
    clampPan();
    apply();
  }

  // ---- touch: pinch to zoom, single-finger drag to pan ----
  let pinchStartDist = null;
  let pinchStartScale = 1;
  let panStart = null;
  let touchMoved = false;

  function dist(t1, t2) {
    return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
  }

  viewport.addEventListener(
    "touchstart",
    (e) => {
      touchMoved = false;
      if (e.touches.length === 2) {
        pinchStartDist = dist(e.touches[0], e.touches[1]);
        pinchStartScale = scale;
      } else if (e.touches.length === 1 && scale > MIN_SCALE) {
        panStart = { x: e.touches[0].clientX - tx, y: e.touches[0].clientY - ty };
      }
    },
    { passive: true }
  );

  viewport.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        e.preventDefault();
        touchMoved = true;
        const newDist = dist(e.touches[0], e.touches[1]);
        const factor = newDist / pinchStartDist;
        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
        scale = pinchStartScale; // reset so zoomAt's relative factor is accurate
        zoomAt(midX, midY, factor);
      } else if (e.touches.length === 1 && panStart) {
        const dx = e.touches[0].clientX - panStart.x - tx;
        const dy = e.touches[0].clientY - panStart.y - ty;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) touchMoved = true;
        if (touchMoved) {
          e.preventDefault();
          tx = e.touches[0].clientX - panStart.x;
          ty = e.touches[0].clientY - panStart.y;
          clampPan();
          apply();
        }
      }
    },
    { passive: false }
  );

  viewport.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length === 0) {
        pinchStartDist = null;
        panStart = null;
      }
    },
    { passive: true }
  );

  // ---- buttons: work everywhere, including mouse/desktop ----
  if (zoomInBtn) {
    zoomInBtn.addEventListener("click", () => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.4);
    });
  }
  if (zoomOutBtn) {
    zoomOutBtn.addEventListener("click", () => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.4);
    });
  }
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    });
  }

  // ---- desktop: mouse wheel to zoom ----
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false }
  );
}

async function init() {
  await loadData();
  renderBlockOutlines();
  renderFacilities();
  renderPlots();
  renderBadges();
  renderPermanentStatus();
  attachInteractions();
  attachDebugToggle();
  attachSearch();
  attachStatsBar();
  attachAnalyticsTracking();
  attachCustomZoom();
  window.dispatchEvent(new Event("olaya-map-ready"));
}

init();
