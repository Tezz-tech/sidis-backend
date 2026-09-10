// Vercel native serverless entry point for the whole Express app. Paired
// with the vercel.json rewrite "/(.*)" -> "/api", this is Vercel's own
// documented pattern for an Express app handling every route — re-exports
// the same app server.js already builds.
module.exports = require('../server.js');
