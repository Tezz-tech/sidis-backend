// Vercel native serverless entry point — a bracket catch-all filename means
// Vercel's own file-system routing handles every /api/* request and invokes
// this function with the full original request intact, no vercel.json
// rewrite/destination interpretation involved at all. Re-exports the same
// Express app server.js already builds and exports.
module.exports = require('../server.js');
