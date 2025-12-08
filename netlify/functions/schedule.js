// netlify/functions/schedule.js

const { DateTime } = require("luxon");

exports.handler = async (event, context) => {
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
          error: `External API error: ${response.statusText}`,
        }),
      };
    }

    const data = await response.json();

    function transformSchedule(apiResponse) {
      if (!apiResponse || !Array.isArray(apiResponse.result)) {
        return [];
      }

      const byDate = {};

      for (const item of apiResponse.result) {
        const { arrival, starttime, endtime } = item;

        if (!arrival || !starttime || !endtime) continue;

        // Central time (handles CST/CDT by date)
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

        const dateKey = startCentral.toISODate();          // "2025-12-08"
        const dayShort = startCentral.toFormat("ccc");     // "Mon"
        const dayFull = startCentral.toFormat("cccc");     // "Monday"

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

          // CENTRAL date / day (for Webflow tabs)
          dateCentral: dateKey,
          dayOfWeek: dayShort,

          // Start/end in CENTRAL (raw & pretty)
          startTimeCentral: startCentral.toFormat("HH:mm:ss"),
          endTimeCentral: endCentral.toFormat("HH:mm:ss"),
          startTimeCentralStr: startCentral.toFormat("h:mm a"),
          endTimeCentralStr: endCentral.toFormat("h:mm a"),

          // Start/end in UTC
          startTimeUTC: startUtc.toISO(),
          endTimeUTC: endUtc.toISO(),
          startTimeUTCShort: startUtc.toFormat("HH:mm"),
          endTimeUTCShort: endUtc.toFormat("HH:mm"),

          availability: item.availability || null,
          description: item.description || null,
          descriptionHtml: item.description_html || null,
        });
      }

      const daysArray = Object.values(byDate);

      // Sort days by date
      daysArray.sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0
      );

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
    console.error("schedule function error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to fetch schedule",
        details: error.message,
      }),
    };
  }
};