// CommonJS Netlify Function — returns { statusCode, headers, body }
const WEBFLOW_BASE = "https://api.webflow.com/v2";
const MAX_PAGE = 100;
const PRESELECT = 25;
const DM_CHUNK = 25;

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function reply(body, status = 200) {
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
    if (page.length < MAX_PAGE) break;
    offset += page.length;
  }

  return items;
}

// Lock to US (remove &components=country:US if you want global)
async function geocode({ q, lat, lng, key }) {
  if (lat != null && lng != null) return { lat: +lat, lng: +lng };
  if (!q) throw new Error("Provide either lat/lng or q");

  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    q
  )}&components=country:US&region=us&key=${key}`;

  const r = await fetch(url);
  const j = await r.json();

  if (j.status !== "OK" || !j.results?.length) {
    throw new Error(`Geocode failed: ${j.status}`);
  }

  const isUS = j.results[0].address_components.some(
    (c) => c.types.includes("country") && c.short_name === "US"
  );
  if (!isUS) throw new Error("Please enter a location in the United States.");

  const loc = j.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng };
}

async function distanceMatrix({ origin, dests, key }) {
  const out = [];

  for (let i = 0; i < dests.length; i += DM_CHUNK) {
    const batch = dests
      .slice(i, i + DM_CHUNK)
      .map((d) => `${d.lat},${d.lng}`)
      .join("|");

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

// ---- Robust normalizer: slug from fieldData.slug, flexible image/address slugs
function normalizeItem(item, siteBase) {
  const f = item.fieldData || {};

  // Try common latitude/longitude slugs and labels
  const latStr = f.latitude ?? f.lat ?? f["Latitude"] ?? f["Lat"];
  const lngStr = f.longitude ?? f.lng ?? f["Longitude"] ?? f["Lng"];
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null; // skip missing lat/lng

  // 1) Slug is a system field in v2 and lives inside fieldData.slug
  const slug = f.slug || f.Slug || null;

  // 2) Image — try a few likely keys (string or object with url)
  const imageKeys = [
    "main-featured-image",
    "mainFeaturedImage",
    "featured-image",
    "featuredImage",
    "location-image",
    "locationImage",
    "image",
  ];
  let image = null;
  for (const key of imageKeys) {
    if (typeof f[key] === "string" && f[key]) {
      image = f[key];
      break;
    }
    if (f[key]?.url) {
      image = f[key].url;
      break;
    }
    // some Webflow image fields can be arrays (Multi-image) — take the first
    if (Array.isArray(f[key]) && f[key][0]?.url) {
      image = f[key][0].url;
      break;
    }
  }

  // 3) Address — try common keys
  const addressKeys = [
    "address",
    "Address",
    "street-address",
    "streetAddress",
    "location-address",
    "locationAddress",
  ];
  let address = null;
  for (const key of addressKeys) {
    if (typeof f[key] === "string" && f[key].trim()) {
      address = f[key].trim();
      break;
    }
  }
  if (!address) address = item.name || "Location";

  // 4) Details / Book URLs
  // If you store explicit URLs in CMS, prefer those; otherwise build from base + slug
  const detailsUrl =
    (typeof f["details-url"] === "string" && f["details-url"]) ||
    (typeof f["detailsUrl"] === "string" && f["detailsUrl"]) ||
    (slug
      ? `${siteBase.replace(/\/$/, "")}/locations/${slug}`
      : null);

  const bookUrl =
    (typeof f["book-url"] === "string" && f["book-url"]) ||
    (typeof f["bookUrl"] === "string" && f["bookUrl"]) ||
    (slug
      ? `${siteBase.replace(/\/$/, "")}/book?location=${encodeURIComponent(
          slug
        )}`
      : null);

  // 5) Directions link (always available with lat/lng)
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

  // 6) NEW — Iframe fields (match Webflow field slugs from your CMS)
  // Most likely keys (Webflow auto-slugifies labels):
  //   Booking Form Iframe ID  -> booking-form-iframe-id
  //   Calendar Iframe Src     -> calendar-iframe-src
  //   Calendar Iframe ID      -> calendar-iframe-id
  const bookingFormIframeId =
    f["booking-form-iframe-id"] ?? f.bookingFormIframeId ?? null;

  const calendarIframeSrc =
    f["calendar-iframe-src"] ?? f.calendarIframeSrc ?? null;

  const calendarIframeId =
    f["calendar-iframe-id"] ?? f.calendarIframeId ?? null;

  return {
    id: item.id,
    name: f.name || item.name || "Location",
    slug, // helpful for debugging
    lat,
    lng,
    image,
    address,
    detailsUrl,
    bookUrl,
    directionsUrl,

    // NEW:
    bookingFormIframeId,
    calendarIframeId,
    calendarIframeSrc,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return reply({ ok: true });
  if (event.httpMethod !== "POST") return reply({ error: "Use POST" }, 405);

  try {
    const { q, lat, lng, limit = 3 } = JSON.parse(event.body || "{}");

    const {
      WEBFLOW_TOKEN,
      WEBFLOW_COLLECTION_ID,
      GOOGLE_MAPS_API_KEY,
      WEBFLOW_SITE_BASE = "https://example.com",
    } = process.env;

    if (!WEBFLOW_TOKEN || !WEBFLOW_COLLECTION_ID || !GOOGLE_MAPS_API_KEY) {
      return reply(
        {
          error:
            "Missing env vars: WEBFLOW_TOKEN, WEBFLOW_COLLECTION_ID, GOOGLE_MAPS_API_KEY",
        },
        500
      );
    }

    // 1) Resolve user origin
    const user = await geocode({ q, lat, lng, key: GOOGLE_MAPS_API_KEY });

    // 2) Fetch + normalize items (skip missing lat/lng)
    const raw = await fetchAllWebflowItems(
      WEBFLOW_COLLECTION_ID,
      WEBFLOW_TOKEN
    );
    const locations = raw
      .map((it) => normalizeItem(it, WEBFLOW_SITE_BASE))
      .filter(Boolean);

    if (!locations.length) {
      return reply({ error: "No locations with lat/lng found." }, 404);
    }

    // -----------------------------
    // 3) Haversine shortlist (cost-saving)
    // Only send a small shortlist to Distance Matrix based on requested limit.
    // -----------------------------
    const safeLimit = Math.max(1, Math.min(Number(limit) || 3, 10));
    const DM_BUFFER = 3; // keep small to reduce cost, but preserve "fastest by driving" accuracy
    const shortlistN = Math.min(
      PRESELECT,
      safeLimit * DM_BUFFER,
      locations.length
    );

    const pre = locations
      .map((l) => ({ ...l, airKm: haversineKm(user, l) }))
      .sort((a, b) => a.airKm - b.airKm)
      .slice(0, shortlistN);

    // 4) Distance Matrix (driving) — now runs on smaller shortlist
    const dm = await distanceMatrix({
      origin: user,
      dests: pre.map((l) => ({ lat: l.lat, lng: l.lng })),
      key: GOOGLE_MAPS_API_KEY,
    });

    // 5) Merge + pick best N
    const merged = pre.map((l, i) => {
      const m = dm.find((x) => x.idx === i && x.status === "OK");
      return {
        ...l,
        distanceText:
          m?.distance?.text || `${(l.airKm * 0.621371).toFixed(1)} mi`,
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

    const top = merged.slice(0, safeLimit);

    return reply({
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
        directionsUrl: l.directionsUrl,
        lat: l.lat,
        lng: l.lng,

        // NEW:
        bookingFormIframeId: l.bookingFormIframeId,
        calendarIframeId: l.calendarIframeId,
        calendarIframeSrc: l.calendarIframeSrc,
      })),
    });
  } catch (e) {
    return reply({ error: e.message }, 500);
  }
};
