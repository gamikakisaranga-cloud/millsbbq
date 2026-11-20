const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const pool = require('../lib/db');
const { calculateDiscount } = require('../lib/commerce');
const { sendOrderInvoice } = require('../lib/mailer');

const router = express.Router();
const orderInput = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  address: z.string().min(3),
  city: z.string().min(2),
  state: z.string().optional(),
  postcode: z.string().min(3),
  country: z.literal('Australia').default('Australia'),
  couponCode: z.string().max(60).optional(),
  items: z.array(z.object({ productId: z.string(), quantity: z.number().int().min(1).max(50) })).min(1)
});

router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const input = orderInput.parse(req.body);
    const requested = new Map();
    for (const line of input.items) requested.set(line.productId, (requested.get(line.productId) || 0) + line.quantity);
    const productIds = [...requested.keys()];
    await connection.beginTransaction();
    const [productRows] = await connection.query(
      `SELECT * FROM products WHERE id IN (${productIds.map(() => '?').join(',')}) AND is_active = 1 FOR UPDATE`,
      productIds
    );
    const byId = new Map(productRows.map(product => [product.id, product]));

    const items = [...requested.entries()].map(([productId, quantity]) => {
      const product = byId.get(productId);
      if (!product || (product.track_inventory !== 0 && !product.allow_oversell && Number(product.stock) < quantity)) { const error = new Error(`Product unavailable or insufficient stock: ${productId}`); error.status = 409; throw error; }
      return { productId: product.id, nameSnapshot: product.name, priceCents: product.price_cents, quantity };
    });

    const subtotalCents = items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
    const [zoneRows] = await connection.query('SELECT * FROM delivery_zones WHERE city = ? LIMIT 1', [input.city]);
    const freeShippingThresholdCents = Number(process.env.FREE_SHIPPING_THRESHOLD_CENTS || 15000);
    let shippingCents = subtotalCents >= freeShippingThresholdCents ? 0 : (zoneRows[0]?.price_cents ?? 1500);
    let discountCents = 0; let selectedDiscount = null;
    if (input.couponCode) {
      const [discountRows] = await connection.query('SELECT * FROM discounts WHERE code=? AND is_active=1 FOR UPDATE', [input.couponCode.trim().toUpperCase()]);
      selectedDiscount = discountRows[0];
      if (!selectedDiscount) { const error=new Error('This discount code is invalid or inactive.'); error.status=400; throw error; }
      const now = new Date();
      if ((selectedDiscount.starts_at && new Date(selectedDiscount.starts_at)>now) || (selectedDiscount.expires_at && new Date(selectedDiscount.expires_at)<now)) { const error=new Error('This discount code is not currently valid.'); error.status=400; throw error; }
      if (subtotalCents < Number(selectedDiscount.minimum_order_cents)) { const error=new Error('Your order does not meet the minimum spend for this discount.'); error.status=400; throw error; }
      const [[usage]] = await connection.query("SELECT COUNT(*) AS used FROM discount_uses du JOIN orders o ON o.id=du.order_id WHERE du.discount_id=? AND o.payment_status IN ('PENDING','PAID','PARTIALLY_REFUNDED')",[selectedDiscount.id]);
      if (selectedDiscount.usage_limit && Number(usage.used)>=Number(selectedDiscount.usage_limit)) { const error=new Error('This discount code has reached its usage limit.'); error.status=400; throw error; }
      if (selectedDiscount.per_customer_limit && !req.session?.user?.id) { const error=new Error('Sign in to use this customer-limited discount.');error.status=400;throw error; }
      if (selectedDiscount.per_customer_limit && req.session?.user?.id) { const [[customerUsage]]=await connection.query("SELECT COUNT(*) AS used FROM discount_uses du JOIN orders o ON o.id=du.order_id WHERE du.discount_id=? AND du.user_id=? AND o.payment_status IN ('PENDING','PAID','PARTIALLY_REFUNDED')",[selectedDiscount.id,req.session.user.id]); if(Number(customerUsage.used)>=Number(selectedDiscount.per_customer_limit)){const error=new Error('You have already used this discount the maximum number of times.');error.status=400;throw error;} }
    }
    const totals = selectedDiscount ? calculateDiscount({type:selectedDiscount.type,value:selectedDiscount.value,subtotalCents,shippingCents}) : {discountCents:0,shippingCents,totalCents:subtotalCents+shippingCents};
    discountCents=totals.discountCents; shippingCents=totals.shippingCents; const totalCents=totals.totalCents;
    const orderId = crypto.randomUUID();
    const orderNumber = `MS-${Date.now().toString(36).toUpperCase()}`;

    await connection.query(
      `INSERT INTO orders (id, order_number, user_id, email, first_name, last_name, phone, address, city, state, postcode, country, subtotal_cents, shipping_cents, discount_cents, total_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, orderNumber, req.session?.user?.id || null, input.email, input.firstName, input.lastName, input.phone || null, input.address, input.city, input.state || null, input.postcode, input.country, subtotalCents, shippingCents, discountCents, totalCents]
    );
    for (const item of items) {
      const product = byId.get(item.productId);
      if (product.track_inventory !== 0) {
        const [stockUpdate] = product.allow_oversell ? await connection.query('UPDATE products SET stock = stock - ? WHERE id = ?', [item.quantity,item.productId]) : await connection.query('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', [item.quantity, item.productId, item.quantity]);
        if (!stockUpdate.affectedRows) { const error=new Error(`Insufficient stock: ${item.nameSnapshot}`); error.status=409; throw error; }
        await connection.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason,reference) VALUES (?,?,NULL,?,?,?,?,?,?)', [crypto.randomUUID(), item.productId, 'ORDER_DEDUCTION', product.stock, product.stock - item.quantity, -item.quantity, 'Stock reserved for order', orderNumber]);
      }
      await connection.query(
        'INSERT INTO order_items (id, order_id, product_id, name_snapshot, price_cents, quantity) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), orderId, item.productId, item.nameSnapshot, item.priceCents, item.quantity]
      );
    }
    if (selectedDiscount) await connection.query('INSERT INTO discount_uses (id,discount_id,order_id,user_id,discount_cents) VALUES (?,?,?,?,?)',[crypto.randomUUID(),selectedDiscount.id,orderId,req.session?.user?.id||null,discountCents]);
    await connection.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description) VALUES (?,?,?, ?, ?)', [crypto.randomUUID(), orderId, req.session?.user?.id || null, 'ORDER_CREATED', `Order ${orderNumber} created; stock reserved pending payment`]);
    await connection.commit();
    let invoiceEmailSent = false;
    try { const mail = await sendOrderInvoice(pool, orderId); invoiceEmailSent = Boolean(mail.sent); } catch (mailError) { console.error('[order invoice email]', mailError.message); }
    req.session.checkoutOrders = [...new Set([...(req.session.checkoutOrders || []), orderId])].slice(-20);

    res.status(201).json({ ok: true, invoiceEmailSent, order: { id: orderId, orderNumber, subtotalCents, shippingCents, discountCents, totalCents, currency: 'AUD' } });
  } catch (error) {
    await connection.rollback().catch(() => {});
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
