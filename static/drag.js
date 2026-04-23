/* ============================================================
   Carpool Scheduler — drag.js
   Features:
     - WFH grid + schedule generation
     - 2-week block driver rotation with daily WFH substitution
     - Geographic passenger assignment + Google Maps route ordering
     - HTML5 drag-and-drop: move OR swap employees
     - Route map modal (Leaflet.js / OpenStreetMap)
     - Weekly save (persists to state.json + history)
     - Monthly summary tab
     - Schedule history tab
   ============================================================ */

let allEmployees         = [];
let currentSchedule      = [];
let currentWeeklyDrivers = [];
let currentBlockWeekNum  = 1;
let currentWfhPerDay     = {};
let currentWorkplace     = { name: "המשרד", lat: 0.0, lng: 0.0 };
let seatCounts           = {};
let weekCounts           = {};

let draggingCard   = null;
let dragSourceZone = null;
let dragSourceSlot = null;

let mapInstance = null;

let googleMapsApiKey  = "";
let googleMapsLoaded  = false;
let placesAutocomplete = null;
let empLat = 0.0;
let empLng = 0.0;
let geocodeTimer = null;

const DAY_NAMES = ["ראשון","שני","שלישי","רביעי","חמישי"];

// Google Maps pin SVG icon (used on route buttons)
const MAP_PIN_SVG = `<svg width="11" height="15" viewBox="0 0 11 15" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;margin-left:3px;flex-shrink:0"><path d="M5.5 0C2.46 0 0 2.46 0 5.5 0 9.63 5.5 15 5.5 15S11 9.63 11 5.5C11 2.46 8.54 0 5.5 0zm0 7.5C4.12 7.5 3 6.38 3 5s1.12-2.5 2.5-2.5S8 3.62 8 5 6.88 7.5 5.5 7.5z" fill="#EA4335"/></svg>`;
const MONTH_NAMES = [
  "ינואר","פברואר","מרץ","אפריל","מאי","יוני",
  "יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר",
];

// ── Bootstrap ──────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const [employees, , cfg] = await Promise.all([
    fetch("/api/employees").then(r => r.json()),
    fetch("/api/state").then(r => r.json()).then(s => {
      seatCounts = s.seat_counts || {};
      weekCounts = s.week_counts || {};
    }),
    fetch("/api/config-public").then(r => r.json()),
  ]);
  allEmployees     = employees;
  googleMapsApiKey = cfg.google_maps_api_key || "";

  if (googleMapsApiKey) {
    window._onGoogleMapsLoaded = () => { googleMapsLoaded = true; };
    const s = document.createElement("script");
    s.src   = `https://maps.googleapis.com/maps/api/js?key=${googleMapsApiKey}&libraries=places&callback=_onGoogleMapsLoaded`;
    s.async = true;
    document.head.appendChild(s);
  }

  buildWfhGrid();

  document.getElementById("btn-generate").addEventListener("click", generateSchedule);
  document.getElementById("btn-save").addEventListener("click", saveWeek);
  document.getElementById("weekStart").addEventListener("change", buildWfhGrid);

  document.querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  initMonthlyTab();
});

// ── Tab switching ──────────────────────────────────────────────

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tabId)
  );
  document.querySelectorAll(".tab-panel").forEach(p =>
    p.classList.toggle("hidden", p.id !== `tab-${tabId}`)
  );
  if (tabId === "monthly")   loadMonthlyView();
  if (tabId === "history")   loadHistoryView();
  if (tabId === "employees") loadEmployeesTab();
}

// ── WFH Grid ──────────────────────────────────────────────────

function localIso(d) {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getWeekDates(startIso) {
  const dates = [];
  const start = new Date(startIso + "T00:00:00");
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    dates.push(localIso(d));
  }
  return dates;
}

