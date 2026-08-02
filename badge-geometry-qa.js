/**
 * Badge Geometry QA — independent check, separate from data-linking QA.
 *
 * For every block, this compares the CIRCLE actually drawn in the project
 * (blocks-data.json centroid + badge_radius) against the REAL circle
 * extracted directly from the PDF's own vector paths (dark-teal filled
 * circle objects). It reports the center offset and radius difference in
 * points — this is a geometry/UI check, not a data-linking check.
 *
 * Usage: node badge-geometry-qa.js
 */
const fs = require("fs");
const path = require("path");

const blocksData = JSON.parse(fs.readFileSync(path.join(__dirname, "blocks-data.json"), "utf8"));
const realCircles = JSON.parse(fs.readFileSync(path.join(__dirname, "real-badge-circles.json"), "utf8"));

const CENTER_TOLERANCE = 3; // pt — how far off-center is still "matching"
const RADIUS_TOLERANCE = 2; // pt

let issues = 0;
const rows = [];

for (const [blockId, block] of Object.entries(blocksData)) {
  if (block.type !== "block") continue;
  const real = realCircles[blockId];
  if (!real) {
    rows.push({ block: blockId, status: "NO REAL CIRCLE FOUND IN PDF", centerDiff: "-", radiusDiff: "-" });
    issues++;
    continue;
  }
  if (!block.centroid) {
    rows.push({ block: blockId, status: "NOT DRAWN AT ALL", centerDiff: "-", radiusDiff: "-" });
    issues++;
    continue;
  }
  const dx = block.centroid[0] - real.cx;
  const dy = block.centroid[1] - real.cy;
  const centerDiff = Math.sqrt(dx * dx + dy * dy);
  const drawnRadius = block.badge_radius || 6;
  const radiusDiff = Math.abs(drawnRadius - real.r);

  const ok = centerDiff <= CENTER_TOLERANCE && radiusDiff <= RADIUS_TOLERANCE;
  rows.push({
    block: blockId,
    status: ok ? "OK" : "MISMATCH",
    centerDiff: centerDiff.toFixed(1),
    radiusDiff: radiusDiff.toFixed(1),
    drawnR: drawnRadius.toFixed(1),
    realR: real.r.toFixed(1),
  });
  if (!ok) issues++;
}

rows.sort((a, b) => Number(a.block) - Number(b.block));
console.log("Block | Status   | Center offset (pt) | Drawn R | Real R | Radius diff");
console.log("------|----------|---------------------|---------|--------|------------");
for (const r of rows) {
  console.log(
    `${r.block.padEnd(5)} | ${r.status.padEnd(8)} | ${String(r.centerDiff).padEnd(19)} | ${String(r.drawnR || "-").padEnd(7)} | ${String(r.realR || "-").padEnd(6)} | ${r.radiusDiff}`
  );
}

console.log(`\n${rows.length - issues}/${rows.length} badges match their real PDF circle within tolerance.`);
if (issues > 0) {
  console.log(`${issues} badge(s) need re-extraction from vector source.`);
  process.exit(1);
} else {
  console.log("All badges verified against real vector geometry.");
  process.exit(0);
}
