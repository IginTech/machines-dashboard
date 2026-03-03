/* ============================================================
   MACHINES DASHBOARD (UI)
   ============================================================
   This file contains ONLY UI logic.
   - Mock mode: generates fake devices + glove events.
   - BioT mode: pulls real devices + glove totals via biot_api.js (window.BiotApi).

   English comments are placed in every major step, as requested.
*/

/* ============================================================
   GLOBAL STATE
   ============================================================ */
let currentRoute = "dashboard";

let devices = [];       /* UI device objects: {id, lastConnectedAt, connected, alerting, starred} */
let gloveEvents = [];   /* Mock only: per-event records */

let gloveChart = null;
let connChart = null;

let sortState = { key: "lastConnectedAt", dir: "desc" };

let dataMode = "mock"; /* "mock" | "biot" */
let gloveTotalsOverride = null; /* In BioT mode we use totals directly (no events) */

const STAR_STORAGE_KEY = "machines_dashboard_starred_ids";

/* ============================================================
   CONFIG: MOCK DATA ONLY
   ============================================================ */
const MOCK =
{
  totalDevices: 50,
  connectedDevices: 10,
  alertingDevices: 6,

  gloveDaysBack: 30,

  /* Distribute glove sizes (percent) */
  gloveWeights:
  {
    "Small": 0.32,
    "Medium": 0.32,
    "Large": 0.25,
    "Extra Large": 0.11
  },

  gloveTotalEvents: 300 /* number of “consumption events” across range */
};

/* ============================================================
   COLORS
   ============================================================ */
const gloveColors =
{
  "Small": "#4aa3df",
  "Medium": "#42d392",
  "Large": "#f1a64b",
  "Extra Large": "#f16464"
};

const connectionColors =
{
  "Disconnected": "#f16464",
  "Connected": "#42d392"
};

/* ============================================================
   UTIL
   ============================================================ */
