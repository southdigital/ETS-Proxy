// netlify/functions/schedule.js

// Helper: parse "YYYY-MM-DD"
function parseDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return {};
  const [year, month, day] = dateStr.split("-").map(Number);
  return { year, month, day };
}

// Helper: parse "HH:MM:SS"
function parseTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return {};
  const [hour, minute, second] = timeStr.split(":").map(Number);
  return { hour, minute, second: second || 0 };
}

// Helper: find Nth Sunday of a month (for DST calc)
function nthSundayOfMonth(year, month, nth) {
  // month: 1–12
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstDay = first.getUTCDay(); // 0 = Sunday
  const dayOfMonth = 1 + ((7 - firstDay) % 7) + (nth - 1) * 7;
  return new Date(Date.UTC(year, month - 1, dayOfMonth));
}

// Is this datetime in US Central DST?
function isUsCentralDst(year, month, day, hour) {
  // DST starts: 2nd Sunday in March at 2:00
  // DST ends: 1st Sunday in November at 2:00
  const dstStart = nthSundayOfMonth(year, 3, 2);
  dstStart.setUTCHours(2, 0, 0, 0);

  const dstEnd = nthSundayOfMonth(year, 11, 1);
  dstEnd.setUTCHours(2, 0, 0, 0);

  // Approximate the local datetime as UTC for comparison
  const localAsUtc = new Date(Date.UTC(year, month - 1, day, hour || 0, 0, 0));
  return localAsUtc >= dstStart && localAsUtc < dstEnd;
}

// Convert Central local datetime to a UTC Date
function centralToUtcDate(dateStr, timeStr) {
  const { year, month, day } = parseDate(dateStr);
  const { hour = 0, minute = 0, second = 0 } = parseTime(timeStr);

  if (!year || !month || !day) {
    // Fallback: still return a Date, but avoid throwing on toISOString
    return new Date(NaN);
  }

  const inDst = isUsCentralDst(year, month, day, hour);
  const offsetHours = inDst ? 5 : 6; // Central is UTC-6 (standard) or UTC-5 (DST)

  // Local Central -> UTC: add the offset hours
  return new Date(
    Date.UTC(year, month - 1, day, hour + offsetHours, minute, second)
  );
}

// Day names for display
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

async function handler(event, context) {
  const { company_id } = event.queryStringParameters || {};

  if (!company_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing company_id parameter" }),
    };
  }

  const API_KEY = process.env.GYMMASTER_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server configuration error: API Key missing",
      }),
    };
  }

  const externalUrl = `https://etsperformance.gymmasteronline.com/portal/api/v1/booking/classes/schedule?companyid=${company_id}&api_key=${API_KEY}`;

  try {
    const response = await fetch(externalUrl);

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `External API error: ${response.status} ${response.statusText}`,
        }),
      };
    }

    const data = await response.json();
    const transformed = transformSchedule(data);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // for Webflow
      },
      body: JSON.stringify(transformed),
    };
  } catch (error) {
    // If you run a linter that treats console.* as an error, you can remove this.
    console.error("schedule function error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch schedule",
        details: error.message,
      }),
    };
  }
}

// Classic Netlify Functions export
module.exports.handler = handler;

function transformSchedule(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.result)) {
    return [];
  }

  const byDate = {};

  for (const item of apiResponse.result) {
    const { arrival, starttime, endtime } = item;

    if (!arrival || !starttime || !endtime) continue;

    let startUtcIso = null;
    let endUtcIso = null;

    try {
      const startUtcDate = centralToUtcDate(arrival, starttime);
      const endUtcDate = centralToUtcDate(arrival, endtime);

      startUtcIso = startUtcDate.toISOString();
      endUtcIso = endUtcDate.toISOString();
    } catch {
      // If we fail to parse dates for a specific item, just skip that item
      continue;
    }

    // derive day names from Central date (same calendar date here)
    const { year, month, day } = parseDate(arrival);
    const centralDateAsUtc = new Date(Date.UTC(year, month - 1, day));
    const dowIndex = centralDateAsUtc.getUTCDay();

    const dayShort = DAY_SHORT[dowIndex];
    const dayFull = DAY_FULL[dowIndex];

    const dateKey = arrival; // e.g. "2025-12-08"

    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        date: dateKey,
        day: dayShort,
        dayFull,
        classes: [],
      };
    }

    byDate[dateKey].classes.push({
      id: item.id,
      classId: item.classid,
      name: item.classname,
      location: item.location || item.companyname,

      // Central date & day (for tabs)
      dateCentral: dateKey,
      dayOfWeek: dayShort,

      // Start / end in Central (raw from API)
      startTimeCentral: starttime, // "06:15:00"
      endTimeCentral: endtime, // "07:00:00"
      startTimeCentralStr: item.start_str || null, // "6:15 am"
      endTimeCentralStr: item.end_str || null, // "7:00 am"

      // UTC times
      startTimeUTC: startUtcIso, // "2025-12-08T12:15:00.000Z"
      endTimeUTC: endUtcIso, // "2025-12-08T13:00:00.000Z"
      startTimeUTCShort: startUtcIso.slice(11, 16), // "12:15"
      endTimeUTCShort: endUtcIso.slice(11, 16), // "13:00"

      availability: item.availability || null,
      description: item.description || null,
      descriptionHtml: item.description_html || null,
    });
  }

  const daysArray = Object.values(byDate);

  // Sort days by date ascending
  daysArray.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Sort classes in each day by UTC start time
  for (const day of daysArray) {
    day.classes.sort((a, b) =>
      a.startTimeUTC < b.startTimeUTC ? -1 : a.startTimeUTC > b.startTimeUTC ? 1 : 0
    );
  }

  return daysArray;
}
