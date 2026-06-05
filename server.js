// server.js  (or index.js)
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
try { studyPlannerRoutes = require('./routes/studyplanner'); } catch (e) { console.error('studyplanner load error:', e.message); }
let forecasterRoutes = null;
try { forecasterRoutes = require('./routes/forecaster'); console.log('forecaster routes: loaded'); } catch (e) { console.error('forecaster load error:', e.message, e.stack); }
let supportRoutes = null;
try { supportRoutes = require('./routes/support'); } catch (e) { console.error('support load error:', e.message); }
const fileUpload = require('express-fileupload');
const cors = require('cors');
require('dotenv').config();

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
if (studyPlannerRoutes)  app.use('/api/study-planner', studyPlannerRoutes);
if (forecasterRoutes)    app.use('/api/forecaster',    forecasterRoutes);
if (supportRoutes)       app.use('/api/support',       supportRoutes);

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