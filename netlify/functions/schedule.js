exports.handler = async (event, context) => {
  // 1. Get the company ID from the incoming query parameters
  // URL will look like: /.netlify/functions/get-schedule?company_id=123
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

  // 3. Construct the external API URL
  const externalUrl = `https://etsperformance.gymmasteronline.com/portal/api/v1/booking/classes/schedule?companyid=${company_id}&api_key=${API_KEY}`;

  try {
    // 4. Call the external API
    const response = await fetch(externalUrl);
    
    // Check if the external response was successful
    if (!response.ok) {
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `External API error: ${response.statusText}` }),
      };
    }

    const data = await response.json();

    // 5. Return the data to your frontend
    return {
      statusCode: 200,
      // Optional: Add CORS headers if calling from a different domain
      // headers: {
      //   "Access-Control-Allow-Origin": "*", 
      //   "Content-Type": "application/json"
      // },
      body: JSON.stringify(data),
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch schedule", details: error.message }),
    };
  }
};