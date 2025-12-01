const adminAuth = (req, res, next) => {
  // Assumes req.user is populated by auth middleware
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!req.user.isAdmin) {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
};

module.exports = adminAuth;
