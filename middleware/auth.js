const ADMIN_ROLES = new Set(['ADMIN', 'OWNER', 'STORE_ADMIN', 'ORDER_MANAGER', 'INVENTORY_MANAGER', 'CUSTOMER_SUPPORT']);
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ ok: false, error: 'Authentication required.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!ADMIN_ROLES.has(req.session?.user?.role)) return res.status(403).json({ ok: false, error: 'Administrator access required.' });
  next();
}
function requireRoles(...roles) {
  return (req, res, next) => { const role = req.session?.user?.role; if (['ADMIN','OWNER'].includes(role) || (ADMIN_ROLES.has(role) && roles.includes(role))) return next(); return res.status(403).json({ok:false,error:'You do not have permission to perform this action.'}); };
}
module.exports = { requireAuth, requireAdmin, requireRoles, ADMIN_ROLES };