function buildWfhGrid() {
  const tbody     = document.getElementById("wfh-tbody");
  tbody.innerHTML = "";
  const weekStart = document.getElementById("weekStart").value;
  const dates     = getWeekDates(weekStart);

  allEmployees.forEach(emp => {
    const tr     = document.createElement("tr");
    const nameTd = document.createElement("td");
    nameTd.textContent = emp.name;
    tr.appendChild(nameTd);

    dates.forEach(dateStr => {
      const td = document.createElement("td");
      const cb = document.createElement("input");
      cb.type          = "checkbox";
      cb.dataset.empId = emp.id;
      cb.dataset.date  = dateStr;
      td.appendChild(cb);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function collectWfh() {
  const wfhPerDay = {};
  document.querySelectorAll("#wfh-tbody input[type=checkbox]").forEach(cb => {
    if (cb.checked) {
      const d = cb.dataset.date;
      if (!wfhPerDay[d]) wfhPerDay[d] = [];
      wfhPerDay[d].push(cb.dataset.empId);
    }
  });
  return wfhPerDay;
}

// ── Generate schedule ──────────────────────────────────────────

async function generateSchedule() {
  const weekStart  = document.getElementById("weekStart").value;
  currentWfhPerDay = collectWfh();

  // Loading state
  const btn = document.getElementById("btn-generate");
  btn.disabled = true;
  btn.innerHTML = `<span class="loading-spinner"></span> מחשב מסלולים...`;

  try {
    const resp = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ week_start: weekStart, wfh: currentWfhPerDay }),
    });

    const data = await resp.json();
    currentSchedule      = data.schedules;
    currentWeeklyDrivers = data.weekly_drivers;
    currentBlockWeekNum  = data.block_week_num || 1;
    currentWorkplace     = data.workplace || { name: "המשרד", lat: 0.0, lng: 0.0 };

    renderSchedule();
    document.getElementById("schedule-section").classList.remove("hidden");
    document.getElementById("schedule-section").scrollIntoView({ behavior: "smooth" });
  } finally {
    btn.disabled = false;
    btn.textContent = "צור לוח נסיעות";
  }
}

// ── Render weekly schedule ─────────────────────────────────────

function formatDate(isoStr) {
  const d = new Date(isoStr + "T00:00:00");
  return `יום ${DAY_NAMES[d.getDay()]}, ${d.toLocaleDateString("he-IL", {
    day: "numeric", month: "long", year: "numeric"
  })}`;
}

function renderSchedule() {
  renderWeeklyDriversBanner();
  const container = document.getElementById("schedule-days");
  container.innerHTML = "";
  currentSchedule.forEach((day, dayIdx) => {
    container.appendChild(buildDayBlock(day, dayIdx, false));
  });
}

// ── Weekly drivers banner ──────────────────────────────────────

function renderWeeklyDriversBanner() {
  let banner = document.getElementById("weekly-drivers-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id        = "weekly-drivers-banner";
    banner.className = "weekly-drivers-banner";
    const scheduleHeader = document.querySelector("#schedule-section .schedule-header");
    scheduleHeader.after(banner);
  }

  if (!currentWeeklyDrivers.length) {
    banner.innerHTML = "<strong>⚠ אין נהגות זמינות השבוע</strong>";
    return;
  }

  banner.innerHTML = `
    <span class="banner-label">נהגות השבוע</span>
    <span class="block-week-badge">שבוע ${currentBlockWeekNum} מתוך 2</span>
  `;

  currentWeeklyDrivers.forEach((d, i) => {
    const chip = document.createElement("span");
    chip.className = "driver-chip";
    chip.innerHTML = `🚗 מכונית ${i + 1}: <strong>${d.name}</strong>`;

    const btn = document.createElement("button");
    btn.className   = "btn-change-driver";
    btn.textContent = "🔄 החלף";
    btn.addEventListener("click", () => openChangeDriver(i));
    chip.appendChild(btn);
    banner.appendChild(chip);
  });
}

// ── Change weekly driver modal ─────────────────────────────────

let changingCarIdx = null;

function openChangeDriver(carIdx) {
  changingCarIdx    = carIdx;
  const current     = currentWeeklyDrivers[carIdx];
  const otherDriver = currentWeeklyDrivers[1 - carIdx];

  const candidates = allEmployees.filter(e =>
    e.is_driver && e.id !== current.id && e.id !== otherDriver?.id
  );

  document.getElementById("change-driver-msg").textContent =
    `נהגת נוכחית של מכונית ${carIdx + 1}: ${current.name}`;

  const optionsEl = document.getElementById("change-driver-options");
  optionsEl.innerHTML = "";

  if (candidates.length === 0) {
    optionsEl.innerHTML = `<p style="color:#57606a;font-size:.9rem">אין נהגות חלופיות זמינות</p>`;
  } else {
    candidates.forEach(candidate => {
      const btn       = document.createElement("button");
      btn.className   = "driver-option-btn";
      const wks       = weekCounts[candidate.id] || 0;
      btn.textContent = `${candidate.name} (${wks} שבועות נהיגה עד כה)`;
      btn.addEventListener("click", () => applyDriverChange(carIdx, candidate));
      optionsEl.appendChild(btn);
    });
  }

  document.getElementById("change-driver-overlay").classList.remove("hidden");
}

function closeChangeDriver() {
  document.getElementById("change-driver-overlay").classList.add("hidden");
  changingCarIdx = null;
}

async function applyDriverChange(carIdx, newDriver) {
  closeChangeDriver();

  const weekStart        = document.getElementById("weekStart").value;
  const newWeeklyDrivers = [...currentWeeklyDrivers];
  newWeeklyDrivers[carIdx] = newDriver;

  const resp = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      week_start:     weekStart,
      wfh:            currentWfhPerDay,
      forced_drivers: newWeeklyDrivers.map(d => d.id),
    }),
  });

  const data = await resp.json();
  currentSchedule      = data.schedules;
  currentWeeklyDrivers = data.weekly_drivers;
  currentBlockWeekNum  = data.block_week_num || 1;
  currentWorkplace     = data.workplace || currentWorkplace;

  renderSchedule();
  showToast(`הנהגת הוחלפה ל-${newDriver.name} ✓`, false);
}

// ── Day block ──────────────────────────────────────────────────

function buildDayBlock(day, dayIdx, readOnly, blockDriverIds = null) {
  const block = document.createElement("div");
  block.className = "day-block";
  if (!readOnly) block.dataset.dayIdx = dayIdx;

  const title = document.createElement("div");
  title.className = "day-title";
  title.innerHTML = `<span>${formatDate(day.date)}</span>`;
  if (day.warning) {
    const badge = document.createElement("span");
    badge.className   = "warning-badge";
    badge.textContent = "⚠ " + day.warning;
    title.appendChild(badge);
  }
  block.appendChild(title);

  const body = document.createElement("div");
  body.className = "day-body";

  day.cars.forEach((car, carIdx) => {
    body.appendChild(readOnly
      ? buildCarCardReadOnly(car, blockDriverIds, day.date)
      : buildCarCard(car, carIdx, dayIdx, day.date));
  });
  body.appendChild(readOnly
    ? buildZoneReadOnly("🚌 תחבורה ציבורית", day.public_transport)
    : buildPtZone(day.public_transport, dayIdx));

  if (day.wfh && day.wfh.length > 0)
    body.appendChild(buildWfhZone(day.wfh));

  block.appendChild(body);
  return block;
}

// ── Car card (interactive) ─────────────────────────────────────

