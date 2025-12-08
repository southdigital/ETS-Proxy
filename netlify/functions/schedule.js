// netlify/functions/get-schedule.js

const { DateTime } = require("luxon");

exports.handler = async (event, context) => {
  // 1. Get the company ID from the incoming query parameters
  const { company_id } = event.queryStringParameters || {};

  if (!company_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing company_id parameter" }),
    };
  }

  // 2. Secure API key from Netlify env vars
  const API_KEY = process.env.GYMMASTER_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server configuration error: API Key missing",
      }),
    };
  }

  // 3. Construct the external API URL
  const externalUrl = `https://etsperformance.gymmasteronline.com/portal/api/v1/booking/classes/schedule?companyid=${company_id}&api_key=${API_KEY}`;

  try {
    // 4. Call the external API
    const response = await fetch(externalUrl);

    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({
          error: `External API error: ${response.statusText}`,
        }),
      };
    }

    const data = await response.json();

    // 5. Transform & sort data (grouped by date, times converted)
    const transformed = transformSchedule(data);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // So Webflow can fetch this directly
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify(transformed),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch schedule",
        details: error.message,
      }),
    };
  }
};

/**
 * Transform Gym Master schedule:
 * - interpret arrival/start/end as US Central (America/Chicago)
 * - convert to UTC
 * - group by central date
 * - sort by date, then start time
 */
function transformSchedule(apiResponse) {
  if (!apiResponse || !Array.isArray(apiResponse.result)) {
    return [];
  }

  const byDate = {};

  for (const item of apiResponse.result) {
    const { arrival, starttime, endtime } = item;

    if (!arrival || !starttime || !endtime) continue;

    // Central time (US) - handles CST/CDT by date
    const startCentral = DateTime.fromISO(
      `${arrival}T${starttime}`,
      { zone: "America/Chicago" }
    );
    const endCentral = DateTime.fromISO(
      `${arrival}T${endtime}`,
      { zone: "America/Chicago" }
    );

    if (!startCentral.isValid || !endCentral.isValid) continue;

    const startUtc = startCentral.toUTC();
    const endUtc = endCentral.toUTC();

    // Use CENTRAL date as the "day" for your Webflow tab
    const dateKey = startCentral.toISODate();      // "2025-12-08"
    const dayShort = startCentral.toFormat("ccc"); // "Mon"
    const dayFull = startCentral.toFormat("cccc"); // "Monday"

    if (!byDate[dateKey]) {
      byDate[dateKey] = {
        date: dateKey,   // 2025-12-08
        day: dayShort,   // Mon
        dayFull,         // Monday
        classes: [],
      };
    }

    byDate[dateKey].classes.push({
      id: item.id,
      classId: item.classid,
      name: item.classname,
      location: item.location || item.companyname,

      // Central time info (for display)
      dateCentral: dateKey,                       // 2025-12-08
      dayOfWeek: dayShort,                       // Mon
      startTimeCentral: startCentral.toFormat("HH:mm:ss"), // "06:15:00"
      endTimeCentral: endCentral.toFormat("HH:mm:ss"),     // "07:00:00"
      startTimeCentralStr: startCentral.toFormat("h:mm a"), // "6:15 AM"
      endTimeCentralStr: endCentral.toFormat("h:mm a"),     // "7:00 AM"

      // UTC time info (for consistency / other integrations)
      startTimeUTC: startUtc.toISO(),            // "2025-12-08T12:15:00.000Z"
      endTimeUTC: endUtc.toISO(),                // "2025-12-08T13:00:00.000Z"
      startTimeUTCShort: startUtc.toFormat("HH:mm"), // "12:15"
      endTimeUTCShort: endUtc.toFormat("HH:mm"),     // "13:00"

      // Optional fields you might use in Webflow
      availability: item.availability || null,
      description: item.description || null,
      descriptionHtml: item.description_html || null,
    });
  }

  // Convert object to array & sort
  const daysArray = Object.values(byDate);

  // Sort days by date ascending
  daysArray.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Sort classes inside each day by UTC start time
  for (const day of daysArray) {
    day.classes.sort((a, b) =>
      a.startTimeUTC < b.startTimeUTC
        ? -1
        : a.startTimeUTC > b.startTimeUTC
        ? 1
        : 0
    );
  }

  return daysArray;
}
