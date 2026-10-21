// utils/referral.js — referral code generation, shared by signup (new
// users) and a lazy backfill in GET /api/referrals/mine (existing users
// who signed up before this feature existed).
const crypto = require('crypto');
const User = require('../models/User');

function randomCode(name) {
  const base = (name || '').split(' ')[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'SIDIS';
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${base}${suffix}`;
}

// Tries a few short, name-based codes before falling back to a
// guaranteed-unique timestamp suffix — collisions are astronomically
// unlikely (16M+ combinations per name) but handled defensively since this
// touches a unique index.
async function generateUniqueReferralCode(name) {
  for (let i = 0; i < 5; i++) {
    const code = randomCode(name);
    const exists = await User.exists({ referralCode: code });
    if (!exists) return code;
  }
  return `${randomCode(name)}${Date.now().toString(36).toUpperCase()}`;
}

module.exports = { generateUniqueReferralCode };
