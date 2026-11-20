const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const pool = require('../lib/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const addressInput = z.object({
  label: z.string().min(1).max(80).optional(),
  firstName: z.string().min(1),
  lastName: z.string().default(''),
  address: z.string().min(3),
  city: z.string().min(2),
  state: z.string().optional(),
  postcode: z.string().min(3),
  country: z.string().min(2).max(100).default('Australia'),
  defaultShipping: z.boolean().optional(),
  defaultBilling: z.boolean().optional()
});

function userId(req) { return req.session.user.id; }
function mapAddress(row) {
  return { id: row.id, label: row.label, firstName: row.firstName, lastName: row.lastName, address: row.address, city: row.city, state: row.state, postcode: row.postcode, country: row.country, defaultShipping: Boolean(row.defaultShipping), defaultBilling: Boolean(row.defaultBilling) };
}

router.get('/dashboard', async (req, res, next) => {
  try {
    const id = userId(req);
    const [[user]] = await pool.query('SELECT id, email, first_name AS firstName, last_name AS lastName, phone, profile_picture AS profilePicture, date_of_birth AS dateOfBirth, address FROM users WHERE id = ?', [id]);
    const [[summary]] = await pool.query(`SELECT COUNT(*) AS orderCount, COALESCE(SUM(total_cents), 0) AS lifetimeCents FROM orders WHERE user_id = ?`, [id]);
    const [orders] = await pool.query(`SELECT id, order_number AS orderNumber, total_cents AS totalCents, status, payment_provider AS paymentProvider, created_at AS createdAt FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 5`, [id]);
    const [[wishlist]] = await pool.query('SELECT COUNT(*) AS count FROM wishlists WHERE user_id = ?', [id]);
    const [[addresses]] = await pool.query('SELECT COUNT(*) AS count FROM user_addresses WHERE user_id = ?', [id]);
    res.json({ ok: true, user, summary: { orderCount: Number(summary.orderCount), lifetimeCents: Number(summary.lifetimeCents), wishlistCount: Number(wishlist.count), addressCount: Number(addresses.count) }, recentOrders: orders });
  } catch (error) { next(error); }
});

router.patch('/profile', async (req, res, next) => {
  try {
    const input = z.object({ firstName: z.string().min(1), lastName: z.string().default(''), phone: z.string().optional(), profilePicture: z.string().url().or(z.literal('')).optional(), dateOfBirth: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/).or(z.literal('')).optional() }).parse(req.body);
    await pool.query('UPDATE users SET first_name = ?, last_name = ?, phone = ?, profile_picture = ?, date_of_birth = NULLIF(?, "") WHERE id = ?', [input.firstName, input.lastName, input.phone || null, input.profilePicture || null, input.dateOfBirth || '', userId(req)]);
    req.session.user.firstName = input.firstName;
    req.session.user.lastName = input.lastName;
    res.json({ ok: true, user: { ...req.session.user, phone: input.phone || null, profilePicture: input.profilePicture || null, dateOfBirth: input.dateOfBirth || null } });
  } catch (error) { next(error); }
});


