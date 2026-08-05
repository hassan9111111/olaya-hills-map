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
  const DEFAULT_CORE_RADIUS = 6; // matches the printed circle's real visual size

  for (const [blockId, block] of Object.entries(blocksData)) {
    if (block.type === "block" && block.centroid) {
      const coreR = BADGE_CORE_RADIUS_OVERRIDES[blockId] ?? DEFAULT_CORE_RADIUS;
      if (pointInCircle(svgX, svgY, block.centroid[0], block.centroid[1], coreR)) {
        return { type: "block", id: blockId };
      }
    }
  }

  for (const [plotId, plot] of Object.entries(plotsData)) {
    if (plot.polygon && pointInPolygon(svgX, svgY, plot.polygon)) {
      return { type: "plot", id: plotId };
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

function highlightBlockOnMap(blockId) {
  clearPlotHighlight();
  const block = blocksData[blockId];
  const hull = getBlockTightHull(blockId);
  if (!block || !hull) return;
  const el = document.createElementNS(SVG_NS, "polygon");
  el.setAttribute("points", pointsToAttr(hull));
  el.classList.add("block-select-outline");
  if (block.sale_type === "كامل" && block.status === "مباع") {
    el.classList.add("is-sold-selected");
  }
  document.getElementById("status-overlay-layer").appendChild(el);
}


function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
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
  const isInSoldWholeBlock =
    parentBlock && parentBlock.sale_type === "كامل" && parentBlock.status === "مباع";

  const soldBanner =
    plot.status === "مباعة"
      ? `<div class="sold-banner"><span class="dot"></span>مباعة</div>`
      : isInSoldWholeBlock
        ? `<div class="sold-banner"><span class="dot"></span>هذه القطعة ضمن بلوك مباع بالكامل</div>`
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

    <button class="modal-action" id="view-block-btn" data-block-id="${plot.block}">
      عرض تفاصيل البلوك
    </button>
    ${mapsBtn}
  `;
}

function buildBlockModalHTML(blockId, block) {
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
  const soldBanner =
    !isByPlot && block.status === "مباع"
      ? `<div class="sold-banner"><span class="dot"></span>البلوك مباع بالكامل</div>`
      : "";
  const extraCol = isByPlot ? "<th></th>" : "";

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
  `;
}

function buildFacilityModalHTML(blockId, block) {
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
    plotsAvailable = 0;

  Object.values(blocksData).forEach((block) => {
    if (block.type !== "block") return;
    if (block.sale_type === "كامل") {
      if (block.status === "متاح") blocksAvailable++;
      else if (block.status === "مباع") blocksSold++;
    }
  });

  Object.values(plotsData).forEach((plot) => {
    if (plot.status === "متاحة") plotsAvailable++;
  });

  return { blocksAvailable, blocksSold, plotsAvailable };
}

function renderStatsCounts() {
  const c = computeStatsCounts();
  document.getElementById("count-blocks-available").textContent = c.blocksAvailable;
  document.getElementById("count-blocks-sold").textContent = c.blocksSold;
  document.getElementById("count-plots-available").textContent = c.plotsAvailable;

  const totalWholeSale = c.blocksAvailable + c.blocksSold;
  const soldPct = totalWholeSale > 0 ? Math.round((c.blocksSold / totalWholeSale) * 100) : 0;
  document.getElementById("stats-progress-fill").style.width = soldPct + "%";
  document.getElementById("stats-progress-pct").textContent = soldPct + "%";
}

const FILTER_LABELS = {
  "blocks-available": "يعرض الآن: حالة البلوكات — متاح مقابل مباع",
  "plots-available": "يعرض الآن: القطع المتاحة ضمن بلوكات البيع بالقطعة",
};

function clearStatsFilter() {
  activeStatsFilter = null;
  document.getElementById("filter-overlay-layer").innerHTML = "";
  document.getElementById("focus-dim-clip").innerHTML = "";
  document.getElementById("focus-boost-clip").innerHTML = "";
  document.querySelectorAll(".stats-card").forEach((c) => c.classList.remove("is-active"));
  document.getElementById("filter-label").classList.remove("is-active");
  document.getElementById("map-hint").style.display = "";
}

function applyStatsFilter(filterKey) {
  const layer = document.getElementById("filter-overlay-layer");
  layer.innerHTML = "";
  const clipPath = document.getElementById("focus-dim-clip");
  clipPath.innerHTML = "";
  const boostClipPath = document.getElementById("focus-boost-clip");
  boostClipPath.innerHTML = "";
  const fragment = document.createDocumentFragment();
  const clipFragment = document.createDocumentFragment();
  const boostClipFragment = document.createDocumentFragment();

  // Cinematic "out of focus" effect: elements NOT matching the filter stay
  // fully visible in structure, but render through a desaturated + slightly
  // darkened copy of the same background (the clip-path below controls
  // exactly which real, click-verified plot shapes get that treatment) —
  // plus a very light overlay for a touch of extra depth. Matching elements
  // get the symmetric opposite treatment (richer color, brighter) so they
  // genuinely pop forward instead of just being "left alone".
  function dimPolygon(poly) {
    const pts = pointsToAttr(poly);

    const clipShape = document.createElementNS(SVG_NS, "polygon");
    clipShape.setAttribute("points", pts);
    clipFragment.appendChild(clipShape);

    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", pts);
    el.classList.add("dim-overlay");
    fragment.appendChild(el);
  }
  function boostPolygon(poly) {
    const el = document.createElementNS(SVG_NS, "polygon");
    el.setAttribute("points", pointsToAttr(poly));
    boostClipFragment.appendChild(el);
  }
  function dimBlockByPlots(block) {
    block.plot_ids.forEach((pid) => {
      const plot = plotsData[pid];
      if (plot && plot.polygon) dimPolygon(plot.polygon);
    });
  }
  function boostBlockByPlots(block) {
    block.plot_ids.forEach((pid) => {
      const plot = plotsData[pid];
      if (plot && plot.polygon) boostPolygon(plot.polygon);
    });
  }

  if (filterKey === "blocks-available" || filterKey === "blocks-sold") {
    const wantStatus = filterKey === "blocks-available" ? "متاح" : "مباع";
    Object.entries(blocksData).forEach(([blockId, block]) => {
      if (block.type === "block" && block.sale_type === "كامل") {
        if (block.status === wantStatus) {
          boostBlockByPlots(block);
        } else {
          dimBlockByPlots(block);
        }
      } else if (block.type === "block" && block.sale_type === "بالقطعة") {
        dimBlockByPlots(block);
      } else if (block.type === "facility" && block.polygon) {
        dimPolygon(block.polygon); // facility shapes are already accurate, real click-verified boundaries
      }
    });
  } else if (filterKey === "plots-available") {
    Object.entries(blocksData).forEach(([blockId, block]) => {
      if (block.type === "block" && block.sale_type === "كامل") {
        dimBlockByPlots(block);
      } else if (block.type === "block" && block.sale_type === "بالقطعة") {
        // The block itself stays in full focus — but within it, sold plots
        // fall out of focus individually too, so "which plots are actually
        // available" is answered right here, without a click per plot.
        block.plot_ids.forEach((pid) => {
          const plot = plotsData[pid];
          if (!plot || !plot.polygon) return;
          if (plot.status === "مباعة") dimPolygon(plot.polygon);
          else boostPolygon(plot.polygon);
        });
      } else if (block.type === "facility" && block.polygon) {
        dimPolygon(block.polygon);
      }
    });
  }

  clipPath.appendChild(clipFragment);
  boostClipPath.appendChild(boostClipFragment);
  layer.appendChild(fragment);
}

function attachStatsBar() {
  renderStatsCounts();

  document.querySelectorAll(".stats-card").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.getAttribute("data-filter");
      if (activeStatsFilter === key) {
        clearStatsFilter();
        return;
      }
      clearStatsFilter();
      activeStatsFilter = key;
      card.classList.add("is-active");
      applyStatsFilter(key);
      const label = document.getElementById("filter-label");
      label.textContent = FILTER_LABELS[key] || "";
      label.classList.add("is-active");
      document.getElementById("map-hint").style.display = "none";
    });
  });
}

async function init() {
  await loadData();
  renderBlockOutlines();
  renderFacilities();
  renderPlots();
  renderBadges();
  attachInteractions();
  attachDebugToggle();
  attachSearch();
  attachStatsBar();
  window.dispatchEvent(new Event("olaya-map-ready"));
}

init();