function buildCarCard(car, carIdx, dayIdx, dayDate) {
  const card = document.createElement("div");
  card.className      = "car-card";
  card.dataset.carNum = car.car_number;
  card.dataset.dayIdx = dayIdx;

  // Header: car title + km badge + map button
  const header = document.createElement("div");
  header.className = "car-card-header";

  const titleEl = document.createElement("h3");
  titleEl.textContent = `🚗 מכונית ${car.car_number}`;
  header.appendChild(titleEl);

  const rightEl = document.createElement("div");
  rightEl.className = "car-card-header-right";

  if (car.route_km === null) {
    // Recalculating — show spinner badge
    const kmBadge = document.createElement("span");
    kmBadge.className = "route-km-badge";
    kmBadge.innerHTML = `<span class="loading-spinner-sm"></span>`;
    rightEl.appendChild(kmBadge);
  } else if (car.route_km > 0) {
    const kmBadge = document.createElement("span");
    kmBadge.className   = "route-km-badge";
    kmBadge.textContent = `${car.route_km} ק"מ`;
    rightEl.appendChild(kmBadge);
  }

  const mapBtn = document.createElement("button");
  mapBtn.className = "btn-show-map";
  mapBtn.innerHTML = MAP_PIN_SVG + " מסלול";
  mapBtn.addEventListener("click", () => openRouteMap(car, dayDate));
  rightEl.appendChild(mapBtn);

  header.appendChild(rightEl);
  card.appendChild(header);

  // Driver slot (locked)
  const driverSlot = document.createElement("div");
  driverSlot.className        = "slot driver-slot";
  driverSlot.dataset.zone     = `car_${car.car_number}`;
  driverSlot.dataset.slotType = "driver";
  driverSlot.dataset.dayIdx   = dayIdx;

  if (car.driver) {
    const weeklyDriverIds = currentWeeklyDrivers.map(d => d.id);
    const isSubstitute    = !weeklyDriverIds.includes(car.driver.id);
    const dCard           = makeCard(car.driver, true, isSubstitute);
    dCard.draggable    = false;
    dCard.style.cursor = "default";
    dCard.title        = isSubstitute ? "מחליפה ליום זה" : "נהגת קבועה השבוע";
    driverSlot.appendChild(dCard);
  } else {
    const ph = document.createElement("div");
    ph.className   = "driver-wfh-placeholder";
    ph.textContent = "🏠 אין נהגת היום";
    driverSlot.appendChild(ph);
  }
  card.appendChild(driverSlot);

  // Passenger stops (ordered pickup sequence)
  for (let i = 0; i < 4; i++) {
    const slot = document.createElement("div");
    slot.className        = "slot passenger-slot";
    slot.dataset.zone     = `car_${car.car_number}`;
    slot.dataset.slotType = "passenger";
    slot.dataset.dayIdx   = dayIdx;
    slot.dataset.slotIdx  = i;

    const pax = car.passengers[i];
    if (pax) {
      const stopNum = document.createElement("span");
      stopNum.className   = "stop-number";
      stopNum.textContent = i + 1;
      slot.appendChild(stopNum);
      slot.appendChild(makeCard(pax, false));
    }
    setupDropZone(slot);
    card.appendChild(slot);
  }

  return card;
}

// ── Car card (read-only) ───────────────────────────────────────

function buildCarCardReadOnly(car, blockDriverIds, dayDate) {
  const card = document.createElement("div");
  card.className = "car-card";

  const header = document.createElement("div");
  header.className = "car-card-header";

  const titleEl = document.createElement("h3");
  titleEl.textContent = `🚗 מכונית ${car.car_number}`;
  header.appendChild(titleEl);

  const rightEl = document.createElement("div");
  rightEl.className = "car-card-header-right";

  if (car.route_km === null) {
    // Recalculating — show spinner badge
    const kmBadge = document.createElement("span");
    kmBadge.className = "route-km-badge";
    kmBadge.innerHTML = `<span class="loading-spinner-sm"></span>`;
    rightEl.appendChild(kmBadge);
  } else if (car.route_km > 0) {
    const kmBadge = document.createElement("span");
    kmBadge.className   = "route-km-badge";
    kmBadge.textContent = `${car.route_km} ק"מ`;
    rightEl.appendChild(kmBadge);
  }

  const mapBtn = document.createElement("button");
  mapBtn.className = "btn-show-map";
  mapBtn.innerHTML = MAP_PIN_SVG + " מסלול";
  mapBtn.addEventListener("click", () => openRouteMap(car, dayDate));
  rightEl.appendChild(mapBtn);

  header.appendChild(rightEl);
  card.appendChild(header);

  const driverSlot = document.createElement("div");
  driverSlot.className = "slot driver-slot";
  if (car.driver) {
    const isSubstitute = blockDriverIds && !blockDriverIds.includes(car.driver.id);
    const dCard = makeCard(car.driver, true, isSubstitute);
    dCard.draggable    = false;
    dCard.style.cursor = "default";
    driverSlot.appendChild(dCard);
  }
  card.appendChild(driverSlot);

  for (let i = 0; i < 4; i++) {
    const slot = document.createElement("div");
    slot.className = "slot passenger-slot";
    const pax = car.passengers[i];
    if (pax) {
      const stopNum = document.createElement("span");
      stopNum.className   = "stop-number";
      stopNum.textContent = i + 1;
      slot.appendChild(stopNum);
      const c = makeCard(pax, false);
      c.draggable    = false;
      c.style.cursor = "default";
      slot.appendChild(c);
    }
    card.appendChild(slot);
  }

  return card;
}

// ── Zone helpers ───────────────────────────────────────────────

function buildZoneReadOnly(label, empList) {
  const zone = document.createElement("div");
  zone.className = "zone-card";
  const title = document.createElement("h3");
  title.textContent = label;
  zone.appendChild(title);
  const body = document.createElement("div");
  body.className = "pt-zone-body";
  empList.forEach(emp => {
    const c = makeCard(emp, false);
    c.draggable    = false;
    c.style.cursor = "default";
    body.appendChild(c);
  });
  zone.appendChild(body);
  return zone;
}