function isoDateOnly(d)
{
  const z = new Date(d);
  const yyyy = z.getFullYear();
  const mm = String(z.getMonth() + 1).padStart(2, "0");
  const dd = String(z.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatDisplayDateTime(iso)
{
  try
  {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
  }
  catch
  {
    return String(iso);
  }
}

function dateRangeToUtcIso(fromDateStr, toDateStr)
{
  /* English comment:
     BioT search APIs typically accept timestamp objects with ISO strings.
     We convert date-only inputs into a full-day UTC range.
  */

  const fromIso = new Date(`${fromDateStr}T00:00:00.000Z`).toISOString();
  const toIso = new Date(`${toDateStr}T23:59:59.999Z`).toISOString();
  return { fromIso, toIso };
}

function setText(id, text)
{
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setHtml(id, html)
{
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function loadStarredIds()
{
  try
  {
    const raw = localStorage.getItem(STAR_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.map(String));
  }
  catch
  {
    return new Set();
  }
}

function persistStarredIds()
{
  try
  {
    const ids = devices.filter(d => d.starred).map(d => String(d.id));
    localStorage.setItem(STAR_STORAGE_KEY, JSON.stringify(ids));
  }
  catch
  {
    /* ignore */
  }
}

function applyStarredFromStorage()
{
  const starred = loadStarredIds();
  for (const d of devices)
  {
    d.starred = starred.has(String(d.id));
  }
}

/* ============================================================
   MOCK GENERATORS
   ============================================================ */
function generateDevicesMock()
{
  const list = [];

  for (let i = 0; i < MOCK.totalDevices; i++)
  {
    const id = (i < 10)
      ? `00-IG-100-25070000${String(60 + i).padStart(2, "0")}`
      : `${1000 + i}_Machine_${String(i).padStart(4, "0")}`;

    list.push(
    {
      id,
      connected: false,
      alerting: false,
      starred: false,
      lastConnectedAt: new Date(Date.now() - (Math.random() * 12 * 24 * 60 * 60 * 1000)).toISOString()
    });
  }

  /* Mark N connected */
  for (let i = 0; i < Math.min(MOCK.connectedDevices, list.length); i++)
  {
    list[i].connected = true;
    list[i].lastConnectedAt = new Date(Date.now() - Math.random() * 60 * 1000).toISOString();
  }

  /* Mark some alerting */
  for (let i = 0; i < Math.min(MOCK.alertingDevices, list.length); i++)
  {
    list[list.length - 1 - i].alerting = true;
  }

  return list;
}

function weightedPick(weights)
{
  const r = Math.random();
  let acc = 0;

  for (const k of Object.keys(weights))
  {
    acc += weights[k];
    if (r <= acc)
    {
      return k;
    }
  }

  return Object.keys(weights)[0];
}

function generateGloveEventsMock()
{
  const events = [];

  const to = new Date();
  const from = new Date(to.getTime() - MOCK.gloveDaysBack * 24 * 60 * 60 * 1000);

  for (let i = 0; i < MOCK.gloveTotalEvents; i++)
  {
    const t = new Date(from.getTime() + Math.random() * (to.getTime() - from.getTime()));
    const type = weightedPick(MOCK.gloveWeights);

    events.push(
    {
      ts: t.toISOString(),
      type,
      count: 1
    });
  }

  return events;
}

/* ============================================================
   GLOVES: mock filter + sum
   ============================================================ */
function filterGloveEvents(fromDateStr, toDateStr)
{
  const from = new Date(`${fromDateStr}T00:00:00.000Z`).getTime();
  const to = new Date(`${toDateStr}T23:59:59.999Z`).getTime();

  return gloveEvents.filter(e =>
  {
    const t = new Date(e.ts).getTime();
    return t >= from && t <= to;
  });
}

function sumGlovesByType(events)
{
  const totals =
  {
    "Small": 0,
    "Medium": 0,
    "Large": 0,
    "Extra Large": 0
  };

  for (const e of events)
  {
    if (totals[e.type] === undefined)
    {
      totals[e.type] = 0;
    }
    totals[e.type] += e.count;
  }

  return totals;
}

/* ============================================================
   LEGEND RENDER
   ============================================================ */
function renderLegend(container, labels, values, colors, total)
{
  container.innerHTML = "";

  labels.forEach((label, idx) =>
  {
    const val = values[idx];
    const pct = total > 0 ? Math.round((val / total) * 100) : 0;

    const row = document.createElement("div");
    row.className = "legend-row";

    const left = document.createElement("div");
    left.className = "legend-left";

    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = colors[label] || "#999";

    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = label;

    left.appendChild(dot);
    left.appendChild(name);

    const right = document.createElement("div");
    right.className = "legend-right";
    right.textContent = `${val} (${pct}%)`;

    row.appendChild(left);
    row.appendChild(right);

    container.appendChild(row);
  });
}

/* ============================================================
   ROUTING
   ============================================================ */
function setRoute(route)
{
  currentRoute = route;

  document.querySelectorAll(".nav-item").forEach(btn =>
  {
    const active = btn.dataset.route === route;
    btn.classList.toggle("active", active);
    if (active)
    {
      btn.setAttribute("aria-current", "page");
    }
    else
    {
      btn.removeAttribute("aria-current");
    }
  });

  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));

  if (route === "dashboard")
  {
    document.getElementById("view-dashboard").classList.remove("hidden");
    renderDevicesTable(devices);
    refreshConnectionChart();
  }

  if (route === "starred")
  {
    document.getElementById("view-starred").classList.remove("hidden");
    renderSimpleTable("starredTbody", devices.filter(d => d.starred));
  }

  if (route === "alerting")
  {
    document.getElementById("view-alerting").classList.remove("hidden");
    renderSimpleTable("alertingTbody", devices.filter(d => d.alerting));
  }
}

/* ============================================================
   DATE INPUT INIT
   ============================================================ */
function initGloveRangeInputs()
{
  const to = new Date();
  const from = new Date(to.getTime() - (MOCK.gloveDaysBack - 1) * 24 * 60 * 60 * 1000);

  document.getElementById("fromDate").value = isoDateOnly(from);
  document.getElementById("toDate").value = isoDateOnly(to);
}

/* ============================================================
   GLOVE CHART
   ============================================================ */
async function refreshGloveChart()
{
  const from = document.getElementById("fromDate").value;
  const to = document.getElementById("toDate").value;

  /* Clear previous subtitle (e.g., previous error). */
  setText("gloveSubtitle", "");

  let totals = null;

  if (dataMode === "biot")
  {
    /* English comment:
       In BioT mode, we pull totals from the API every time you hit Apply.
    */
    const { fromIso, toIso } = dateRangeToUtcIso(from, to);

    try
    {
      totals = await window.BiotApi.getGloveTotals(fromIso, toIso, devices);
      gloveTotalsOverride = totals;
    }
    catch (e)
    {
      /* If glove model is not configured yet, we show an explicit message and keep mock totals. */
      gloveTotalsOverride = null;

      setText("gloveSubtitle", `BioT error: ${String(e.message || e)}`);
      totals = sumGlovesByType(filterGloveEvents(from, to));
    }
  }
  else
  {
    const filtered = filterGloveEvents(from, to);
    totals = sumGlovesByType(filtered);
  }

  const labels = Object.keys(totals);
  const values = labels.map(k => totals[k]);
  const totalValue = values.reduce((a, b) => a + b, 0);

  setText("gloveTitle", `Glove Consumption (Total: ${totalValue})`);

  /* Only override subtitle if we didn't already set an error message above */
  if (!document.getElementById("gloveSubtitle").textContent.startsWith("BioT error:"))
  {
    setText("gloveSubtitle", `Filter: ${from} 00:00:00 to ${to} 23:59:59`);
  }

  renderLegend(document.getElementById("gloveLegend"), labels, values, gloveColors, totalValue);

  if (!gloveChart)
  {
    const ctx = document.getElementById("gloveChart");
    gloveChart = new Chart(ctx,
    {
      type: "pie",
      data:
      {
        labels,
        datasets:
        [{
          data: values,
          backgroundColor: labels.map(l => gloveColors[l] || "#999"),
          borderColor: "#ffffff",
          borderWidth: 2
        }]
      },
      options:
      {
        responsive: true,
        maintainAspectRatio: false,
        plugins:
        {
          legend: { display: false }
        }
      }
    });
  }
  else
  {
    gloveChart.data.labels = labels;
    gloveChart.data.datasets[0].data = values;
    gloveChart.data.datasets[0].backgroundColor = labels.map(l => gloveColors[l] || "#999");
    gloveChart.update();
  }
}

/* ============================================================
   CONNECTION CHART (auto from devices[])
   ============================================================ */
function refreshConnectionChart()
{
  const total = devices.length;
  const connected = devices.filter(d => d.connected).length;
  const disconnected = total - connected;

  setText("connTitle", `Device Connection Status (Total: ${total})`);
  setText("connSubtitle", `Connected: ${connected} | Disconnected: ${disconnected} (auto from devices[])`);

  const labels = ["Disconnected", "Connected"];
  const values = [disconnected, connected];

  renderLegend(document.getElementById("connLegend"), labels, values, connectionColors, total);

  if (!connChart)
  {
    const ctx = document.getElementById("connChart");
    connChart = new Chart(ctx,
    {
      type: "pie",
      data:
      {
        labels,
        datasets:
        [{
          data: values,
          backgroundColor: labels.map(l => connectionColors[l] || "#999"),
          borderColor: "#ffffff",
          borderWidth: 2
        }]
      },
      options:
      {
        responsive: true,
        maintainAspectRatio: false,
        plugins:
        {
          legend: { display: false }
        }
      }
    });
  }
  else
  {
    connChart.data.datasets[0].data = values;
    connChart.update();
  }
}

/* ============================================================
   TABLE SORT
   ============================================================ */
function compareValues(a, b, key)
{
  if (key === "connected")
  {
    return (a.connected === b.connected) ? 0 : (a.connected ? 1 : -1);
  }

  if (key === "lastConnectedAt")
  {
    return new Date(a.lastConnectedAt).getTime() - new Date(b.lastConnectedAt).getTime();
  }

  return String(a.id).localeCompare(String(b.id));
}

function getSortedDevices(list)
{
  const copy = [...list];

  copy.sort((a, b) =>
  {
    const c = compareValues(a, b, sortState.key);
    return (sortState.dir === "asc") ? c : -c;
  });

  return copy;
}

function setSortIndicators()
{
  document.querySelectorAll(".sort-ind").forEach(el => el.textContent = "");

  const ind = document.querySelector(`.sort-ind[data-ind="${sortState.key}"]`);
  if (!ind)
  {
    return;
  }

  ind.textContent = (sortState.dir === "asc") ? "▲" : "▼";
}

/* ============================================================
   TABLE RENDER
   ============================================================ */
function renderDevicesTable(list)
{
  const tbody = document.getElementById("devicesTbody");
  tbody.innerHTML = "";

  const sorted = getSortedDevices(list);
  setSortIndicators();

  for (const d of sorted)
  {
    const tr = document.createElement("tr");

    /* Star */
    const tdStar = document.createElement("td");
    const starBtn = document.createElement("button");
    starBtn.className = `star-btn ${d.starred ? "on" : "off"}`;
    starBtn.textContent = "★";
    starBtn.title = "Toggle starred";
    starBtn.addEventListener("click", () =>
    {
      d.starred = !d.starred;
      persistStarredIds();

      if (currentRoute === "dashboard")
      {
        renderDevicesTable(devices);
      }
      else if (currentRoute === "starred")
      {
        renderSimpleTable("starredTbody", devices.filter(x => x.starred));
      }
    });

    tdStar.appendChild(starBtn);

    /* ID */
    const tdId = document.createElement("td");
    tdId.textContent = d.id;

    /* Last connected */
    const tdLast = document.createElement("td");
    tdLast.textContent = formatDisplayDateTime(d.lastConnectedAt);

    /* Connected */
    const tdConn = document.createElement("td");
    const status = document.createElement("span");
    status.className = "status";

    const dot = document.createElement("span");
    dot.className = `dot ${d.connected ? "ok" : ""}`;

    const txt = document.createElement("span");
    txt.textContent = d.connected ? "Connected" : "Disconnected";

    status.appendChild(dot);
    status.appendChild(txt);
    tdConn.appendChild(status);

    /* Alert */
    const tdAlert = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `alert-badge ${d.alerting ? "on" : ""}`;
    badge.textContent = d.alerting ? "ON" : "—";
    tdAlert.appendChild(badge);

    tr.appendChild(tdStar);
    tr.appendChild(tdId);
    tr.appendChild(tdLast);
    tr.appendChild(tdConn);
    tr.appendChild(tdAlert);

    tbody.appendChild(tr);
  }
}

function renderSimpleTable(tbodyId, list)
{
  const tbody = document.getElementById(tbodyId);
  tbody.innerHTML = "";

  const sorted = getSortedDevices(list);

  for (const d of sorted)
  {
    const tr = document.createElement("tr");

    const tdStar = document.createElement("td");
    const starBtn = document.createElement("button");
    starBtn.className = `star-btn ${d.starred ? "on" : "off"}`;
    starBtn.textContent = "★";
    starBtn.title = "Toggle starred";
    starBtn.addEventListener("click", () =>
    {
      d.starred = !d.starred;
      persistStarredIds();

      if (currentRoute === "starred")
      {
        renderSimpleTable("starredTbody", devices.filter(x => x.starred));
      }
      else
      {
        renderDevicesTable(devices);
      }
    });
    tdStar.appendChild(starBtn);

    const tdId = document.createElement("td");
    tdId.textContent = d.id;

    const tdLast = document.createElement("td");
    tdLast.textContent = formatDisplayDateTime(d.lastConnectedAt);

    const tdConn = document.createElement("td");
    tdConn.textContent = d.connected ? "Connected" : "Disconnected";

    const tdAlert = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `alert-badge ${d.alerting ? "on" : ""}`;
    badge.textContent = d.alerting ? "ON" : "—";
    tdAlert.appendChild(badge);

    tr.appendChild(tdStar);
    tr.appendChild(tdId);
    tr.appendChild(tdLast);
    tr.appendChild(tdConn);
    tr.appendChild(tdAlert);

    tbody.appendChild(tr);
  }
}

/* ============================================================
   UI EVENTS
   ============================================================ */
function wireUI()
{
  /* Navigation */
  document.querySelectorAll(".nav-item").forEach(btn =>
  {
    btn.addEventListener("click", () =>
    {
      setRoute(btn.dataset.route);
    });
  });

  /* Date filter */
  document.getElementById("applyFilterBtn").addEventListener("click", async () =>
  {
    await refreshGloveChart();
  });

  document.getElementById("resetFilterBtn").addEventListener("click", async () =>
  {
    initGloveRangeInputs();
    await refreshGloveChart();
  });

  /* Sorting headers */
  document.querySelectorAll("th.sortable").forEach(th =>
  {
    th.addEventListener("click", () =>
    {
      const key = th.dataset.sort;

      if (sortState.key === key)
      {
        sortState.dir = (sortState.dir === "asc") ? "desc" : "asc";
      }
      else
      {
        sortState.key = key;
        sortState.dir = "asc";
      }

      if (currentRoute === "dashboard")
      {
        renderDevicesTable(devices);
      }
    });
  });
}

/* ============================================================
   BIO T: load real data
   ============================================================ */
async function tryEnableBiotMode()
{
  if (!window.BiotApi)
  {
    return false;
  }

  /* English comment:
     We give BioT a short time to provide tokens via URL params or postMessage.
     If it doesn't arrive, we fall back to mock.
  */
  const ready = await window.BiotApi.waitForReady(1500);

  if (!ready)
  {
    return false;
  }

  if (!window.BiotApi.session.apiBase || !window.BiotApi.session.accessToken)
  {
    return false;
  }

  dataMode = "biot";
  return true;
}

async function loadDevicesFromBiot()
{
  const uiList = await window.BiotApi.loadDevicesUiShape();
  devices = uiList;
  applyStarredFromStorage();

  /* Update dashboard UI */
  if (currentRoute === "dashboard")
  {
    renderDevicesTable(devices);
  }
  refreshConnectionChart();
}

/* ============================================================
   UI MODE INDICATORS
   ============================================================ */
function setUiModeMock()
{
  setText("dataModeText", "Mock data prototype");
  setHtml("dataNote", 'MOCK DATA: Replace the config + generators in <b>dashboard.js</b>.');
}

function setUiModeBiot()
{
  const org = window.BiotApi.session.orgId ? ` | Org: ${window.BiotApi.session.orgId}` : "";
  setText("dataModeText", `BioT live data${org}`);

  /* If glove mapping is still placeholder, hint it explicitly */
  const g = window.BiotApi.config.gloveMeasurement;
  const attrs = Object.values(g.attributesByType || {});
  const hasPlaceholders = attrs.some(a => String(a).startsWith("glove_"));

  if (hasPlaceholders)
  {
    setHtml("dataNote", 'BIO T CONNECTED ✅ &nbsp; | &nbsp; <b>Glove mapping is still placeholder</b> (edit <b>biot_api.js</b> → BIOT_CONFIG.gloveMeasurement.attributesByType).');
  }
  else
  {
    setHtml("dataNote", 'BIO T CONNECTED ✅');
  }
}

/* ============================================================
   BOOT
   ============================================================ */
async function boot()
{
  /* Step 1: Wire UI events (buttons, sorting, navigation) */
  wireUI();

  /* Step 2: Initialize date filter inputs */
  initGloveRangeInputs();

  /* Step 3: Decide mode (BioT if possible, else mock) */
  const biotEnabled = await tryEnableBiotMode();

  if (biotEnabled)
  {
    setUiModeBiot();

    /* Step 4A: Pull real devices */
    await loadDevicesFromBiot();

    /* Step 5A: Pull glove totals for default date range */
    await refreshGloveChart();

    /* Step 6A: Auto-refresh devices (live connectivity) */
    const interval = window.BiotApi.config.refreshIntervalMs.devices;
    setInterval(async () =>
    {
      try
      {
        await loadDevicesFromBiot();
      }
      catch
      {
        /* ignore periodic errors */
      }
    }, interval);
  }
  else
  {
    dataMode = "mock";
    setUiModeMock();

    /* Step 4B: Generate mock data */
    devices = generateDevicesMock();
    gloveEvents = generateGloveEventsMock();

    applyStarredFromStorage();

    /* Step 5B: Render charts */
    await refreshGloveChart();
    refreshConnectionChart();
  }

  /* Step 7: Default route render */
  setRoute("dashboard");
}

boot();
