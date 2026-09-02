/**
 * Olaya Hills Map — QA Validation Script
 * ----------------------------------------------------------------
 * Run this any time blocks-data.json or plots-data.json change,
 * BEFORE deploying, to catch data-integrity bugs automatically
 * instead of relying on manual clicking.
 *
 * Usage:
 *   node qa-validate.js
 *
 * Exit code 0  = all checks passed
 * Exit code 1  = one or more checks failed (see printed report)
 *
 * No dependencies — plain Node.js (v14+).
 */

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const blocksData = JSON.parse(fs.readFileSync(path.join(DIR, "blocks-data.json"), "utf8"));
const plotsData = JSON.parse(fs.readFileSync(path.join(DIR, "plots-data.json"), "utf8"));

let errors = [];
let warnings = [];

function fail(msg) {
  errors.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/* ---------- Geometry helpers ---------- */

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function bbox(poly) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function bboxOverlap(a, b) {
  return !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
}

// Sutherland-Hodgman convex polygon clipping -> true intersection area
function clip(subject, clipPoly) {
  function signedArea(poly) {
    let s = 0;
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      s += x1 * y2 - x2 * y1;
    }
    return s / 2;
  }
  function inside(p, a, b) {
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  }
  function intersect(p1, p2, a, b) {
    const A1 = b[1] - a[1], B1 = a[0] - b[0], C1 = A1 * a[0] + B1 * a[1];
    const A2 = p2[1] - p1[1], B2 = p1[0] - p2[0], C2 = A2 * p1[0] + B2 * p1[1];
    const det = A1 * B2 - A2 * B1;
    if (Math.abs(det) < 1e-9) return p2;
    return [(B2 * C1 - B1 * C2) / det, (A1 * C2 - A2 * C1) / det];
  }
  let output = subject;
  let cp = clipPoly;
  if (signedArea(cp) < 0) cp = [...cp].reverse();
  for (let i = 0; i < cp.length; i++) {
    if (output.length === 0) break;
    const a = cp[i], b = cp[(i + 1) % cp.length];
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j], prev = input[(j - 1 + input.length) % input.length];
      const curIn = inside(cur, a, b), prevIn = inside(prev, a, b);
      if (curIn) {
        if (!prevIn) output.push(intersect(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(intersect(prev, cur, a, b));
      }
    }
  }
  return output;
}

function overlapFraction(p1, p2) {
  if (!bboxOverlap(bbox(p1), bbox(p2))) return 0;
  const inter = clip(p1, p2);
  if (inter.length < 3) return 0;
  const ia = polyArea(inter);
  const a1 = polyArea(p1), a2 = polyArea(p2);
  return ia / Math.min(a1, a2 || 1);
}

/* ---------- Check 1: every plot_id referenced by a block exists ---------- */
for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type !== "block") continue;
  for (const pid of block.plot_ids) {
    if (!plotsData[pid]) {
      fail(`Block ${blockId} references missing plot "${pid}"`);
    }
  }
}

/* ---------- Check 2: every plot points back to a block that lists it ---------- */
for (const [pid, plot] of Object.entries(plotsData)) {
  const block = blocksData[plot.block];
  if (!block) {
    fail(`Plot ${pid} references non-existent block "${plot.block}"`);
    continue;
  }
  if (!block.plot_ids || !block.plot_ids.includes(pid)) {
    fail(`Plot ${pid} claims block "${plot.block}", but that block's plot_ids does not include it`);
  }
}

/* ---------- Check 3: no plot_id is claimed by more than one block ---------- */
const plotOwner = {};
for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type !== "block") continue;
  for (const pid of block.plot_ids) {
    if (plotOwner[pid] && plotOwner[pid] !== blockId) {
      fail(`Plot ${pid} is claimed by both block ${plotOwner[pid]} and block ${blockId}`);
    }
    plotOwner[pid] = blockId;
  }
}

/* ---------- Check 4: every block has its full expected plot count ---------- */
for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type !== "block") continue;
  if (block.plot_ids.length !== block.plot_count) {
    fail(`Block ${blockId} says plot_count=${block.plot_count} but plot_ids has ${block.plot_ids.length} entries`);
  }
}

