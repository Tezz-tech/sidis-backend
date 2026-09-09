const jwt = require('jsonwebtoken');

// Verifies the admin JWT issued by POST /api/admin/login. Distinct from the
// regular user `auth` middleware — a normal student's token has no
// `isAdmin` claim and is rejected here, so the two sessions can never be
// mixed up.
const adminAuth = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No admin token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    req.admin = { email: decoded.email };
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired admin token' });
  }
};

module.exports = adminAuth;