router.get('/orders/:id', async (req,res,next)=>{
  try{const [[order]]=await pool.query(`SELECT id,order_number AS orderNumber,email,first_name AS firstName,last_name AS lastName,address,city,state,postcode,country,subtotal_cents AS subtotalCents,shipping_cents AS shippingCents,total_cents AS totalCents,currency,status,payment_status AS paymentStatus,fulfilment_status AS fulfilmentStatus,carrier,tracking_number AS trackingNumber,created_at AS createdAt FROM orders WHERE id=? AND user_id=?`,[req.params.id,userId(req)]);if(!order)return res.status(404).json({ok:false,error:'Order not found.'});const [items]=await pool.query('SELECT product_id AS productId,name_snapshot AS name,price_cents AS priceCents,quantity FROM order_items WHERE order_id=?',[order.id]);const [events]=await pool.query('SELECT event_type AS eventType,description,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY created_at ASC',[order.id]);res.json({ok:true,order,items,events});}catch(e){next(e);}
});
router.post('/password',async(req,res,next)=>{try{const input=z.object({currentPassword:z.string().min(1),newPassword:z.string().min(10).max(128)}).parse(req.body);const [[user]]=await pool.query('SELECT password_hash FROM users WHERE id=?',[userId(req)]);if(!user||!(await bcrypt.compare(input.currentPassword,user.password_hash)))return res.status(400).json({ok:false,error:'Current password is incorrect.'});const hash=await bcrypt.hash(input.newPassword,12);await pool.query('UPDATE users SET password_hash=? WHERE id=?',[hash,userId(req)]);await pool.query('INSERT INTO activity_log (id,user_id,action,entity,entity_id,ip_address) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),userId(req),'PASSWORD_CHANGED','User',userId(req),req.ip]);res.json({ok:true});}catch(e){next(e);}});
router.post('/deletion-request',async(req,res,next)=>{try{const reason=z.string().max(500).optional().parse(req.body.reason);const [[existing]]=await pool.query("SELECT id FROM account_deletion_requests WHERE user_id=? AND status IN ('REQUESTED','PROCESSING') LIMIT 1",[userId(req)]);if(existing)return res.status(409).json({ok:false,error:'A deletion request is already pending.'});await pool.query('INSERT INTO account_deletion_requests (id,user_id,reason) VALUES (?,?,?)',[crypto.randomUUID(),userId(req),reason||null]);res.status(201).json({ok:true,message:'Your account deletion request has been submitted.'});}catch(e){next(e);}});

router.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query(`SELECT id, order_number AS orderNumber, email, first_name AS firstName, last_name AS lastName, address, city, state, postcode, country, subtotal_cents AS subtotalCents, shipping_cents AS shippingCents, total_cents AS totalCents, currency, status, payment_provider AS paymentProvider, created_at AS createdAt FROM orders WHERE user_id = ? ORDER BY created_at DESC`, [userId(req)]);
    const [items] = await pool.query('SELECT order_id AS orderId, product_id AS productId, name_snapshot AS name, price_cents AS priceCents, quantity FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = ?)', [userId(req)]);
    res.json({ ok: true, orders: orders.map(order => ({ ...order, items: items.filter(item => item.orderId === order.id) })) });
  } catch (error) { next(error); }
});


router.post('/orders/:id/reorder',async(req,res,next)=>{try{const [[owned]]=await pool.query('SELECT id FROM orders WHERE id=? AND user_id=?',[req.params.id,userId(req)]);if(!owned)return res.status(404).json({ok:false,error:'Order not found.'});const [items]=await pool.query(`SELECT i.product_id AS productId,i.quantity,p.stock,p.is_active AS isActive,p.track_inventory AS trackInventory FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=?`,[req.params.id]);const available=items.filter(i=>i.isActive&&(!i.trackInventory||Number(i.stock)>0)).map(i=>({id:i.productId,qty:Math.min(Number(i.quantity),i.trackInventory?Number(i.stock):Number(i.quantity))}));res.json({ok:true,items:available,unavailableCount:items.length-available.length});}catch(e){next(e);}});

router.post('/orders/:id/requests', async (req, res, next) => {
  try {
    const input = z.object({ type: z.enum(['CANCEL', 'RETURN', 'REFUND']), reason: z.string().max(500).optional() }).parse(req.body);
    const [orders] = await pool.query('SELECT id, status FROM orders WHERE id = ? AND user_id = ?', [req.params.id, userId(req)]);
    if (!orders[0]) return res.status(404).json({ ok: false, error: 'Order not found.' });
    if (input.type === 'CANCEL' && !['PENDING', 'PAID'].includes(orders[0].status)) return res.status(409).json({ ok: false, error: 'This order can no longer be cancelled.' });
    await pool.query('INSERT INTO order_requests (id, order_id, user_id, type, reason) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), req.params.id, userId(req), input.type, input.reason || null]);
    res.json({ ok: true, message: `${input.type.toLowerCase()} request submitted.` });
  } catch (error) { next(error); }
});

router.get('/orders/:id/invoice', async (req, res, next) => {
  try {
    const [[order]] = await pool.query(`SELECT order_number AS orderNumber, email, first_name AS firstName, last_name AS lastName, address, city, state, postcode, country, subtotal_cents AS subtotalCents, shipping_cents AS shippingCents, total_cents AS totalCents, currency, status, created_at AS createdAt FROM orders WHERE id = ? AND user_id = ?`, [req.params.id, userId(req)]);
    if (!order) return res.status(404).send('Order not found.');
    const [items] = await pool.query('SELECT name_snapshot AS name, price_cents AS priceCents, quantity FROM order_items WHERE order_id = ?', [req.params.id]);
    const money = cents => `$${(Number(cents) / 100).toFixed(2)} AUD`;
    const rows = items.map(item => `<tr><td>${item.name}</td><td>${item.quantity}</td><td>${money(item.priceCents * item.quantity)}</td></tr>`).join('');
    res.attachment(`invoice-${order.orderNumber}.html`).send(`<!doctype html><title>Invoice ${order.orderNumber}</title><style>body{font:16px sans-serif;max-width:760px;margin:40px auto;color:#222}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}</style><h1>Mills Smoke & Grill</h1><h2>Invoice ${order.orderNumber}</h2><p>${new Date(order.createdAt).toLocaleDateString('en-AU')}<br>${order.firstName} ${order.lastName}<br>${order.email}<br>${order.address}, ${order.city} ${order.postcode}</p><table><thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><p>Subtotal: ${money(order.subtotalCents)}<br>Shipping: ${money(order.shippingCents)}<br><strong>Total: ${money(order.totalCents)}</strong></p><p>Status: ${order.status}</p>`);
  } catch (error) { next(error); }
});

router.get('/addresses', async (req, res, next) => {
  try {
    const [rows] = await pool.query('SELECT id, label, first_name AS firstName, last_name AS lastName, address, city, state, postcode, country, is_default_shipping AS defaultShipping, is_default_billing AS defaultBilling FROM user_addresses WHERE user_id = ? ORDER BY is_default_shipping DESC, created_at DESC', [userId(req)]);
    res.json({ ok: true, addresses: rows.map(mapAddress) });
  } catch (error) { next(error); }
});

router.post('/addresses', async (req, res, next) => {
  try {
    const input = addressInput.parse(req.body);
    const id = crypto.randomUUID();
    if (input.defaultShipping) await pool.query('UPDATE user_addresses SET is_default_shipping = 0 WHERE user_id = ?', [userId(req)]);
    if (input.defaultBilling) await pool.query('UPDATE user_addresses SET is_default_billing = 0 WHERE user_id = ?', [userId(req)]);
    await pool.query('INSERT INTO user_addresses (id, user_id, label, first_name, last_name, address, city, state, postcode, country, is_default_shipping, is_default_billing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, userId(req), input.label || 'Shipping address', input.firstName, input.lastName, input.address, input.city, input.state || null, input.postcode, input.country, input.defaultShipping ? 1 : 0, input.defaultBilling ? 1 : 0]);
    res.status(201).json({ ok: true, id });
  } catch (error) { next(error); }
});

router.patch('/addresses/:id', async (req, res, next) => {
  try {
    const input = addressInput.partial().parse(req.body);
    const [existing] = await pool.query('SELECT id FROM user_addresses WHERE id = ? AND user_id = ?', [req.params.id, userId(req)]);
    if (!existing[0]) return res.status(404).json({ ok: false, error: 'Address not found.' });
    if (input.defaultShipping) await pool.query('UPDATE user_addresses SET is_default_shipping = 0 WHERE user_id = ?', [userId(req)]);
    if (input.defaultBilling) await pool.query('UPDATE user_addresses SET is_default_billing = 0 WHERE user_id = ?', [userId(req)]);
    const fields = { label: 'label', firstName: 'first_name', lastName: 'last_name', address: 'address', city: 'city', state: 'state', postcode: 'postcode', country: 'country', defaultShipping: 'is_default_shipping', defaultBilling: 'is_default_billing' };
    const set = []; const values = [];
    for (const [key, value] of Object.entries(input)) { set.push(`${fields[key]} = ?`); values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value); }
    if (set.length) await pool.query(`UPDATE user_addresses SET ${set.join(', ')} WHERE id = ? AND user_id = ?`, [...values, req.params.id, userId(req)]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

router.delete('/addresses/:id', async (req, res, next) => {
  try { await pool.query('DELETE FROM user_addresses WHERE id = ? AND user_id = ?', [req.params.id, userId(req)]); res.json({ ok: true }); } catch (error) { next(error); }
});

router.get('/wishlist', async (req, res, next) => {
  try { const [products] = await pool.query(`SELECT p.id, p.name, p.price_cents AS priceCents, p.stock, p.is_active AS isActive, p.metadata FROM wishlists w JOIN products p ON p.id = w.product_id WHERE w.user_id = ? ORDER BY w.created_at DESC`, [userId(req)]); res.json({ ok: true, products }); } catch (error) { next(error); }
});
router.post('/wishlist/:productId', async (req, res, next) => {
  try { await pool.query('INSERT IGNORE INTO wishlists (user_id, product_id) SELECT ?, id FROM products WHERE id = ?', [userId(req), req.params.productId]); res.json({ ok: true }); } catch (error) { next(error); }
});
router.delete('/wishlist/:productId', async (req, res, next) => {
  try { await pool.query('DELETE FROM wishlists WHERE user_id = ? AND product_id = ?', [userId(req), req.params.productId]); res.json({ ok: true }); } catch (error) { next(error); }
});

router.get('/payment-methods', async (req, res, next) => {
  try { const [methods] = await pool.query('SELECT id, provider, label, is_default AS isDefault, created_at AS createdAt FROM payment_methods WHERE user_id = ? ORDER BY is_default DESC, created_at DESC', [userId(req)]); res.json({ ok: true, paymentMethods: methods }); } catch (error) { next(error); }
});
router.post('/payment-methods', async (req, res, next) => {
  try { const input = z.object({ provider: z.string().min(1).max(40), label: z.string().min(1).max(120), providerToken: z.string().max(255).optional(), isDefault: z.boolean().optional() }).parse(req.body); if (input.isDefault) await pool.query('UPDATE payment_methods SET is_default = 0 WHERE user_id = ?', [userId(req)]); await pool.query('INSERT INTO payment_methods (id, user_id, provider, label, provider_token, is_default) VALUES (?, ?, ?, ?, ?, ?)', [crypto.randomUUID(), userId(req), input.provider, input.label, input.providerToken || null, input.isDefault ? 1 : 0]); res.status(201).json({ ok: true }); } catch (error) { next(error); }
});
router.delete('/payment-methods/:id', async (req, res, next) => {
  try { await pool.query('DELETE FROM payment_methods WHERE id = ? AND user_id = ?', [req.params.id, userId(req)]); res.json({ ok: true }); } catch (error) { next(error); }
});

module.exports = router;
