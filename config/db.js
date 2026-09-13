const mongoose = require('mongoose');

// Cached across warm serverless invocations (module-level state survives
// between requests hitting the same container). Safe to call repeatedly —
// returns instantly once connected, reuses an in-flight attempt instead of
// starting a second one, and lets a *failed* attempt be retried by the next
// caller rather than leaving the container permanently stuck disconnected.
let connectingPromise = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return; // already connected

  if (!connectingPromise) {
    connectingPromise = mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
      .then(() => { console.log('MongoDB connected'); })
      .catch((error) => {
        // Never process.exit() here — this runs inside a Vercel serverless
        // function, where killing the process takes down every
        // concurrent/future invocation sharing that warm container, not
        // just this one connection attempt.
        console.error('MongoDB connection error:', error.message);
        connectingPromise = null; // let the next call start a fresh attempt
        throw error;
      });
  }

  return connectingPromise;
}

module.exports = connectDB;
