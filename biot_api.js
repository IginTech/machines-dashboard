/* ============================================================
   BioT API INTEGRATION LAYER (browser-only)
   ============================================================
   This file is intentionally standalone so you can:
   - keep your UI code (dashboard.js) clean
   - swap API endpoints / mappings in ONE place

   IMPORTANT SECURITY NOTES:
   - Do NOT log tokens.
   - Prefer receiving tokens via postMessage (BIOT_TOKEN) OR via BIOT dynamic URL params.
   - If you host this dashboard on a different domain than the BioT APIs, you may need CORS allow-listing.

   Docs used (BioT official docs):
   - Token refresh: POST /ums/v2/users/token/refresh
   - Search devices: /device/v2/devices
   - Connection details: GET /device/v2/devices/{id}/connection/details
   - Search raw measurements: /measurement/v2/measurements/raw

   (All endpoints are documented at docs.biot-med.com)
*/

(function()
{
  "use strict";

  /* ------------------------------------------------------------
     CONFIG (EDIT THESE)
     ------------------------------------------------------------
     TODO (YOU MUST SET):
       - apiBase: your tenant API endpoint, e.g. https://<your api endpoint>
         (The same base that appears in BioT docs examples)

     OPTIONAL:
       - machineTemplateName / machineTemplateId: if you want to fetch ONLY your machine devices.
       - gloveMeasurement: map glove types to BioT measurement attribute names.
  */
  const BIOT_CONFIG =
  {
    /* REQUIRED: The BioT API base URL (no trailing slash).
       Example: https://example.com
       NOTE: If you embed this dashboard inside BioT and BioT is configured to pass apiBase
             as a URL param, you can leave this null and pass it via ?apiBase=... */
    apiBase: null,

    /* OPTIONAL: filter the device list by template */
    machineTemplateName: "IGIN Device", /* e.g. "IG-Machine" */
    machineTemplateId: null,   /* e.g. "3fa85f64-..." */

    /* OPTIONAL: tighten postMessage origin check (recommended).
       If null/empty => accepts any origin (NOT recommended for production). */
    allowedParentOrigins: null, /* e.g. ["https://app.biot-med.com"] */

    /* How often to refresh live data */
    refreshIntervalMs:
    {
      devices: 20_000,  /* live connection status */
      gloves: 60_000    /* glove chart */
    },

    /* Glove consumption mapping
       ------------------------------------------------------------
       TODO: You must tell me where glove consumption lives in BioT.

       Option A (recommended): raw measurements attached to each MACHINE device
         - We query /measurement/v2/measurements/raw
         - filter by _sourceEntity.id (device id) + timestamp range
         - attributes IN [attrSmall, attrMedium, ...]

       If you use a DIFFERENT model (patient-based, sessions, analytics, etc.) we'll adjust.
    */
    gloveMeasurement:
    {
      mode: "raw_per_device", /* "raw_per_device" | "raw_single_device" | "aggregated_patient" */

      /* Only used when mode === "raw_single_device" */
      singleDeviceId: null,

      /* Only used when mode === "aggregated_patient" (BioT aggregated endpoint requires patientId) */
      patientId: null,
      binIntervalSeconds: 86400,

      /* Map UI glove type => BioT measurement attribute name
         (PLACEHOLDER NAMES - you must replace!) */
      attributesByType:
      {
        "Small": "glove_small",        /* TODO */
        "Medium": "glove_medium",      /* TODO */
        "Large": "glove_large",        /* TODO */
        "Extra Large": "glove_xlarge"  /* TODO */
      },

      /* Safety: limits to avoid huge queries */
      maxPages: 20,
      pageSize: 200
    }
  };

  /* ------------------------------------------------------------
     HELPERS
     ------------------------------------------------------------ */
  function getQueryParams()
  {
    const p = new URLSearchParams(window.location.search);
    const obj = {};
    for (const [k, v] of p.entries())
    {
      obj[k] = v;
    }
    return obj;
  }

  function safeJsonParse(str)
  {
    try { return JSON.parse(str); }
    catch { return null; }
  }

  function encodeSearchRequest(reqObj)
  {
    return encodeURIComponent(JSON.stringify(reqObj));
  }

  function normalizeTokenValue(tokenLike)
  {
    if (typeof tokenLike === "string")
    {
      return tokenLike;
    }

    if (tokenLike && typeof tokenLike === "object" && typeof tokenLike.token === "string")
    {
      return tokenLike.token;
    }

    return null;
  }

  function errorToMessage(error)
  {
    return String((error && error.message) ? error.message : error);
  }

  function isSearchTransportError(error)
  {
    const msg = errorToMessage(error);

    return msg.includes("REQUEST_VALIDATION_FAILED")
      || msg.includes("searchRequest")
      || msg.includes("java.lang.String")
      || msg.includes("Method Not Allowed")
      || msg.includes("Request method")
      || msg.includes("Required request parameter")
      || msg.includes("415")
      || msg.includes("405");
  }

  function decodeJwtPayload(jwt)
  {
    /* Used ONLY to read exp (no validation). */
    try
    {
      const parts = jwt.split(".");
      if (parts.length < 2) return null;
      const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = payload + "===".slice((payload.length + 3) % 4);
      const json = atob(padded);
      return safeJsonParse(json);
    }
    catch
    {
      return null;
    }
  }

  function isJwtExpiringSoon(accessJwt, skewSeconds)
  {
    const p = decodeJwtPayload(accessJwt);
    if (!p || !p.exp) return true;
    const now = Math.floor(Date.now() / 1000);
    return (p.exp - now) <= skewSeconds;
  }

  async function sleep(ms)
  {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /* Simple concurrency limiter (no dependencies) */
  async function mapLimit(items, limit, mapper)
  {
    const results = new Array(items.length);
    let idx = 0;

    async function worker()
    {
      while (true)
      {
        const i = idx++;
        if (i >= items.length) break;
        results[i] = await mapper(items[i], i);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.max(1, limit); i++)
    {
      workers.push(worker());
    }

    await Promise.all(workers);
    return results;
  }

  /* ------------------------------------------------------------
     AUTH / CONTEXT (Iframe + URL params)
     ------------------------------------------------------------ */
  const session =
  {
    apiBase: null,

    /* tokens */
    accessToken: null,
    refreshToken: null,

    /* context */
    orgId: null,
    userId: null,

    /* internal */
    _readyResolvers: [],
    _isReady: false
  };

  function setReady()
  {
    session._isReady = true;
    for (const r of session._readyResolvers)
    {
      r(true);
    }
    session._readyResolvers = [];
  }

  function waitForReady(timeoutMs)
  {
    if (session._isReady) return Promise.resolve(true);

    return new Promise(resolve =>
    {
      session._readyResolvers.push(resolve);
      if (timeoutMs)
      {
        setTimeout(() => resolve(false), timeoutMs);
      }
    });
  }

  function isAllowedOrigin(origin)
  {
    if (!BIOT_CONFIG.allowedParentOrigins || BIOT_CONFIG.allowedParentOrigins.length === 0)
    {
      return true;
    }

    return BIOT_CONFIG.allowedParentOrigins.includes(origin);
  }

  function ingestFromUrlParams()
  {
    const q = getQueryParams();

    /* Common param names you can pass from BioT dynamic URL params:
       - accessToken / refreshToken / orgId
       - apiBase

       Example URL inside BioT tab config:
         https://<your-host>/index.html?apiBase=https://<your api endpoint>&accessToken={{user._accessToken}}&refreshToken={{user._refreshToken}}&orgId={{user._ownerOrganizationId}}
    */
    if (q.apiBase) session.apiBase = q.apiBase;

    /* Support multiple param names for convenience */
    if (q.accessToken) session.accessToken = q.accessToken;
    if (q._accessToken) session.accessToken = q._accessToken;

    if (q.refreshToken) session.refreshToken = q.refreshToken;
    if (q._refreshToken) session.refreshToken = q._refreshToken;

    if (q.orgId) session.orgId = q.orgId;
    if (q._ownerOrganizationId) session.orgId = q._ownerOrganizationId;

    if (q.userId) session.userId = q.userId;

    /* If we have apiBase + accessToken we are ready */
    if (session.apiBase && session.accessToken)
    {
      setReady();
    }
  }

  async function refreshAccessTokenIfNeeded()
  {
    /* If no refresh token is available, we cannot refresh. */
    if (!session.refreshToken)
    {
      return;
    }

    if (!session.accessToken || isJwtExpiringSoon(session.accessToken, 60))
    {
      const url = `${session.apiBase}/ums/v2/users/token/refresh`;

      const res = await fetch(url,
      {
        method: "POST",
        headers:
        {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(
        {
          refreshJwt: session.refreshToken
        })
      });

      if (!res.ok)
      {
        const txt = await res.text();
        throw new Error(`BioT token refresh failed (${res.status}): ${txt}`);
      }

      const data = await res.json();

      /* Based on BioT docs, response likely contains accessJwt + refreshJwt */
      const nextAccessToken =
        normalizeTokenValue(data.accessJwt)
        || normalizeTokenValue(data.accessToken)
        || normalizeTokenValue(data.token);

      const nextRefreshToken =
        normalizeTokenValue(data.refreshJwt)
        || normalizeTokenValue(data.refreshToken);

      if (nextAccessToken)
      {
        session.accessToken = nextAccessToken;
      }
      if (nextRefreshToken)
      {
        session.refreshToken = nextRefreshToken;
      }
    }
  }

  function handleMessage(event)
  {
    /* Security: validate origin */
    if (!isAllowedOrigin(event.origin))
    {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== "object")
    {
      return;
    }

    /* BioT sends:
       - BIOT_TOKEN: refresh token (and sometimes access) to embedded pages
       - BIOT_CONTEXT: organization/user context

       NOTE: message shapes may vary by BioT version/config.
       We handle a few common patterns.
    */

    if (data.type === "BIOT_TOKEN")
    {
      const refreshToken =
        normalizeTokenValue(data.token)
        || normalizeTokenValue(data.refreshJwt);

      const accessToken =
        normalizeTokenValue(data.accessJwt)
        || normalizeTokenValue(data.accessToken);

      if (refreshToken)
      {
        /* In BioT docs for iFrame embedding, this is typically a REFRESH token */
        session.refreshToken = refreshToken;
      }

      if (accessToken) session.accessToken = accessToken;

      /* If we have apiBase but no access token, we will refresh later */
    }

    if (data.type === "BIOT_CONTEXT")
    {
      /* The docs mention user._ownerOrganizationId and user._id
         Sometimes context is nested under data.context or data.user */
      const ctx = data.context || data;
      const user = ctx.user || ctx;

      if (!session.orgId)
      {
        session.orgId = user._ownerOrganizationId || user.ownerOrganizationId || user.orgId || null;
      }

      if (!session.userId)
      {
        session.userId = user._id || user.userId || null;
      }

      /* Some BioT deployments pass api endpoint in context */
      if (!session.apiBase)
      {
        session.apiBase = ctx.apiBase || ctx.apiEndpoint || null;
      }
    }

    /* If we don't have apiBase yet, try fallback from config */
    if (!session.apiBase)
    {
      const q = getQueryParams();
      session.apiBase = q.apiBase || BIOT_CONFIG.apiBase;
    }

    /* If we have refresh token but no access token, exchange now */
    if (session.apiBase && session.refreshToken && !session.accessToken)
    {
      refreshAccessTokenIfNeeded()
        .then(() =>
        {
          if (session.accessToken)
          {
            setReady();
          }
        })
        .catch(() =>
        {
          /* leave not-ready; UI will fall back */
        });
    }

    if (session.apiBase && session.accessToken)
    {
      setReady();
    }
  }

  /* ------------------------------------------------------------
     API WRAPPER
     ------------------------------------------------------------ */
  async function biotFetchJson(path, opts)
  {
    if (!session.apiBase)
    {
      throw new Error("BioT apiBase is missing (set BIOT_CONFIG.apiBase or pass ?apiBase=...)");
    }

    await refreshAccessTokenIfNeeded();

    const url = path.startsWith("http") ? path : `${session.apiBase}${path}`;

    const res = await fetch(url,
    {
      method: (opts && opts.method) ? opts.method : "GET",
      headers:
      {
        "Authorization": `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        ...(opts && opts.headers ? opts.headers : {})
      },
      body: (opts && opts.body) ? JSON.stringify(opts.body) : undefined
    });

    if (!res.ok)
    {
      const txt = await res.text();
      throw new Error(`BioT API error (${res.status}) on ${path}: ${txt}`);
    }

    return res.json();
  }

  function extractItems(resp)
  {
    /* BioT search APIs typically return { items: [...], page: {...} }
       But we keep it tolerant. */
    if (!resp) return [];
    if (Array.isArray(resp.items)) return resp.items;
    if (Array.isArray(resp.content)) return resp.content;
    if (Array.isArray(resp.pageContent)) return resp.pageContent;
    if (Array.isArray(resp.results)) return resp.results;
    if (Array.isArray(resp.data)) return resp.data;
    if (Array.isArray(resp)) return resp;
    return [];
  }

  async function biotSearch(path, searchRequest)
  {
    /* Some BioT environments accept POST search bodies, others only GET with a serialized searchRequest.
       We try POST first, then fall back to GET only for transport/binding errors. */
    let postError = null;

    try
    {
      return await biotFetchJson(path,
      {
        method: "POST",
        body: searchRequest
      });
    }
    catch (error)
    {
      postError = error;
      if (!isSearchTransportError(error))
      {
        throw error;
      }
    }

    try
    {
      const getPath = `${path}?searchRequest=${encodeSearchRequest(searchRequest)}`;
      return await biotFetchJson(getPath);
    }
    catch (getError)
    {
      if (!isSearchTransportError(getError))
      {
        throw getError;
      }

      throw new Error(
        `BioT search failed on ${path}. POST: ${errorToMessage(postError)} | GET: ${errorToMessage(getError)}`
      );
    }
  }

  /* ------------------------------------------------------------
     DEVICES
     ------------------------------------------------------------ */
  async function searchDevices()
  {
    /* We pull devices for orgId. If orgId is unknown, we pull without org filter.
       In production, you SHOULD filter by orgId to avoid cross-org leakage.
    */

    const filter = {};

    if (session.orgId)
    {
      filter["_ownerOrganization.id"] = { eq: session.orgId };
    }

    if (BIOT_CONFIG.machineTemplateId)
    {
      filter["_templateId"] = { eq: BIOT_CONFIG.machineTemplateId };
    }

    if (BIOT_CONFIG.machineTemplateName)
    {
      filter["_templateName"] = { eq: BIOT_CONFIG.machineTemplateName };
    }

    const searchRequest =
    {
      filter,
      sort:
      [{ prop: "_creationTime", order: "DESC" }],
      page: 0,
      limit: 200
    };

    const resp = await biotSearch("/device/v2/devices", searchRequest);
    return extractItems(resp);
  }

  function toIsoOrNow(value)
  {
    const d = new Date(value || Date.now());
    return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }

  function mapDeviceEntityToUi(entity)
  {
    /* English comments:
       - We normalize BioT device entity fields into the UI shape expected by dashboard.js.
       - Fields vary across BioT setups; adjust this mapper after seeing real JSON.
    */

    const id =
      entity.uniqueId
      || entity._uniqueId
      || entity._deviceUniqueId
      || entity.deviceId
      || entity._name
      || entity.name
      || entity._id
      || entity.id
      || "UNKNOWN";

    const conn = (entity._status && entity._status._connection) ? entity._status._connection : null;
    const hasConnectedFlag =
      (conn && typeof conn._connected === "boolean")
      || (typeof entity.connected === "boolean")
      || (typeof entity._connected === "boolean");

    const connected =
      (conn && typeof conn._connected === "boolean") ? conn._connected :
      (typeof entity.connected === "boolean") ? entity.connected :
      (typeof entity._connected === "boolean") ? entity._connected :
      false;

    /* Try a few common names for last seen time */
    const last =
      entity.lastConnectedAt
      || entity._lastConnectedAt
      || (conn && (conn._lastConnectedAt || conn._lastSeenAt || conn._lastSeenTime || conn._lastConnectionTime))
      || entity._lastModifiedTime
      || entity._updatedTime
      || entity._creationTime
      || entity.createdAt
      || null;

    return {
      id,
      connected,
      alerting: false, /* TODO: wire to BioT alerts once we decide the source */
      starred: false,  /* we override from localStorage in dashboard.js */
      lastConnectedAt: toIsoOrNow(last),
      _needsConnectionDetails: !hasConnectedFlag || !last
    };
  }

  async function getConnectionDetails(deviceId)
  {
    const path = `/device/v2/devices/${encodeURIComponent(deviceId)}/connection/details`;
    return biotFetchJson(path);
  }

  function mapConnDetailsToUi(connDetails, fallback)
  {
    /* connection/details response shape can differ.
       We try a few candidates and fallback to whatever we already have. */

    if (!connDetails)
    {
      return fallback;
    }

    const connected =
      (typeof connDetails.connected === "boolean") ? connDetails.connected :
      (typeof connDetails._connected === "boolean") ? connDetails._connected :
      fallback.connected;

    const last =
      connDetails.lastConnectedAt || connDetails._lastConnectedAt ||
      connDetails.lastSeenAt || connDetails._lastSeenAt ||
      connDetails.lastSeenTime || connDetails._lastSeenTime ||
      fallback.lastConnectedAt;

    return {
      ...fallback,
      connected,
      lastConnectedAt: toIsoOrNow(last),
      _needsConnectionDetails: false
    };
  }

  async function loadDevicesUiShape()
  {
    const entities = await searchDevices();
    const base = entities.map(mapDeviceEntityToUi);

    const missingConnectionData = base.filter(d => d._needsConnectionDetails);

    if (missingConnectionData.length === 0)
    {
      return base.map(({ _needsConnectionDetails, ...device }) => device);
    }

    const enriched = [...base];

    await mapLimit(missingConnectionData, 8, async (d) =>
    {
      try
      {
        const details = await getConnectionDetails(d.id);
        const index = enriched.findIndex(item => item.id === d.id);
        if (index >= 0)
        {
          enriched[index] = mapConnDetailsToUi(details, d);
        }
      }
      catch
      {
        /* keep the base device shape if details fail */
      }
    });

    return enriched.map(({ _needsConnectionDetails, ...device }) => device);
  }

  /* ------------------------------------------------------------
     GLOVES (PLACEHOLDER - needs your BioT model)
     ------------------------------------------------------------ */
  async function getGloveTotals(fromIso, toIso, devicesUi)
  {
    /* This function returns totals in the UI format:
       {
         "Small": 123,
         "Medium": 456,
         "Large": 789,
         "Extra Large": 42
       }

       TODO: This is the ONLY part that cannot be made "perfect" without your exact BioT data model.
             Once you show me ONE real measurement record (or the existing dashboard API call),
             I will wire it to 100%.
    */

    const mode = BIOT_CONFIG.gloveMeasurement.mode;

    if (mode === "raw_single_device")
    {
      if (!BIOT_CONFIG.gloveMeasurement.singleDeviceId)
      {
        throw new Error("gloveMeasurement.singleDeviceId is missing (set it in BIOT_CONFIG)");
      }

      return sumGlovesFromRawMeasurements([BIOT_CONFIG.gloveMeasurement.singleDeviceId], fromIso, toIso);
    }

    if (mode === "raw_per_device")
    {
      const ids = (devicesUi || []).map(d => d.id);
      return sumGlovesFromRawMeasurements(ids, fromIso, toIso);
    }

    if (mode === "aggregated_patient")
    {
      throw new Error("aggregated_patient is not implemented yet (needs patientId + attribute mapping confirmation)");
    }

    throw new Error(`Unknown gloveMeasurement.mode: ${mode}`);
  }

  async function sumGlovesFromRawMeasurements(deviceIds, fromIso, toIso)
  {
    const map = BIOT_CONFIG.gloveMeasurement.attributesByType;
    const types = Object.keys(map);
    const attrList = types.map(t => map[t]);

    const totals = {};
    for (const t of types)
    {
      totals[t] = 0;
    }

    /* WARNING: This can be a lot of API calls if you have many devices.
       If it becomes too slow, we will redesign with a server-side aggregation (recommended). */

    await mapLimit(deviceIds, 5, async (deviceId) =>
    {
      /* Build a searchRequest for raw measurements */
      const filter =
      {
        "_sourceEntity.id": { eq: deviceId },
        timestamp: { from: fromIso, to: toIso },
        attributes: { in: attrList }
      };

      let page = 0;
      const maxPages = BIOT_CONFIG.gloveMeasurement.maxPages;
      const limit = BIOT_CONFIG.gloveMeasurement.pageSize;

      while (page < maxPages)
      {
        const searchRequest =
        {
          filter,
          page,
          limit
        };

        const resp = await biotSearch("/measurement/v2/measurements/raw", searchRequest);
        const items = extractItems(resp);

        if (items.length === 0)
        {
          break;
        }

        /* Each raw measurement item typically contains an 'attributes' object.
           We try a few shapes.

           TODO: Once you paste 1 real raw-measurement JSON item, we will finalize this.
        */
        for (const it of items)
        {
          const attrs = it.attributes || it._attributes || it.data || null;
          if (!attrs) continue;

          /* attrs may be { glove_small: <number>, ... } */
          for (const t of types)
          {
            const attrName = map[t];

            const v = attrs[attrName];
            if (typeof v === "number") totals[t] += v;

            /* attrs may be an array of {name,value} */
            if (Array.isArray(attrs))
            {
              const found = attrs.find(x => x && (x.name === attrName || x.key === attrName));
              if (found && typeof found.value === "number") totals[t] += found.value;
            }
          }
        }

        if (items.length < limit)
        {
          break;
        }

        page++;
        await sleep(80);
      }
    });

    return totals;
  }

  /* ------------------------------------------------------------
     PUBLIC API
     ------------------------------------------------------------ */
  ingestFromUrlParams();

  window.addEventListener("message", handleMessage);

  /* Fallback: apiBase from config */
  if (!session.apiBase)
  {
    session.apiBase = BIOT_CONFIG.apiBase;
  }

  /* Expose a small surface area to the UI */
  window.BiotApi =
  {
    config: BIOT_CONFIG,
    session,
    waitForReady,
    refreshAccessTokenIfNeeded,

    loadDevicesUiShape,
    getGloveTotals
  };

})();
