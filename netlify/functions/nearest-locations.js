// netlify/functions/nearest-locations.js
const WEBFLOW_BASE = "https://api.webflow.com/v2";
const MAX_PAGE = 100;
const PRESELECT = 25; // shortlist before Distance Matrix
const DM_CHUNK = 25;

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function fetchAllItems(collectionId, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  let out = [], offset = 0;
  while (true) {
    const url = `${WEBFLOW_BASE}/collections/${collectionId}/items?limit=${MAX_PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`Webflow ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const page = data?.items ?? [];
    out.push(...page);
    if (page.length < MAX_PAGE) break;
    offset += page.length;
  }
  return out;
}


async function geocode({ q, lat, lng, key }) {
  if (lat != null && lng != null) return { lat: +lat, lng: +lng };
  if (!q) throw new Error("Provide either lat/lng or q");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?` +
    `address=${encodeURIComponent(q)}&components=country:US&region=us&key=${key}`;

  const r = await fetch(url);
  const j = await r.json();
  if (j.status !== "OK" || !j.results?.length) throw new Error(`Geocode failed: ${j.status}`);

  // Hard gate: reject non-US results (extra safety)
  const isUS = j.results[0].address_components.some(
    c => c.types.includes('country') && c.short_name === 'US'
  );
  if (!isUS) throw new Error("Please enter a location in the United States.");

  const { lat: LAT, lng: LNG } = j.results[0].geometry.location;
  return { lat: LAT, lng: LNG };
}

async function distanceMatrix({ origin, dests, key }) {
  const res = [];
  for (let i = 0; i < dests.length; i += DM_CHUNK) {
    const batch = dests.slice(i, i + DM_CHUNK)
      .map(d => `${d.lat},${d.lng}`).join("|");
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lng}&destinations=${batch}&units=imperial&key=${key}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== "OK") throw new Error(`Distance Matrix: ${j.status}`);
    const row = j.rows?.[0];
    row?.elements?.forEach((el, idx) => {
      res.push({ idx: i + idx, status: el.status, distance: el.distance || null, duration: el.duration || null });
    });
  }
  return res;
}

const cors = (body, status=200) => ({
  statusCode: status,
  headers: {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "s-maxage=300, stale-while-revalidate=120",
  },
  body: JSON.stringify(body),
});

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") return cors({ ok: true });
  if (event.httpMethod !== "POST") return cors({ error: "Use POST" }, 405);

  try {
    const { q, lat, lng, limit = 3 } = JSON.parse(event.body || "{}");

    const {
      WEBFLOW_TOKEN,
      WEBFLOW_COLLECTION_ID,
      WEBFLOW_SITE_BASE = "https://ets-134dad-1ac025a23cf65f18e644fe3dc093.webflow.io/",
      GOOGLE_MAPS_API_KEY,
    } = process.env;

    if (!WEBFLOW_TOKEN || !WEBFLOW_COLLECTION_ID || !GOOGLE_MAPS_API_KEY)
      return cors({ error: "Missing env vars" }, 500);

    const user = await geocode({ q, lat, lng, key: GOOGLE_MAPS_API_KEY });

    // 1) Pull all locations
    const items = await fetchAllItems(WEBFLOW_COLLECTION_ID, WEBFLOW_TOKEN);

    // 2) Normalize using *slugs*; try a few variants to be safe
    const locations = items.map((it) => {
      const f = it.fieldData || {};
      const latStr = f.latitude ?? f.lat ?? f["Latitude"] ?? f["Lat"];
      const lngStr = f.longitude ?? f.lng ?? f["Longitude"] ?? f["Lng"];
      const latNum = Number(latStr);
      const lngNum = Number(lngStr);
      if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;

      const img =
        typeof f["main-featured-image"] === "string" ? f["main-featured-image"]
        : f["main-featured-image"]?.url ??
          f["mainFeaturedImage"]?.url ??
          f["location-map-image"]?.url ??
          null;

      const address = f.address ?? f["Address"] ?? it.name ?? "Location";
      const slug = it.slug;
      const detailsUrl = `${WEBFLOW_SITE_BASE}/locations/${slug}`;
      const bookUrl = `${WEBFLOW_SITE_BASE}/book?location=${encodeURIComponent(slug)}`;

      return {
        id: it.id,
        name: f.name || it.name || "Location",
        lat: latNum,
        lng: lngNum,
        image: img,
        address,
        detailsUrl,
        bookUrl,
      };
    }).filter(Boolean); // skips missing lat/lng

    if (!locations.length) return cors({ error: "No locations with lat/lng." }, 404);

    // 3) Haversine shortlist
    const withAir = locations.map((l) => ({ ...l, airKm: haversineKm(user, l) }))
      .sort((a, b) => a.airKm - b.airKm)
      .slice(0, Math.min(PRESELECT, locations.length));

    // 4) Distance Matrix for shortlist
    const dm = await distanceMatrix({
      origin: user,
      dests: withAir.map(l => ({ lat: l.lat, lng: l.lng })),
      key: GOOGLE_MAPS_API_KEY,
    });

    const merged = withAir.map((l, i) => {
      const m = dm.find(x => x.idx === i && x.status === "OK");
      return {
        ...l,
        distanceText: m?.distance?.text || `${(l.airKm * 0.621371).toFixed(1)} mi`,
        distanceMeters: m?.distance?.value ?? Math.round(l.airKm * 1000),
        durationText: m?.duration?.text || null,
        durationSeconds: m?.duration?.value ?? null,
      };
    });

    merged.sort((a, b) => {
      if (a.durationSeconds != null && b.durationSeconds != null)
        return a.durationSeconds - b.durationSeconds;
      return a.distanceMeters - b.distanceMeters;
    });

    const top = merged.slice(0, Math.max(1, Math.min(+limit || 3, 3)));

    return cors({
      user,
      items: top.map(l => ({
        id: l.id,
        name: l.name,
        address: l.address,
        image: l.image,
        distanceText: l.distanceText,
        durationText: l.durationText,
        detailsUrl: l.detailsUrl,
        bookUrl: l.bookUrl,
        lat: l.lat, lng: l.lng,
      })),
    });
  } catch (e) {
    return cors({ error: e.message }, 500);
  }
}