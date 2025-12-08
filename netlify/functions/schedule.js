exports.handler = async (event, context) => {
  // --- CORS headers (open for now, tighten later) ---
  const headers = {
    'Access-Control-Allow-Origin': '*',              // change to your domain later
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight (in case browser sends OPTIONS)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: '',
    };
  }

  const { company_id } = event.queryStringParameters || {};

  // Validate that company_id was provided
  if (!company_id) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Missing company_id parameter" }),
    };
  }

  // 2. Retrieve your secure API key from Netlify Environment Variables
  const API_KEY = process.env.GYMMASTER_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server configuration error: API Key missing" }),
    };
  }

  const externalUrl = `https://etsperformance.gymmasteronline.com/portal/api/v1/booking/classes/schedule?companyid=${company_id}&api_key=${API_KEY}`;

  try {
    const response = await fetch(externalUrl);
    
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `External API error: ${response.statusText}` }),
      };
    }

    const data = await response.json();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Failed to fetch schedule", details: error.message }),
    };
  }
};