/* ---------- Check 5: every polygon is valid (>=3 points, non-degenerate area) ---------- */
function checkPolygon(label, poly) {
  if (poly === null) return; // not_extracted — honestly absent, not a bug
  if (!Array.isArray(poly) || poly.length < 3) {
    fail(`${label}: polygon has fewer than 3 points`);
    return;
  }
  for (const pt of poly) {
    if (
      !Array.isArray(pt) ||
      pt.length !== 2 ||
      typeof pt[0] !== "number" ||
      typeof pt[1] !== "number" ||
      Number.isNaN(pt[0]) ||
      Number.isNaN(pt[1])
    ) {
      fail(`${label}: malformed point ${JSON.stringify(pt)}`);
      return;
    }
  }
  const a = polyArea(poly);
  if (a < 5) {
    fail(`${label}: polygon area is near-zero (${a.toFixed(2)} pt²) — likely unclickable`);
  }
}

for (const [blockId, block] of Object.entries(blocksData)) {
  checkPolygon(`block ${blockId}`, block.polygon);
  // A block/facility with no polygon at all is allowed to also have no
  // centroid (nothing was extracted for it at all).
  if (block.polygon !== null && (!block.centroid || block.centroid.length !== 2)) {
    fail(`Block ${blockId} has a polygon but no valid centroid (badge position)`);
  }
}
for (const [pid, plot] of Object.entries(plotsData)) {
  checkPolygon(`plot ${pid}`, plot.polygon);
}

/* ---------- Check 6: no duplicate polygons (same shape used for two different elements) ---------- */
function polyKey(poly) {
  return poly
    .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
    .sort()
    .join("|");
}
const seenPolys = {};
for (const [pid, plot] of Object.entries(plotsData)) {
  if (plot.polygon === null) continue; // not_extracted
  const key = polyKey(plot.polygon);
  if (seenPolys[key]) {
    fail(`Duplicate polygon: ${pid} has the exact same shape as ${seenPolys[key]}`);
  }
  seenPolys[key] = pid;
}

/* ---------- Check 7: facility names are set and non-empty ---------- */
for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type === "facility" && (!block.name || block.name.trim() === "")) {
    fail(`Facility ${blockId} has no name`);
  }
}

/* ---------- Check 8: no plot-vs-plot geometric overlap within the same block ---------- */
const byBlock = {};
for (const [pid, plot] of Object.entries(plotsData)) {
  if (plot.polygon === null) continue; // not_extracted
  (byBlock[plot.block] = byBlock[plot.block] || []).push([pid, plot.polygon]);
}
for (const [blockId, items] of Object.entries(byBlock)) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const frac = overlapFraction(items[i][1], items[j][1]);
      if (frac > 0.08) {
        fail(`Plots ${items[i][0]} and ${items[j][0]} overlap geometrically (${(frac * 100).toFixed(0)}% of smaller plot) — one may swallow the other's clicks`);
      }
    }
  }
}

/* ---------- Check 9: no facility-vs-plot overlap ---------- */
const facilities = Object.entries(blocksData).filter(([, b]) => b.type === "facility" && b.polygon !== null);
for (const [fid, facility] of facilities) {
  for (const [pid, plot] of Object.entries(plotsData)) {
    if (plot.polygon === null) continue;
    const frac = overlapFraction(facility.polygon, plot.polygon);
    if (frac > 0.15) {
      fail(`Facility ${fid} overlaps plot ${pid} (${(frac * 100).toFixed(0)}%) — one may block clicks on the other`);
    }
  }
}

/* ---------- Check 9b: no facility-vs-facility overlap ---------- */
for (let i = 0; i < facilities.length; i++) {
  for (let j = i + 1; j < facilities.length; j++) {
    const [id1, f1] = facilities[i];
    const [id2, f2] = facilities[j];
    const frac = overlapFraction(f1.polygon, f2.polygon);
    if (frac > 0.02) {
      fail(`Facility ${id1} (${f1.name}) overlaps facility ${id2} (${f2.name}) (${(frac * 100).toFixed(0)}%) — clicking one may open the other`);
    }
  }
}

/* ---------- Check 9c: CLICK SIMULATION — every element's own centroid must
   resolve to itself and ONLY itself. This directly proves "click on X opens
   X's data", not just that shapes don't geometrically overlap. ---------- */
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Build the full clickable element list exactly as the app renders it:
// facilities-layer, then plots-layer, then badges-layer (later = on top).
const clickableLayers = [];
for (const [id, block] of Object.entries(blocksData)) {
  if (block.type === "facility" && block.polygon !== null) clickableLayers.push({ id: `facility:${id}`, polygon: block.polygon, layer: 0 });
}
for (const [pid, plot] of Object.entries(plotsData)) {
  if (plot.polygon === null) continue;
  clickableLayers.push({ id: `plot:${pid}`, polygon: plot.polygon, layer: 1 });
}
for (const [id, block] of Object.entries(blocksData)) {
  if (block.type === "block" && block.centroid !== null) clickableLayers.push({ id: `badge:${id}`, polygon: null, centroid: block.centroid, layer: 2, radius: 13 });
}

