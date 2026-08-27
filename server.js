// server.js  (or index.js)
// Must run before any other require — several modules (utils/email.js among
// them) read process.env at module-load time, not lazily inside a function,
// so loading env vars any later can leave them permanently cached as unset.
require('dotenv').config();

const express = require('express');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const quizRoutes = require('./routes/quizzes');
const adminRoutes = require('./routes/admin');
const flashcardRoutes = require('./routes/flashcards');
let gamificationRoutes = null;
try { gamificationRoutes = require('./routes/gamification'); } catch (e) { console.error('gamification load error:', e.message); }
let studyPlannerRoutes = null;
try { studyPlannerRoutes = require('./routes/studyplanner'); console.log('studyplanner routes: loaded'); } catch (e) { console.error('studyplanner load error:', e.message, e.stack); }
let forecasterRoutes = null;
try { forecasterRoutes = require('./routes/forecaster'); console.log('forecaster routes: loaded'); } catch (e) { console.error('forecaster load error:', e.message, e.stack); }
let supportRoutes = null;
try { supportRoutes = require('./routes/support'); } catch (e) { console.error('support load error:', e.message); }
let paymentRoutes = null;
try { paymentRoutes = require('./routes/payments'); console.log('payment routes: loaded'); } catch (e) { console.error('payment load error:', e.message, e.stack); }
let adaptiveRoutes = null;
try { adaptiveRoutes = require('./routes/adaptive'); console.log('adaptive routes: loaded'); } catch (e) { console.error('adaptive load error:', e.message, e.stack); }
let collaborationRoutes = null;
try { collaborationRoutes = require('./routes/collaboration'); console.log('collaboration routes: loaded'); } catch (e) { console.error('collaboration load error:', e.message, e.stack); }
let groupRoutes = null;
try { groupRoutes = require('./routes/group'); console.log('group routes: loaded'); } catch (e) { console.error('group load error:', e.message, e.stack); }
const fileUpload = require('express-fileupload');
const cors = require('cors');

const app = express();

// -------------------------------------------------
// 1. CORS – allow **every** origin
// -------------------------------------------------
const corsOptions = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Respond to ALL preflight OPTIONS requests immediately with 200
app.options('*', cors(corsOptions));

// -------------------------------------------------
// 2. Make sure Vercel Serverless returns the headers
// -------------------------------------------------
app.use((req, res, next) => {
  // Reflect origin (allows any)
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);

  res.setHeader('Access-Control-Allow-Credentials', 'true');
  next();
});

// -------------------------------------------------
// 3. Other middleware
// -------------------------------------------------
connectDB();

app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 4 * 1024 * 1024 },  // 4 MB — Vercel hard limit is 4.5 MB
    abortOnLimit: true,
    responseOnLimit: JSON.stringify({ error: 'File too large. Each file must be under 4 MB.' }),
    useTempFiles: false,
    safeFileNames: true,
    preserveExtension: true,
  })
);

// -------------------------------------------------
// 4. Routes
// -------------------------------------------------

// Quick health check — no auth, no router, impossible to intercept.
// Routes through the shared AI client so this reflects the SAME
// model/key failover the rest of the app uses, and never leaks provider
// name, model name, or raw error text — only a clean ok/degraded/down status.
app.get('/api/health', async (req, res) => {
  const { gemini } = require('./utils/ai');

  let aiStatus = 'no keys configured';
  if (gemini.ready) {
    try {
      await gemini.generateText('Say: ok');
      aiStatus = 'ok';
    } catch (e) {
      console.error('[health] AI check failed:', e.message);
      aiStatus = 'degraded';
    }
  }

  let pdfStatus = false;
  try { require('pdf-parse/lib/pdf-parse.js'); pdfStatus = true; } catch (_) {
    try { require('pdf-parse'); pdfStatus = true; } catch (_2) {}
  }

  res.json({ ai: aiStatus, pdfParse: pdfStatus, keys: gemini.keyCount });
});

app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/quizzes', quizRoutes);

// Resolve possible export shapes (router, { default: router }, or module with .router)
let adminRouter = adminRoutes;
if (adminRouter && adminRouter.default) adminRouter = adminRouter.default;
if (adminRouter && adminRouter.router) adminRouter = adminRouter.router;

if (!adminRouter || (typeof adminRouter !== 'function' && typeof adminRouter !== 'object')) {
  console.error('Admin routes did not export a valid router — skipping mount of /api/admin');
} else {
  app.use('/api/admin', adminRouter);
}

app.use('/api/flashcards', flashcardRoutes);
if (gamificationRoutes)  app.use('/api/gamification',  gamificationRoutes);

// Study planner inline health check — always reachable regardless of router load
app.get('/api/study-planner/ping', (req, res) => {
  res.json({ ok: true, routesLoaded: !!studyPlannerRoutes });
});

if (studyPlannerRoutes)  app.use('/api/study-planner', studyPlannerRoutes);
if (forecasterRoutes)    app.use('/api/forecaster',    forecasterRoutes);
if (supportRoutes)       app.use('/api/support',       supportRoutes);
if (paymentRoutes)       app.use('/api/payments',      paymentRoutes);
if (adaptiveRoutes)      app.use('/api/adaptive',      adaptiveRoutes);
if (collaborationRoutes) app.use('/api/collaboration', collaborationRoutes);
if (groupRoutes)         app.use('/api/group',         groupRoutes);

// -------------------------------------------------
// 5. JSON 404 for any unmatched route (so CORS headers are always present)
// -------------------------------------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// -------------------------------------------------
// 6. Global error handler (still sends CORS headers)
// -------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err.stack);
  // Vercel will strip headers if we don’t set them again
  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  res.status(err.status || 500).json({ error: err.message || 'Something went wrong!' });
});

// -------------------------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Required for @vercel/node — export the Express app as the serverless handler
module.exports = app;