function buildPtZone(ptList, dayIdx) {
  const zone = document.createElement("div");
  zone.className = "zone-card";
  const title = document.createElement("h3");
  title.textContent = "🚌 תחבורה ציבורית";
  zone.appendChild(title);
  const body = document.createElement("div");
  body.className        = "pt-zone-body";
  body.dataset.zone     = "public_transport";
  body.dataset.slotType = "passenger";
  body.dataset.dayIdx   = dayIdx;
  ptList.forEach(emp => body.appendChild(makeCard(emp, false)));
  setupDropZone(body);
  zone.appendChild(body);
  return zone;
}

function buildWfhZone(wfhList) {
  const zone = document.createElement("div");
  zone.className = "zone-card wfh-zone";
  const title = document.createElement("h3");
  title.textContent = "🏠 עבודה מהבית";
  zone.appendChild(title);
  const body = document.createElement("div");
  body.className = "wfh-zone-body";
  wfhList.forEach(emp => {
    const c = makeCard(emp, false);
    c.draggable    = false;
    c.style.cursor = "default";
    body.appendChild(c);
  });
  zone.appendChild(body);
  return zone;
}

// ── Employee card ──────────────────────────────────────────────

function makeCard(emp, isDriver, isSubstitute = false) {
  const card = document.createElement("div");
  let cls = "employee-card";
  if (isDriver && !isSubstitute) cls += " driver-badge";
  if (isDriver &&  isSubstitute) cls += " substitute-badge";
  card.className        = cls;
  card.draggable        = true;
  card.dataset.empId    = emp.id;
  card.dataset.empName  = emp.name;
  card.dataset.isDriver = emp.is_driver ? "1" : "0";

  const icon = isSubstitute ? "🔄 " : (isDriver ? "🚗 " : "");
  card.textContent = icon + emp.name + (isSubstitute ? " (מחליפה)" : "");
  setupDrag(card);
  return card;
}

// ── Drag source ────────────────────────────────────────────────

function setupDrag(card) {
  card.addEventListener("dragstart", e => {
    draggingCard   = card;
    dragSourceSlot = card.closest("[data-slot-type]");
    dragSourceZone = dragSourceSlot ? dragSourceSlot.dataset.zone : null;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.empId);
  });

  card.addEventListener("dragend", () => {
    card.classList.remove("dragging");
    draggingCard   = null;
    dragSourceSlot = null;
    dragSourceZone = null;
  });
}

// ── Drop zones ─────────────────────────────────────────────────

function setupDropZone(el) {
  el.addEventListener("dragover", e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    el.classList.add("drag-over");
  });

  el.addEventListener("dragleave", e => {
    if (!el.contains(e.relatedTarget)) el.classList.remove("drag-over");
  });

  el.addEventListener("drop", async e => {
    e.preventDefault();
    el.classList.remove("drag-over");
    if (!draggingCard) return;

    // Capture synchronously before any await
    const srcZone = dragSourceZone;
    const toZone  = el.dataset.zone;
    const toSlot  = el.dataset.slotType;
    const dayIdx  = parseInt(el.dataset.dayIdx);
    const empId   = draggingCard.dataset.empId;
    const day     = currentSchedule[dayIdx];
    const wfhIds  = currentWfhPerDay[day.date] || [];

    if (!day) return;

    const isIndividualSlot = el.classList.contains("passenger-slot");
    const existingCard     = isIndividualSlot ? el.querySelector(".employee-card") : null;
    const swapEmpId        = existingCard ? existingCard.dataset.empId : null;

    if (swapEmpId && swapEmpId !== empId) {
      const proceed = await checkSwapFairness(empId, swapEmpId, srcZone, toZone);
      if (!proceed) return;
      await applyMove(dayIdx, empId, toZone, toSlot, swapEmpId, srcZone);
      return;
    }

    const result = await fetch("/api/validate-move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employee_id:       empId,
        to_zone:           toZone,
        to_slot:           toSlot,
        wfh_ids:           wfhIds,
        current_day_state: day,
      }),
    }).then(r => r.json());

    if (!result.ok) { showAlert(result.error); return; }

    await applyMove(dayIdx, empId, toZone, toSlot, null, srcZone);
  });
}

// ── Apply move / swap ──────────────────────────────────────────

async function applyMove(dayIdx, empId, toZone, toSlot, swapEmpId, srcZone) {
  const day = currentSchedule[dayIdx];
  const emp = allEmployees.find(e => e.id === empId);

  removeFromDay(day, empId);

  if (swapEmpId && swapEmpId !== empId) {
    const swapEmp = allEmployees.find(e => e.id === swapEmpId);
    removeFromDay(day, swapEmpId);
    placeInDay(day, swapEmp, srcZone, "passenger");
  }

  placeInDay(day, emp, toZone, toSlot);
  rerenderDay(dayIdx);

  // Recalculate route only for the affected car(s)
  const affectedCars = new Set();
  if (srcZone && srcZone.startsWith("car_")) affectedCars.add(parseInt(srcZone.split("_")[1]));
  if (toZone  && toZone.startsWith("car_"))  affectedCars.add(parseInt(toZone.split("_")[1]));
  for (const carNum of affectedCars) {
    await recalculateCarRoute(dayIdx, carNum);
  }
}

async function recalculateCarRoute(dayIdx, carNum) {
  const day = currentSchedule[dayIdx];
  const car = day.cars.find(c => c.car_number === carNum);
  if (!car || !car.driver) return;

  // Mark as loading (null = spinner state in buildCarCard)
  car.route_km      = null;
  car.route_polyline = "";
  rerenderDay(dayIdx);

  try {
    const result = await fetch("/api/route-car", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        driver_id:    car.driver.id,
        passenger_ids: car.passengers.map(p => p.id),
      }),
    }).then(r => r.json());

    // Reorder passengers by optimised order
    const idToEmp  = Object.fromEntries(car.passengers.map(p => [p.id, p]));
    const ordered  = result.passenger_order.map(id => idToEmp[id]).filter(Boolean);
    const orderedSet = new Set(result.passenger_order);
    // Append any passengers not returned (no-location fallback)
    car.passengers.forEach(p => { if (!orderedSet.has(p.id)) ordered.push(p); });
    car.passengers = ordered;

    car.route_km      = result.route_km;
    car.route_polyline = result.route_polyline;
  } catch (err) {
    console.error("[route-car] Failed:", err);
    car.route_km = 0;
  }

  rerenderDay(dayIdx);
}