function topMostHit(pt) {
  let best = null;
  for (const el of clickableLayers) {
    let hit = false;
    if (el.polygon) {
      hit = pointInPolygon(pt, el.polygon);
    } else if (el.centroid) {
      const dx = pt[0] - el.centroid[0], dy = pt[1] - el.centroid[1];
      hit = Math.sqrt(dx * dx + dy * dy) <= el.radius;
    }
    if (hit) {
      if (!best || el.layer >= best.layer) best = el;
    }
  }
  return best;
}

function centroidOf(poly) {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
}

let mismatchCount = 0;
for (const el of clickableLayers) {
  const testPoint = el.polygon ? centroidOf(el.polygon) : el.centroid;
  const hit = topMostHit(testPoint);
  if (!hit || hit.id !== el.id) {
    // A badge sitting on top of a plot from the SAME block is by design
    // (badge always wins at its own center so block info stays reachable).
    // Only flag it when the badge belongs to a DIFFERENT block/plot.
    const isOwnBadgeException =
      hit && hit.id.startsWith("badge:") && el.id.startsWith("plot:") && el.id.split(":")[1].split("__")[0] === hit.id.split(":")[1];
    if (isOwnBadgeException) continue;
    fail(`Click simulation: the center of ${el.id} actually resolves to ${hit ? hit.id : "NOTHING"} instead of itself`);
    mismatchCount++;
  }
}

/* ---------- Check 10: area-rank sanity (soft warning only) ---------- */
// If a block's plots have meaningfully different listed areas (sqm), the
// geometric size ranking should roughly agree. Large disagreement usually
// means two plots' shapes got swapped during data extraction/editing.
for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type !== "block") continue;
  const items = block.plot_ids.map((pid) => plotsData[pid]).filter((p) => p.polygon !== null);
  if (items.length < 2) continue;
  const areas = items.map((p) => p.area);
  const spread = Math.max(...areas) / Math.min(...areas);
  if (spread < 1.3) continue; // areas too similar to be a meaningful check
  const geomAreas = items.map((p) => polyArea(p.polygon));
  const biggestListedIdx = areas.indexOf(Math.max(...areas));
  const biggestGeomIdx = geomAreas.indexOf(Math.max(...geomAreas));
  if (biggestListedIdx !== biggestGeomIdx) {
    warn(
      `Block ${blockId}: plot with the largest listed area (${items[biggestListedIdx].plot}) is NOT the geometrically largest shape (that's ${items[biggestGeomIdx].plot}) — check for a plot mix-up`
    );
  }
}

/* ---------- Report ---------- */
const totalPlots = Object.keys(plotsData).length;
const extractedPlots = Object.values(plotsData).filter((p) => p.polygon !== null).length;
const totalBlocks = Object.values(blocksData).filter((b) => b.type === "block").length;
const badgedBlocks = Object.values(blocksData).filter((b) => b.type === "block" && b.centroid !== null).length;
const totalFacilities = Object.values(blocksData).filter((b) => b.type === "facility").length;
const extractedFacilities = Object.values(blocksData).filter((b) => b.type === "facility" && b.polygon !== null).length;

console.log(`\nChecked ${Object.keys(blocksData).length} blocks / ${Object.keys(plotsData).length} plots\n`);
console.log(`Extraction coverage (vector-source only):`);
console.log(`  plots:      ${extractedPlots}/${totalPlots} have a real polygon`);
console.log(`  badges:     ${badgedBlocks}/${totalBlocks} blocks have a badge position`);
console.log(`  facilities: ${extractedFacilities}/${totalFacilities} have a real polygon`);
console.log("");

if (warnings.length) {
  console.log(`⚠ ${warnings.length} warning(s):`);
  warnings.forEach((w) => console.log("  -", w));
  console.log("");
}

if (errors.length) {
  console.log(`✗ ${errors.length} error(s):`);
  errors.forEach((e) => console.log("  -", e));
  console.log("\nFAILED — fix the above before deploying.\n");
  process.exit(1);
} else {
  console.log("✓ All checks passed. Safe to deploy.\n");
  process.exit(0);
}
