exports.handler = async (event, context) => {
  const { company_id } = event.queryStringParameters;

  // Validate that company_id was provided
  if (!company_id) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: "Missing company_id parameter" }),
    };
  }

  // 2. Retrieve your secure API key from Netlify Environment Variables
  const API_KEY = process.env.GYMMASTER_API_KEY;

  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server configuration error: API Key missing" }),
    };
  }
  const externalUrl = `https://etsperformance.gymmasteronline.com/portal/api/v1/booking/classes/schedule?companyid=${company_id}&api_key=${API_KEY}`;

  try {
    const response = await fetch(externalUrl);
    
    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `External API error: ${response.statusText}` }),
      };
    }

    const data = await response.json();
    return {
      statusCode: 200,
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch schedule", details: error.message }),
    };
  }
};