function placeInDay(day, emp, zone, slotType) {
  if (zone === "public_transport") {
    day.public_transport.push(emp);
  } else {
    const carNum = parseInt(zone.split("_")[1]);
    let car = day.cars.find(c => c.car_number === carNum);
    if (!car) {
      car = { car_number: carNum, driver: null, passengers: [], route_km: 0 };
      day.cars.push(car);
      day.cars.sort((a, b) => a.car_number - b.car_number);
    }
    car.passengers.push(emp);
    // route_km/polyline will be refreshed by recalculateCarRoute after the move
  }
}

function removeFromDay(day, empId) {
  day.public_transport = day.public_transport.filter(e => e.id !== empId);
  day.cars.forEach(car => {
    car.passengers = car.passengers.filter(p => p.id !== empId);
  });
}

function rerenderDay(dayIdx) {
  const day   = currentSchedule[dayIdx];
  const block = document.querySelector(`.day-block[data-day-idx="${dayIdx}"]`);
  const body  = block.querySelector(".day-body");
  body.innerHTML = "";
  day.cars.forEach((car, carIdx) => body.appendChild(buildCarCard(car, carIdx, dayIdx, day.date)));
  body.appendChild(buildPtZone(day.public_transport, dayIdx));
  if (day.wfh && day.wfh.length > 0) body.appendChild(buildWfhZone(day.wfh));
}

// ── Save week ──────────────────────────────────────────────────

async function saveWeek() {
  const weekStart = document.getElementById("weekStart").value;
  const resp = await fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schedules:      currentSchedule,
      weekly_drivers: currentWeeklyDrivers,
      week_start:     weekStart,
    }),
  });
  const result = await resp.json();
  if (result.ok) {
    seatCounts = result.seat_counts || seatCounts;
    showToast("השבוע נשמר! ✓", false);
  } else {
    showToast("שגיאה בשמירה — נסי שנית", true);
  }
}

// ── Google Encoded Polyline decoder ───────────────────────────

function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Parse route_polyline field — handles both formats:
 *   JSON array of step-level encoded polylines (new, detailed)
 *   Single encoded overview polyline string (old / fallback)
 * Returns flat array of [lat, lng] points.
 */
function parseRoutePolyline(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.flatMap(seg => decodePolyline(seg));
    }
  } catch {}
  // Single encoded string
  return decodePolyline(raw);
}

// ── Route map modal ────────────────────────────────────────────

function openRouteMap(car, dayDate) {
  // Diagnostics — visible in browser DevTools console (F12)
  console.log("[map] car object:", car);
  console.log("[map] route_polyline:", car.route_polyline
    ? `OK (${car.route_polyline.length} chars): ${car.route_polyline.substring(0, 40)}...`
    : "EMPTY — using aerial fallback");

  // Build stop list
  const stops = [];
  if (car.driver && (car.driver.lat || car.driver.lng)) {
    stops.push({ lat: car.driver.lat, lng: car.driver.lng, label: car.driver.name, type: "driver" });
  }
  car.passengers.forEach((p, i) => {
    if (p.lat || p.lng) {
      stops.push({ lat: p.lat, lng: p.lng, label: `${i + 1}. ${p.name}`, type: "passenger", stopNum: i + 1 });
    }
  });
  const wp = currentWorkplace;
  if (wp && (wp.lat || wp.lng)) {
    stops.push({ lat: wp.lat, lng: wp.lng, label: wp.name || "המשרד", type: "workplace" });
  }

  // Google Maps URL
  const gmapsPoints = stops.map(s => `${s.lat},${s.lng}`).join("/");
  document.getElementById("map-gmaps-link").href =
    stops.length > 0 ? `https://www.google.com/maps/dir/${gmapsPoints}` : "#";

  // Title
  const dateStr = dayDate ? formatDate(dayDate) : "";
  document.getElementById("map-title").textContent =
    `${car.driver?.name || "מכונית " + car.car_number} — ${dateStr}`;

  document.getElementById("map-overlay").classList.remove("hidden");

  // Reset Leaflet map
  const container = document.getElementById("map-container");
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  mapInstance = L.map(container);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(mapInstance);

  if (stops.length === 0) {
    // No coordinates — show a message
    container.insertAdjacentHTML("afterend",
      `<p style="text-align:center;padding:8px;color:#57606a">אין נתוני מיקום לנסיעה זו. הזיני כתובות ב-employees.json</p>`
    );
    mapInstance.setView([31.5, 34.75], 8);
    buildMapLegend(car);
    return;
  }

  // Markers
  const latlngs = [];
  stops.forEach((stop, idx) => {
    const latlng = [stop.lat, stop.lng];
    latlngs.push(latlng);

    let iconHtml;
    if (stop.type === "driver") {
      iconHtml = `<div class="map-marker map-marker-driver">🚗</div>`;
    } else if (stop.type === "workplace") {
      iconHtml = `<div class="map-marker map-marker-workplace">🏢</div>`;
    } else {
      iconHtml = `<div class="map-marker map-marker-passenger">${stop.stopNum}</div>`;
    }

    const icon = L.divIcon({
      className:  "",
      html:       iconHtml,
      iconSize:   [36, 36],
      iconAnchor: [18, 18],
    });

    L.marker(latlng, { icon })
      .addTo(mapInstance)
      .bindPopup(`<strong>${stop.label}</strong>` + (stop.type === "driver" ? "<br/>נהגת" : ""));
  });

  // Route polyline — use Google Maps step-level road geometry if available
  if (latlngs.length > 1) {
    const roadPoints = parseRoutePolyline(car.route_polyline);
    if (roadPoints && roadPoints.length > 1) {
      L.polyline(roadPoints, { color: "#0969da", weight: 4, opacity: 0.9, smoothFactor: 0 })
        .addTo(mapInstance);
      mapInstance.fitBounds(roadPoints, { padding: [40, 40] });
    } else {
      // No polyline — draw straight dashed lines with a note
      L.polyline(latlngs, { color: "#0969da", weight: 3, opacity: 0.7, dashArray: "8,5" })
        .addTo(mapInstance);
      mapInstance.fitBounds(latlngs, { padding: [40, 40] });
      const note = document.createElement("div");
      note.style.cssText = "text-align:center;padding:4px 12px;font-size:0.78rem;color:#856404;background:#fff3cd;border-top:1px solid #ffc107";
      note.textContent = "⚠ מסלול אווירי — הגדר מפתח Google Maps לנתיב כבישים";
      document.getElementById("map-container").after(note);
    }
  } else if (latlngs.length === 1) {
    mapInstance.setView(latlngs[0], 14);
  }

  buildMapLegend(car);
}

