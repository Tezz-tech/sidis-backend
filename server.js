// server.js  (or index.js)
const express = require('express');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const quizRoutes = require('./routes/quizzes');
const flashcardRoutes = require('./routes/flashcards');
const fileUpload = require('express-fileupload');
const cors = require('cors');
require('dotenv').config();

const app = express();

// -------------------------------------------------
// 1. CORS – allow **every** origin
// -------------------------------------------------
app.use(
  cors({
    origin: true,               // reflect the request origin (allows any)
    credentials: true,          // allow cookies / Authorization header
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Preflight for all routes
app.options('*', cors());

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
    limits: { fileSize: 5 * 1024 * 1024 },
    abortOnLimit: true,
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
app.use('/api/flashcards', flashcardRoutes);

// -------------------------------------------------
// 5. Global error handler (still sends CORS headers)
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