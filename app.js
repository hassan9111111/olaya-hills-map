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

  Object.entries(blocksData)
    .filter(([, block]) => block.type === "block")
    .forEach(([blockId, block]) => {
      if (!block.centroid) return; // not_extracted
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", block.centroid[0]);
      el.setAttribute("cy", block.centroid[1]);
      el.setAttribute("r", block.badge_radius || BADGE_RADIUS);
      el.setAttribute("data-block-id", blockId);
      el.classList.add("block-badge");
      fragment.appendChild(el);
    });

  layer.appendChild(fragment);
}

/* ---------------- Interaction wiring ---------------- */

function attachInteractions() {
  document.getElementById("plots-layer").addEventListener("click", (e) => {
    const target = e.target.closest(".plot-polygon");
    if (!target) return;
    openPlotModal(target.getAttribute("data-plot-id"));
  });

  document.getElementById("facilities-layer").addEventListener("click", (e) => {
    const target = e.target.closest(".facility-polygon");
    if (!target) return;
    openFacilityModal(target.getAttribute("data-facility-id"));
  });

  document.getElementById("badges-layer").addEventListener("click", (e) => {
    const target = e.target.closest(".block-badge");
    if (!target) return;
    openBlockModal(target.getAttribute("data-block-id"));
  });

  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
}

/* ---------------- Modal content builders ---------------- */

function formatNumber(n) {
  return Math.round(n).toLocaleString("en-US");
}

function buildPlotModalHTML(plotId, plot) {
  return `
    <span class="badge usage-${plot.usage}">${plot.usage}</span>
    <h2 class="modal-title">قطعة ${plot.plot}</h2>
    <p class="modal-subtitle">داخل بلوك ${plot.block}</p>

    <div class="modal-stats">
      <div>
        <p class="modal-stat-label">رقم القطعة</p>
        <p class="modal-stat-value">${plot.plot}</p>
      </div>
      <div>
        <p class="modal-stat-label">المساحة</p>
        <p class="modal-stat-value">${formatNumber(plot.area)} م²</p>
      </div>
      <div>
        <p class="modal-stat-label">رقم البلوك</p>
        <p class="modal-stat-value">${plot.block}</p>
      </div>
    </div>

    <button class="modal-action" id="view-block-btn" data-block-id="${plot.block}">
      عرض تفاصيل البلوك
    </button>
  `;
}

function buildBlockModalHTML(blockId, block) {
  const rows = block.plot_ids
    .map((pid) => {
      const p = plotsData[pid];
      return `
      <tr>
        <td>${p.plot}</td>
        <td>${formatNumber(p.area)} م²</td>
      </tr>`;
    })
    .join("");

  return `
    <span class="badge usage-${block.usage}">${block.usage}</span>
    <h2 class="modal-title">بلوك ${blockId}</h2>
    <p class="modal-subtitle">تفاصيل القطع داخل هذا البلوك</p>

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

  const body = document.getElementById("modal-body");
  body.innerHTML = buildPlotModalHTML(plotId, plot);
  document.getElementById("view-block-btn").addEventListener("click", () => {
    openBlockModal(plot.block);
  });

  document.getElementById("modal-backdrop").classList.add("is-open");
}

function openBlockModal(blockId) {
  const block = blocksData[blockId];
  if (!block || block.type !== "block") return;

  const body = document.getElementById("modal-body");
  body.innerHTML = buildBlockModalHTML(blockId, block);
  document.getElementById("modal-backdrop").classList.add("is-open");
}

function openFacilityModal(blockId) {
  const block = blocksData[blockId];
  if (!block || block.type !== "facility") return;

  const body = document.getElementById("modal-body");
  body.innerHTML = buildFacilityModalHTML(blockId, block);
  document.getElementById("modal-backdrop").classList.add("is-open");
}

function closeModal() {
  document.getElementById("modal-backdrop").classList.remove("is-open");
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

/* ---------------- Init ---------------- */

async function init() {
  await loadData();
  renderBlockOutlines();
  renderFacilities();
  renderPlots();
  renderBadges();
  attachInteractions();
  attachDebugToggle();
  attachSearch();
}

init();
