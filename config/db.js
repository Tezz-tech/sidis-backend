const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected');
  } catch (error) {
    // Never process.exit() here — this runs inside a Vercel serverless
    // function, where killing the process takes down every concurrent/future
    // invocation sharing that warm container, not just this one connection
    // attempt. A transient Atlas hiccup should surface as failed DB calls on
    // individual routes (each already has its own try/catch), not a total
    // outage. Mongoose also auto-retries in the background by default.
    console.error('MongoDB connection error:', error.message);
  }
};

module.exports = connectDB;