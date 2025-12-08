// /.netlify/functions/hello
exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    body: "Hello from Netlify Function 👋",
  };
};