function buildMapLegend(car) {
  const legend = document.getElementById("map-legend");
  const stops  = [];
  if (car.driver) stops.push({ icon: "🚗", label: car.driver.name, note: "נהגת" });
  car.passengers.forEach((p, i) =>
    stops.push({ icon: String(i + 1), label: p.name, note: `תחנה ${i + 1}` })
  );
  stops.push({ icon: "🏢", label: currentWorkplace.name || "המשרד", note: "יעד" });

  legend.innerHTML = stops.map(s =>
    `<div class="legend-row">
       <span class="legend-icon">${s.icon}</span>
       <span class="legend-name">${s.label}</span>
       <span class="legend-note">${s.note}</span>
     </div>`
  ).join("");
}

function closeMap() {
  document.getElementById("map-overlay").classList.add("hidden");
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  // Remove any injected notes (no-coordinates message, aerial fallback note)
  document.querySelectorAll("#map-container + p, #map-container + div").forEach(el => el.remove());
}

// ── History tab ────────────────────────────────────────────────

async function loadHistoryView() {
  const data = await fetch("/api/history").then(r => r.json());
  renderHistoryBoard(data.history);
}

function formatWeekRange(weekStartIso) {
  const start = new Date(weekStartIso + "T00:00:00");
  const end   = new Date(start);
  end.setDate(start.getDate() + 4);
  const fmt = d => d.toLocaleDateString("he-IL", { day: "numeric", month: "short" });
  return `${fmt(start)} – ${fmt(end)} ${start.getFullYear()}`;
}

function getSubstituteSummary(entry) {
  const blockIds = new Set(entry.block_drivers || []);
  const subs = [];
  (entry.schedules || []).forEach(day => {
    (day.cars || []).forEach(car => {
      if (car.driver && !blockIds.has(car.driver.id)) {
        const dayName = DAY_NAMES[new Date(day.date + "T00:00:00").getDay()];
        subs.push(`${dayName}: ${car.driver.name}`);
      }
    });
  });
  return subs;
}

function renderHistoryBoard(history) {
  const board = document.getElementById("history-board");
  board.innerHTML = "";

  if (!history || history.length === 0) {
    board.innerHTML = `<p class="no-data-msg">אין שבועות שמורים עדיין.</p>`;
    return;
  }

  [...history].reverse().forEach(entry => {
    const item = document.createElement("div");
    item.className = "history-item";

    const header = document.createElement("div");
    header.className = "history-item-header";

    const left = document.createElement("div");
    left.className = "history-item-left";

    const rangeEl = document.createElement("span");
    rangeEl.className   = "history-week-range";
    rangeEl.textContent = `📅 ${formatWeekRange(entry.week_start)}`;

    const driversEl = document.createElement("span");
    driversEl.className = "history-drivers-row";

    (entry.block_drivers || []).forEach(id => {
      const emp = allEmployees.find(e => e.id === id);
      if (!emp) return;
      const chip = document.createElement("span");
      chip.className   = "driver-chip";
      chip.textContent = `🚗 ${emp.name}`;
      driversEl.appendChild(chip);
    });

    const subs = getSubstituteSummary(entry);
    if (subs.length) {
      const subChip = document.createElement("span");
      subChip.className   = "sub-chip";
      subChip.textContent = `🔄 ${subs.join(" · ")}`;
      driversEl.appendChild(subChip);
    }

    left.appendChild(rangeEl);
    left.appendChild(driversEl);

    const toggle = document.createElement("button");
    toggle.className   = "btn-toggle";
    toggle.textContent = "הצג לוח ▾";

    header.appendChild(left);
    header.appendChild(toggle);
    item.appendChild(header);

    const body = document.createElement("div");
    body.className = "history-item-body hidden";

    if (entry.schedules && entry.schedules.length > 0) {
      const blockDriverIds = entry.block_drivers || null;
      entry.schedules.forEach((dayData, idx) => {
        body.appendChild(buildDayBlock(dayData, idx, true, blockDriverIds));
      });
    } else {
      const msg = document.createElement("p");
      msg.className   = "no-data-msg";
      msg.textContent = "הלוח המלא אינו זמין לשבוע זה.";
      body.appendChild(msg);
    }

    item.appendChild(body);
    board.appendChild(item);

    toggle.addEventListener("click", () => {
      const open = !body.classList.contains("hidden");
      body.classList.toggle("hidden", open);
      toggle.textContent = open ? "הצג לוח ▾" : "הסתר לוח ▴";
      item.classList.toggle("expanded", !open);
    });
  });
}

