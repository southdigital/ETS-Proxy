// CommonJS Netlify Function — returns { statusCode, headers, body }
const WEBFLOW_BASE = "https://api.webflow.com/v2";
const MAX_PAGE = 100;     // Webflow pagination page size
const PRESELECT = 25;     // shortlist size before Distance Matrix
const DM_CHUNK = 25;      // destinations per Distance Matrix request

// ---------- Utilities ----------
const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function response(body, status = 200) {
  return {
    statusCode: status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Cache-Control": "s-maxage=300, stale-while-revalidate=120",
    },
    body: JSON.stringify(body),
  };
}

// Pull every item from a collection (Webflow v2)
async function fetchAllWebflowItems(collectionId, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  let items = [];
  let offset = 0;

  while (true) {
    const url = `${WEBFLOW_BASE}/collections/${collectionId}/items?limit=${MAX_PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Webflow ${r.status}: ${await r.text()}`);

    const data = await r.json();
    const page = data?.items ?? [];
    items.push(...page);

    if (page.length < MAX_PAGE) break; // last page
    offset += page.length;
  }
  return items;
}

// Geocode a text query, restricted to US; or pass through lat/lng
async function geocode({ q, lat, lng, key }) {
  if (lat != null && lng != null) return { lat: Number(lat), lng: Number(lng) };
  if (!q) throw new Error("Provide either lat/lng or q");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    q
  )}&components=country:US&region=us&key=${key}`;

  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== "OK" || !j.results?.length) throw new Error(`Geocode failed: ${j.status}`);

  // extra guard: ensure result is in US
  const isUS = j.results[0].address_components.some(
    (c) => c.types.includes("country") && c.short_name === "US"
  );
  if (!isUS) throw new Error("Please enter a location in the United States.");

  const loc = j.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

// Distance Matrix for one origin and many destinations (imperial units)
async function distanceMatrix({ origin, dests, key }) {
  const out = [];
  for (let i = 0; i < dests.length; i += DM_CHUNK) {
    const batch = dests.slice(i, i + DM_CHUNK).map((d) => `${d.lat},${d.lng}`).join("|");
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${batch}&units=imperial&key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== "OK") throw new Error(`Distance Matrix: ${j.status}`);

    const row = j.rows?.[0];
    row?.elements?.forEach((el, idx) => {
      out.push({
        idx: i + idx,
        status: el.status,
        distance: el.distance || null,
        duration: el.duration || null,
      });
    });
  }
  return out;
}

// Map a Webflow item -> normalized location object using field slugs
function normalizeItem(item, siteBase) {
  const f = item.fieldData || {};

  // ---- UPDATE THESE SLUGS if yours differ ----
  // Your screenshot suggests plain-text fields named "Latitude" / "Longitude" in Designer.
  // Their slugs are usually `latitude` and `longitude`. We also fall back to common variants.
  const latStr = f.latitude ?? f.lat ?? f["Latitude"] ?? f["Lat"];
  const lngStr = f.longitude ?? f.lng ?? f["Longitude"] ?? f["Lng"];

  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Image could be a string or object with url
  const image =
    typeof f["main-featured-image"] === "string"
      ? f["main-featured-image"]
      : f["main-featured-image"]?.url ??
        f["location-map-image"]?.url ??
        null;

  const name = f.name || item.name || "Location";
  const address = f.address ?? f["Address"] ?? name;

  const slug = item.slug;
  // Optional URLs from CMS, else build from base
  const detailsUrl =
    (typeof f["details-url"] === "string" && f["details-url"]) ||
    `${siteBase}/locations/${slug}`;

  const bookUrl =
    (typeof f["book-url"] === "string" && f["book-url"]) ||
    `${siteBase}/book?location=${encodeURIComponent(slug)}`;

  return { id: item.id, name, lat, lng, image, address, detailsUrl, bookUrl, slug };
}

// ---------- Netlify handler ----------
exports.handler = async (event) => {
  // CORS / preflight
  if (event.httpMethod === "OPTIONS") return response({ ok: true }, 200);
  if (event.httpMethod !== "POST") return response({ error: "Use POST" }, 405);

  try {
    const { q, lat, lng, limit = 3 } = JSON.parse(event.body || "{}");

    const {
      WEBFLOW_TOKEN,
      WEBFLOW_COLLECTION_ID,
      GOOGLE_MAPS_API_KEY,
      WEBFLOW_SITE_BASE = "https://example.com",
    } = process.env;

    if (!WEBFLOW_TOKEN || !WEBFLOW_COLLECTION_ID || !GOOGLE_MAPS_API_KEY) {
      return response({
        error:
          "Missing env vars. Required: WEBFLOW_TOKEN, WEBFLOW_COLLECTION_ID, GOOGLE_MAPS_API_KEY",
      }, 500);
    }

    // 1) Resolve user origin
    const user = await geocode({ q, lat, lng, key: GOOGLE_MAPS_API_KEY });

    // 2) Fetch locations from Webflow CMS
    const items = await fetchAllWebflowItems(WEBFLOW_COLLECTION_ID, WEBFLOW_TOKEN);

    // 3) Normalize + skip missing lat/lng
    const locations = items
      .map((it) => normalizeItem(it, WEBFLOW_SITE_BASE))
      .filter(Boolean);

    if (!locations.length) return response({ error: "No locations with lat/lng found." }, 404);

    // 4) Haversine preselect to reduce Distance Matrix calls
    const pre = locations
      .map((l) => ({ ...l, airKm: haversineKm(user, l) }))
      .sort((a, b) => a.airKm - b.airKm)
      .slice(0, Math.min(PRESELECT, locations.length));

    // 5) Driving distance & ETA (Distance Matrix)
    const dm = await distanceMatrix({
      origin: user,
      dests: pre.map((l) => ({ lat: l.lat, lng: l.lng })),
      key: GOOGLE_MAPS_API_KEY,
    });

    // 6) Merge and choose best N
    const merged = pre.map((l, i) => {
      const m = dm.find((x) => x.idx === i && x.status === "OK");
      return {
        ...l,
        distanceText: m?.distance?.text || `${(l.airKm * 0.621371).toFixed(1)} mi`,
        distanceMeters: m?.distance?.value ?? Math.round(l.airKm * 1000),
        durationText: m?.duration?.text || null,
        durationSeconds: m?.duration?.value ?? null,
      };
    });

    merged.sort((a, b) => {
      if (a.durationSeconds != null && b.durationSeconds != null) {
        return a.durationSeconds - b.durationSeconds;
      }
      return a.distanceMeters - b.distanceMeters;
    });

    const top = merged.slice(0, Math.max(1, Math.min(Number(limit) || 3, 10)));

    // 7) Response payload (what your client needs)
    return response({
      user,
      count: top.length,
      items: top.map((l) => ({
        id: l.id,
        name: l.name,
        address: l.address,
        image: l.image,
        distanceText: l.distanceText,
        durationText: l.durationText,
        detailsUrl: l.detailsUrl,
        bookUrl: l.bookUrl,
        lat: l.lat,
        lng: l.lng,
      })),
    });
  } catch (err) {
    return response({ error: err.message }, 500);
  }
};