// ── Monthly tab ────────────────────────────────────────────────

let currentMonth = null;

function initMonthlyTab() {
  const now = new Date();
  currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  document.getElementById("btn-month-prev").addEventListener("click", () => {
    currentMonth = offsetMonth(currentMonth, -1);
    loadMonthlyView();
  });
  document.getElementById("btn-month-next").addEventListener("click", () => {
    currentMonth = offsetMonth(currentMonth, +1);
    loadMonthlyView();
  });
}

function offsetMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function loadMonthlyView() {
  const [year, month] = currentMonth.split("-").map(Number);
  document.getElementById("month-label").textContent = `${MONTH_NAMES[month - 1]} ${year}`;

  const data = await fetch(`/api/history?month=${currentMonth}`).then(r => r.json());
  renderMonthlyCalendar(data.history);
  renderDriversSummary(data.drivers_summary);
}

function renderMonthlyCalendar(history) {
  const container = document.getElementById("monthly-calendar");
  if (!history.length) {
    container.innerHTML = `<p class="no-data-msg">אין שבועות שמורים לחודש זה.</p>`;
    return;
  }

  const table = document.createElement("table");
  table.className = "monthly-table";
  table.innerHTML = `<thead><tr><th>שבוע</th><th>נהגות קבועות</th><th>מחליפות</th></tr></thead>`;
  const tbody = document.createElement("tbody");

  history.forEach(entry => {
    const tr = document.createElement("tr");

    const tdWeek = document.createElement("td");
    tdWeek.className   = "week-range";
    tdWeek.textContent = formatWeekRange(entry.week_start);
    tr.appendChild(tdWeek);

    const tdPrimary = document.createElement("td");
    (entry.block_drivers || []).forEach(id => {
      const emp = allEmployees.find(e => e.id === id);
      if (!emp) return;
      const tag = document.createElement("span");
      tag.className   = "driver-tag";
      tag.textContent = `🚗 ${emp.name}`;
      tdPrimary.appendChild(tag);
    });
    if (!entry.block_drivers?.length) {
      tdPrimary.textContent = "—";
      tdPrimary.style.color = "#57606a";
    }
    tr.appendChild(tdPrimary);

    const tdSubs = document.createElement("td");
    const subs   = getSubstituteSummary(entry);
    if (subs.length) {
      tdSubs.innerHTML = subs.map(s => `<span class="sub-tag">🔄 ${s}</span>`).join(" ");
    } else {
      tdSubs.textContent = "—";
      tdSubs.style.color = "#57606a";
    }
    tr.appendChild(tdSubs);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
}

function renderDriversSummary(summary) {
  const container = document.getElementById("drivers-summary");
  if (!summary || !summary.length) { container.innerHTML = ""; return; }

  const maxDrives = Math.max(...summary.map(d => d.total_drives), 1);
  let html = `<div class="drivers-summary-title">סה"כ שבועות נהיגה קבועה לכל נהגת (כל הזמנים)</div>`;
  summary.forEach(driver => {
    const pct = Math.round((driver.total_drives / maxDrives) * 100);
    html += `
      <div class="driver-row">
        <div class="driver-row-name">${driver.name}</div>
        <div class="driver-bar-wrap"><div class="driver-bar" style="width:${pct}%"></div></div>
        <div class="driver-count">${driver.total_drives} שבועות</div>
      </div>`;
  });
  container.innerHTML = html;
}

// ── Fairness check ─────────────────────────────────────────────

function checkSwapFairness(empId, swapEmpId, srcZone, toZone) {
  const srcInCar = srcZone !== "public_transport";
  const tgtInCar = toZone  !== "public_transport";
  if (srcInCar === tgtInCar) return Promise.resolve(true);

  const losingCarEmpId  = srcInCar ? empId    : swapEmpId;
  const gainingCarEmpId = srcInCar ? swapEmpId : empId;
  const losingCount     = seatCounts[losingCarEmpId]  || 0;
  const gainingCount    = seatCounts[gainingCarEmpId] || 0;

  if (losingCount >= gainingCount) return Promise.resolve(true);

  const losingName  = allEmployees.find(e => e.id === losingCarEmpId)?.name  || losingCarEmpId;
  const gainingName = allEmployees.find(e => e.id === gainingCarEmpId)?.name || gainingCarEmpId;

  return showFairnessWarning(losingName, losingCount, gainingName, gainingCount);
}

function showFairnessWarning(losingName, losingCount, gainingName, gainingCount) {
  return new Promise(resolve => {
    document.getElementById("f-losing-name").textContent   = losingName;
    document.getElementById("f-losing-count").textContent  = losingCount;
    document.getElementById("f-gaining-name").textContent  = gainingName;
    document.getElementById("f-gaining-count").textContent = gainingCount;

    document.getElementById("fairness-overlay").classList.remove("hidden");

    document.getElementById("btn-fairness-proceed").onclick = () => {
      document.getElementById("fairness-overlay").classList.add("hidden");
      resolve(true);
    };
    document.getElementById("btn-fairness-cancel").onclick = () => {
      document.getElementById("fairness-overlay").classList.add("hidden");
      resolve(false);
    };
  });
}

// ── Alert & Toast ──────────────────────────────────────────────

function showAlert(msg) {
  document.getElementById("alert-message").textContent = msg;
  document.getElementById("alert-overlay").classList.remove("hidden");
}

function closeAlert() {
  document.getElementById("alert-overlay").classList.add("hidden");
}

function showToast(msg, isError = false) {
  const toast     = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast" + (isError ? " error" : "");
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 3500);
}

// ── Employees tab ──────────────────────────────────────────────

let editingEmployeeId = null;

async function loadEmployeesTab() {
  const employees = await fetch("/api/employees").then(r => r.json());
  allEmployees = employees;
  renderEmployeesTable(employees);
}

function renderEmployeesTable(employees) {
  const tbody = document.getElementById("employees-tbody");
  tbody.innerHTML = "";
  employees.forEach(emp => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${emp.name}</td>
      <td style="text-align:center">${emp.is_driver ? "✓" : ""}</td>
      <td style="font-size:.85rem;color:#57606a">${emp.address || "—"}</td>
      <td class="emp-actions-cell"></td>
    `;
    const cell = tr.querySelector(".emp-actions-cell");

    const editBtn = document.createElement("button");
    editBtn.className   = "btn-emp-edit";
    editBtn.textContent = "עריכה";
    editBtn.addEventListener("click", () => openEmployeeModal(emp));
    cell.appendChild(editBtn);

    const delBtn = document.createElement("button");
    delBtn.className   = "btn-emp-delete";
    delBtn.textContent = "מחיקה";
    delBtn.addEventListener("click", () => deleteEmployee(emp.id, emp.name));
    cell.appendChild(delBtn);

    tbody.appendChild(tr);
  });
}

function openEmployeeModal(emp) {
  editingEmployeeId = emp ? emp.id : null;
  const isEdit      = !!emp;

  document.getElementById("employee-modal-title").textContent =
    isEdit ? `עריכת ${emp.name}` : "הוספת עובד/ת";

  document.getElementById("emp-name").value         = emp ? emp.name          : "";
  document.getElementById("emp-is-driver").checked  = emp ? emp.is_driver     : false;
  document.getElementById("emp-address").value      = emp ? (emp.address || "") : "";
  empLat = emp ? (emp.lat || 0.0) : 0.0;
  empLng = emp ? (emp.lng || 0.0) : 0.0;

  document.getElementById("employee-overlay").classList.remove("hidden");
  document.getElementById("emp-name").focus();
  setTimeout(initAddressField, 60);
}

function closeEmployeeModal() {
  document.getElementById("employee-overlay").classList.add("hidden");
  document.getElementById("emp-address").removeEventListener("input", onAddressInput);
  if (placesAutocomplete && window.google && window.google.maps) {
    window.google.maps.event.clearInstanceListeners(placesAutocomplete);
    placesAutocomplete = null;
  }
  hideSuggestions();
  clearTimeout(geocodeTimer);
  editingEmployeeId = null;
}

async function saveEmployee() {
  const name     = document.getElementById("emp-name").value.trim();
  const isDriver = document.getElementById("emp-is-driver").checked;
  const address  = document.getElementById("emp-address").value.trim();

  if (!name) { showAlert("נא להזין שם"); return; }

  const body   = { name, is_driver: isDriver, address, lat: empLat, lng: empLng };
  const isEdit = !!editingEmployeeId;
  const url    = isEdit ? `/api/employees/${encodeURIComponent(editingEmployeeId)}` : "/api/employees";
  const method = isEdit ? "PUT" : "POST";

  const resp   = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await resp.json();

  if (!result.ok) { showAlert(result.error || "שגיאה"); return; }

  closeEmployeeModal();
  showToast(isEdit ? `${name} עודכן/ה ✓` : `${name} נוסף/ה ✓`, false);
  await loadEmployeesTab();
  buildWfhGrid();
}

async function deleteEmployee(empId, empName) {
  if (!confirm(`למחוק את ${empName}?`)) return;

  const resp   = await fetch(`/api/employees/${encodeURIComponent(empId)}`, { method: "DELETE" });
  const result = await resp.json();

  if (!result.ok) { showAlert(result.error || "שגיאה במחיקה"); return; }

  showToast(`${empName} נמחק/ה ✓`, false);
  await loadEmployeesTab();
  buildWfhGrid();
}

// ── Address autocomplete ───────────────────────────────────────

function initAddressField() {
  const input = document.getElementById("emp-address");
  input.removeEventListener("input", onAddressInput);
  hideSuggestions();
  clearTimeout(geocodeTimer);

  if (googleMapsLoaded && window.google && window.google.maps && window.google.maps.places) {
    if (placesAutocomplete) {
      window.google.maps.event.clearInstanceListeners(placesAutocomplete);
    }
    placesAutocomplete = new window.google.maps.places.Autocomplete(input, {
      fields: ["geometry", "formatted_address"],
    });
    placesAutocomplete.addListener("place_changed", () => {
      const place = placesAutocomplete.getPlace();
      if (place.geometry) {
        empLat = place.geometry.location.lat();
        empLng = place.geometry.location.lng();
        if (place.formatted_address) input.value = place.formatted_address;
      }
    });
  } else {
    input.addEventListener("input", onAddressInput);
    input.addEventListener("blur", () => setTimeout(hideSuggestions, 200));
  }
}

function onAddressInput() {
  clearTimeout(geocodeTimer);
  const q = document.getElementById("emp-address").value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  geocodeTimer = setTimeout(() => fetchNominatimSuggestions(q), 650);
}

async function fetchNominatimSuggestions(query) {
  try {
    const url     = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`;
    const results = await fetch(url).then(r => r.json());
    showSuggestions(results);
  } catch { hideSuggestions(); }
}

function showSuggestions(results) {
  const box = document.getElementById("address-suggestions");
  box.innerHTML = "";
  if (!results.length) { hideSuggestions(); return; }
  results.forEach(r => {
    const item = document.createElement("div");
    item.className   = "address-suggestion-item";
    item.textContent = r.display_name;
    item.addEventListener("mousedown", () => {
      document.getElementById("emp-address").value = r.display_name;
      empLat = parseFloat(r.lat);
      empLng = parseFloat(r.lon);
      hideSuggestions();
    });
    box.appendChild(item);
  });
  box.classList.remove("hidden");
}

function hideSuggestions() {
  const box = document.getElementById("address-suggestions");
  if (box) box.classList.add("hidden");
}
