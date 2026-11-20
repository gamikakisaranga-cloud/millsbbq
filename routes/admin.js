const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const pool = require('../lib/db');
const { sendOrderConfirmation, sendNewsletterCampaign, isEmailConfigured } = require('../lib/mailer');
const { makeSlug } = require('../lib/commerce');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireAdmin);
function requireStaffRole(req,res,roles){if(['ADMIN','OWNER'].includes(req.session.user.role)||roles.includes(req.session.user.role))return true;res.status(403).json({ok:false,error:'You do not have permission to perform this action.'});return false;}

function reportRange(query) {
  const today = new Date();
  const period = query.period || '30d';
  const ranges = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
  if (query.from || query.to) {
    if (!query.from || !query.to || !/^\d{4}-\d{2}-\d{2}$/.test(query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(query.to)) {
      const error = new Error('Provide valid from and to dates in YYYY-MM-DD format.');
      error.status = 400;
      throw error;
    }
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T00:00:00.000Z`);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) ||
        from.toISOString().slice(0, 10) !== query.from || to.toISOString().slice(0, 10) !== query.to || from > to) {
      const error = new Error('The report date range is invalid.');
      error.status = 400;
      throw error;
    }
    to.setUTCDate(to.getUTCDate() + 1);
    return { from, to, label: 'custom' };
  }
  if (period === 'year') return { from: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)), to: today, label: period };
  if (!ranges[period]) {
    const error = new Error('Unsupported report period.');
    error.status = 400;
    throw error;
  }
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (ranges[period] - 1));
  from.setUTCHours(0, 0, 0, 0);
  return { from, to, label: period };
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${(/^[\s]*[=+\-@]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
}

router.get('/summary', async (req, res, next) => {
  try {
    const range = reportRange(req.query);
    const [currentRows] = await pool.query(
      `SELECT COUNT(*) AS orderCount,
              SUM(status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')) AS paidOrderCount,
              COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED') THEN total_cents + discount_cents ELSE 0 END), 0) AS grossSalesCents,
              COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED') THEN total_cents - shipping_cents ELSE 0 END), 0) AS netSalesBeforeRefundsCents,
              COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED') THEN discount_cents ELSE 0 END), 0) AS discountsCents,
              COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED') THEN shipping_cents ELSE 0 END), 0) AS shippingCents,
              SUM(status = 'PENDING') AS pendingOrders,
              SUM(status = 'CANCELLED') AS cancelledOrders,
              COALESCE((SELECT SUM(r.amount_cents) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE ro.created_at >= ? AND ro.created_at < ? AND r.status IN ('PENDING','SUCCEEDED')),0) AS refundCents
       FROM orders WHERE created_at >= ? AND created_at < ?`,
      [range.from, range.to, range.from, range.to]
    );
    const [previousRows] = await pool.query(
      `SELECT COUNT(*) AS orderCount,
              COALESCE(SUM(CASE WHEN status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED') THEN total_cents + discount_cents ELSE 0 END), 0) AS grossSalesCents
       FROM orders WHERE created_at >= ? AND created_at < ?`,
      [new Date(range.from.getTime() - (range.to - range.from)), range.from]
    );
    const [customerRows] = await pool.query(
      `SELECT COUNT(*) AS newCustomers FROM users
       WHERE role = 'CUSTOMER' AND created_at >= ? AND created_at < ?`,
      [range.from, range.to]
    );
    const [productRows] = await pool.query('SELECT COUNT(*) AS products, SUM(stock <= low_stock_threshold) AS lowStockProducts, COALESCE(SUM(stock * cost_price_cents),0) AS inventoryValueCents FROM products WHERE is_active = 1');
    const [[customerTotal]] = await pool.query("SELECT COUNT(*) AS totalCustomers FROM users WHERE role='CUSTOMER'");
    const [soldRows] = await pool.query(
      `SELECT COALESCE(SUM(i.quantity), 0) AS productsSold
       FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE o.created_at >= ? AND o.created_at < ?
         AND o.status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')`,
      [range.from, range.to]
    );
    const current = currentRows[0];
    const previous = previousRows[0];
    res.json({
      ok: true,
      period: range.label,
      from: range.from,
      to: range.to,
      summary: {
        orderCount: Number(current.orderCount),
        paidOrderCount: Number(current.paidOrderCount),
        grossSalesCents: Number(current.grossSalesCents),
        netSalesBeforeRefundsCents: Number(current.netSalesBeforeRefundsCents),
        shippingCents: Number(current.shippingCents),
        discountsCents: Number(current.discountsCents),
        averageOrderValueCents: current.paidOrderCount ? Math.round(Number(current.grossSalesCents - current.discountsCents) / Number(current.paidOrderCount)) : 0,
        pendingOrders: Number(current.pendingOrders),
        cancelledOrders: Number(current.cancelledOrders),
        refundCents: Number(current.refundCents),
        netAfterRefundsCents: Math.max(0, Number(current.grossSalesCents) - Number(current.discountsCents) - Number(current.refundCents)),
        newCustomers: Number(customerRows[0].newCustomers),
        productsSold: Number(soldRows[0].productsSold),
        products: Number(productRows[0].products),
        lowStockProducts: Number(productRows[0].lowStockProducts || 0),
        inventoryValueCents: ['ADMIN','OWNER'].includes(req.session.user.role) ? Number(productRows[0].inventoryValueCents) : null,
        totalCustomers: Number(customerTotal.totalCustomers),
        previousOrderCount: Number(previous.orderCount),
        previousGrossSalesCents: Number(previous.grossSalesCents),
        refundsTracked: true,
        currency: 'AUD'
      }
    });
  } catch (error) { next(error); }
});

router.get('/reports/sales', async (req, res, next) => {
  try {
    const range = reportRange(req.query);
    const [report] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
              COUNT(*) AS orders,
              COALESCE(SUM(total_cents + discount_cents), 0) AS grossSalesCents,
              COALESCE(SUM(total_cents - shipping_cents), 0) AS netSalesBeforeRefundsCents,
              COALESCE(SUM(shipping_cents), 0) AS shippingCents,
              COALESCE(SUM(discount_cents), 0) AS discountsCents,
              COALESCE((SELECT SUM(r.amount_cents) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE DATE(ro.created_at)=DATE(orders.created_at) AND r.status IN ('PENDING','SUCCEEDED')),0) AS refundCents
       FROM orders
       WHERE created_at >= ? AND created_at < ?
         AND status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) ASC`,
      [range.from, range.to]
    );
    const [itemRows] = await pool.query(
      `SELECT DATE_FORMAT(o.created_at, '%Y-%m-%d') AS day, COALESCE(SUM(i.quantity), 0) AS itemsSold
       FROM orders o JOIN order_items i ON i.order_id = o.id
       WHERE o.created_at >= ? AND o.created_at < ?
         AND o.status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')
       GROUP BY DATE(o.created_at)`,
      [range.from, range.to]
    );
    const itemsByDay = new Map(itemRows.map(row => [row.day, Number(row.itemsSold)]));
    const rows = report.map(row => ({ ...row, orders: Number(row.orders), grossSalesCents: Number(row.grossSalesCents), netSalesBeforeRefundsCents: Number(row.netSalesBeforeRefundsCents), shippingCents: Number(row.shippingCents), discountsCents: Number(row.discountsCents), refundCents: Number(row.refundCents), itemsSold: itemsByDay.get(row.day) || 0 }));
    res.json({ ok: true, from: range.from, to: range.to, currency: 'AUD', refundsTracked: true, report: rows });
  } catch (error) { next(error); }
});

router.get('/reports/sales.csv', async (req, res, next) => {
  try {
    const range = reportRange(req.query);
    const [rows] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS orders,
              COALESCE(SUM(total_cents + discount_cents), 0) AS grossSalesCents,
              COALESCE(SUM(total_cents - shipping_cents), 0) AS netSalesBeforeRefundsCents,
              COALESCE(SUM(shipping_cents), 0) AS shippingCents,
              COALESCE(SUM(discount_cents), 0) AS discountsCents,
              COALESCE((SELECT SUM(r.amount_cents) FROM refunds r JOIN orders ro ON ro.id=r.order_id WHERE DATE(ro.created_at)=DATE(orders.created_at) AND r.status IN ('PENDING','SUCCEEDED')),0) AS refundCents
       FROM orders WHERE created_at >= ? AND created_at < ?
         AND status IN ('PAID','PROCESSING','SHIPPED','DELIVERED','REFUNDED')
       GROUP BY DATE(created_at) ORDER BY DATE(created_at) ASC`,
      [range.from, range.to]
    );
    const csv = [
      ['date', 'orders', 'gross_sales_before_discounts_aud', 'net_merchandise_sales_before_refunds_aud', 'discounts_aud', 'shipping_aud'].map(csvCell).join(','),
      ...rows.map(row => [
        row.day,
        row.orders,
        (Number(row.grossSalesCents) / 100).toFixed(2),
        (Number(row.netSalesBeforeRefundsCents) / 100).toFixed(2),
        (Number(row.discountsCents) / 100).toFixed(2),
        (Number(row.shippingCents) / 100).toFixed(2)
      ].map(csvCell).join(','))
    ].join('\r\n');
    res.attachment('mills-sales-report.csv').type('text/csv').send(csv);
  } catch (error) { next(error); }
});

router.get('/products', async (req, res, next) => {
  try {
    const [products] = await pool.query(
      `SELECT id, slug, name, description, price_cents AS priceCents, stock, is_active AS isActive, metadata, created_at AS createdAt, updated_at AS updatedAt
       FROM products ORDER BY created_at DESC`
    );
    res.json({ ok: true, products });
  } catch (error) { next(error); }
});

router.patch('/products/:id', async (req, res, next) => {
  try {
    if(!requireStaffRole(req,res,['STORE_ADMIN']))return;
    const input = z.object({
      name: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      priceCents: z.number().int().nonnegative().optional(),
      stock: z.number().int().nonnegative().optional(),
      isActive: z.boolean().optional(),
      sku: z.string().max(80).nullable().optional(),
      imageUrl: z.string().url().max(1000).refine(v=>/^https:\/\//i.test(v)).nullable().optional(),
      comparePriceCents: z.number().int().nonnegative().nullable().optional(),
      costPriceCents: z.number().int().nonnegative().nullable().optional()
    }).parse(req.body);

    if (input.costPriceCents !== undefined && !['ADMIN','OWNER'].includes(req.session.user.role)) return res.status(403).json({ok:false,error:'Cost price is restricted to owner and super admin roles.'});
    const fieldMap = { name: 'name', description: 'description', priceCents: 'price_cents', stock: 'stock', isActive: 'is_active', sku: 'sku', imageUrl: 'image_url', comparePriceCents: 'compare_price_cents', costPriceCents: 'cost_price_cents' };
    const setClauses = [];
    const values = [];
    for (const [key, value] of Object.entries(input)) {
      if (key === 'stock') continue;
      setClauses.push(`${fieldMap[key]} = ?`);
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (!setClauses.length && input.stock === undefined) return res.status(400).json({ ok: false, error: 'No fields to update.' });
    if (setClauses.length) await pool.query(`UPDATE products SET ${setClauses.join(', ')} WHERE id = ?`, [...values, req.params.id]);
    if (input.stock !== undefined) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[before]] = await conn.query('SELECT stock FROM products WHERE id=? FOR UPDATE', [req.params.id]);
        if (!before) { await conn.rollback(); return res.status(404).json({ok:false,error:'Product not found.'}); }
        const diff = Number(input.stock) - Number(before.stock);
        await conn.query('UPDATE products SET stock=? WHERE id=?', [input.stock, req.params.id]);
        if (diff !== 0) await conn.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason) VALUES (?,?,?,?,?,?,?,?)', [crypto.randomUUID(),req.params.id,req.session.user.id,'ADJUSTMENT',before.stock,input.stock,diff,'Manual product edit stock adjustment']);
        await conn.commit();
      } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
    }
    const [rows] = await pool.query(
      'SELECT id, slug, name, description, price_cents AS priceCents, stock, is_active AS isActive, sku, image_url AS imageUrl FROM products WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    const product = rows[0];
    if (!product) return res.status(404).json({ ok: false, error: 'Product not found.' });

    await pool.query(
      'INSERT INTO activity_log (id, user_id, action, entity, entity_id, metadata, ip_address) VALUES (?, ?, "UPDATE", "Product", ?, ?, ?)',
      [crypto.randomUUID(), req.session.user.id, product.id, JSON.stringify(input), req.ip]
    );
    res.json({ ok: true, product });
  } catch (error) { next(error); }
});

router.get('/orders', async (req, res, next) => {
  try {
    const [orders] = await pool.query(
      `SELECT id, order_number AS orderNumber, email, first_name AS firstName, last_name AS lastName,
              city, total_cents AS totalCents, status, payment_provider AS paymentProvider, created_at AS createdAt
       FROM orders ORDER BY created_at DESC`
    );
    const [items] = await pool.query('SELECT order_id AS orderId, product_id AS productId, name_snapshot AS name, price_cents AS priceCents, quantity FROM order_items');
    const withItems = orders.map(order => ({ ...order, items: items.filter(item => item.orderId === order.id) }));
    res.json({ ok: true, orders: withItems });
  } catch (error) { next(error); }
});

router.patch('/orders/:id', async (req, res, next) => {
  try {
    if(!requireStaffRole(req,res,['ORDER_MANAGER']))return;
    const input = z.object({ status: z.enum(['PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED']) }).parse(req.body);
    const connection = await pool.getConnection();
    let order;
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query('SELECT id, order_number AS orderNumber, status, payment_status AS paymentStatus FROM orders WHERE id = ? FOR UPDATE', [req.params.id]);
      order = rows[0];
      if (!order) {
        await connection.rollback();
        return res.status(404).json({ ok: false, error: 'Order not found.' });
      }
      const allowedTransitions = {
        PENDING: ['CANCELLED'],
        PAID: ['PROCESSING'],
        PROCESSING: ['SHIPPED'],
        SHIPPED: ['DELIVERED']
      };
      if (!allowedTransitions[order.status]?.includes(input.status)) {
        await connection.rollback();
        return res.status(409).json({ ok: false, error: 'This order status transition is not allowed.' });
      }
      if (input.status === 'CANCELLED' && order.paymentStatus === 'PENDING') {
        const [lines] = await connection.query('SELECT product_id,quantity FROM order_items WHERE order_id=?', [req.params.id]);
        for (const line of lines) {
          const [[product]] = await connection.query('SELECT stock,track_inventory FROM products WHERE id=? FOR UPDATE', [line.product_id]);
          if (!product || !product.track_inventory) continue;
          const before=Number(product.stock), after=before+Number(line.quantity);
          await connection.query('UPDATE products SET stock=? WHERE id=?',[after,line.product_id]);
          await connection.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason,reference) VALUES (?,?,?, ?,?,?,?,?,?)',[crypto.randomUUID(),line.product_id,req.session.user.id,'ORDER_RESTOCK',before,after,line.quantity,'Restored after administrator cancellation',order.orderNumber]);
        }
        await connection.query('UPDATE orders SET status=?,payment_status="FAILED",fulfilment_status="CANCELLED" WHERE id=?',[input.status,req.params.id]);
      } else { await connection.query('UPDATE orders SET status = ? WHERE id = ?', [input.status, req.params.id]); }
      await connection.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description,metadata) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),req.params.id,req.session.user.id,'STATUS_CHANGE',`Order status changed to ${input.status}`,JSON.stringify({from:order.status,to:input.status})]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await pool.query(
      'INSERT INTO activity_log (id, user_id, action, entity, entity_id, metadata, ip_address) VALUES (?, ?, "UPDATE", "Order", ?, ?, ?)',
      [crypto.randomUUID(), req.session.user.id, req.params.id, JSON.stringify({ from: order.status, to: input.status }), req.ip]
    );
    res.json({ ok: true, order: { id: order.id, orderNumber: order.orderNumber, status: input.status } });
  } catch (error) { next(error); }
});


router.post('/orders/:id/resend-confirmation',async(req,res,next)=>{try{const [[o]]=await pool.query('SELECT id,payment_status FROM orders WHERE id=?',[req.params.id]);if(!o)return res.status(404).json({ok:false,error:'Order not found.'});if(o.payment_status!=='PAID'&&o.payment_status!=='PARTIALLY_REFUNDED')return res.status(409).json({ok:false,error:'Only paid orders can receive a payment confirmation email.'});const result=await sendOrderConfirmation(pool,o.id);if(!result.sent)return res.status(503).json({ok:false,error:result.reason});await pool.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description,metadata) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),o.id,req.session.user.id,'EMAIL_RESENT','Order confirmation email resent',JSON.stringify({providerId:result.id})]);res.json({ok:true});}catch(e){next(e);}});
router.post('/orders/:id/refunds', async(req,res,next)=>{
  try{
    if(!['ADMIN','OWNER'].includes(req.session.user.role))return res.status(403).json({ok:false,error:'Only an owner or super admin can issue refunds.'});
    if(!process.env.ADYEN_API_KEY||!process.env.ADYEN_MERCHANT_ACCOUNT)return res.status(503).json({ok:false,error:'Adyen refund API is not configured.'});
    const input=z.object({amountCents:z.number().int().positive(),reason:z.string().max(500).optional()}).parse(req.body);
    const [[order]]=await pool.query('SELECT id,order_number,total_cents,currency,payment_status FROM orders WHERE id=?',[req.params.id]);
    if(!order)return res.status(404).json({ok:false,error:'Order not found.'});
    if(order.payment_status!=='PAID'&&order.payment_status!=='PARTIALLY_REFUNDED')return res.status(409).json({ok:false,error:'Only paid orders can be refunded.'});
    const [[payment]]=await pool.query("SELECT id,provider,provider_payment_id FROM payments WHERE order_id=? AND status='PAID' ORDER BY created_at DESC LIMIT 1",[order.id]);
    if(!payment||payment.provider!=='ADYEN')return res.status(409).json({ok:false,error:'No eligible Adyen payment was found for this order.'});
    const [[totals]]=await pool.query("SELECT COALESCE(SUM(amount_cents),0) AS refunded FROM refunds WHERE order_id=? AND status IN ('PENDING','SUCCEEDED')",[order.id]);
    const remaining=Number(order.total_cents)-Number(totals.refunded);if(input.amountCents>remaining)return res.status(400).json({ok:false,error:'Refund exceeds the remaining refundable amount.'});
    const refundId=crypto.randomUUID();await pool.query('INSERT INTO refunds (id,order_id,payment_id,amount_cents,currency,status,reason,created_by) VALUES (?,?,?,?,?,?,?,?)',[refundId,order.id,payment.id,input.amountCents,order.currency,'PENDING',input.reason||null,req.session.user.id]);
    let response,data;try{response=await fetch(`${(process.env.ADYEN_API_URL||'https://checkout-test.adyen.com/v71').replace(/\/+$/,'')}/payments/${encodeURIComponent(payment.provider_payment_id)}/refunds`,{method:'POST',headers:{'X-API-Key':process.env.ADYEN_API_KEY,'Content-Type':'application/json','Idempotency-Key':refundId},body:JSON.stringify({merchantAccount:process.env.ADYEN_MERCHANT_ACCOUNT,amount:{currency:order.currency,value:input.amountCents},reference:refundId})});data=await response.json();}catch(e){await pool.query('UPDATE refunds SET status="FAILED" WHERE id=?',[refundId]);throw e;}
    if(!response.ok){await pool.query('UPDATE refunds SET status="FAILED" WHERE id=?',[refundId]);return res.status(502).json({ok:false,error:data?.message||'Adyen rejected the refund request.'});}
    await pool.query('UPDATE refunds SET provider_ref=? WHERE id=?',[data.pspReference||data.reference||null,refundId]);
    await pool.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description,metadata) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),order.id,req.session.user.id,'REFUND_REQUESTED',`Refund request submitted: ${input.amountCents} cents`,JSON.stringify({refundId,pspReference:data.pspReference})]);
    res.status(202).json({ok:true,refundId,status:'PENDING',message:'Refund submitted to Adyen. Final status is confirmed by the Adyen REFUND webhook.'});
  }catch(e){next(e);}
});

router.get('/customers', async (req, res, next) => {
  try {
    const [customers] = await pool.query(
      `SELECT u.id, u.email, u.first_name AS firstName, u.last_name AS lastName, u.phone, u.is_active AS isActive, u.created_at AS createdAt,
              (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orderCount
       FROM users u WHERE u.role = 'CUSTOMER' ORDER BY u.created_at DESC`
    );
    res.json({ ok: true, customers });
  } catch (error) { next(error); }
});

router.get('/delivery-zones', async (req, res, next) => {
  try {
    const [zones] = await pool.query('SELECT id, name, city, price_cents AS priceCents, is_active AS isActive FROM delivery_zones ORDER BY city ASC');
    res.json({ ok: true, zones });
  } catch (error) { next(error); }
});

router.put('/delivery-zones/:city', async (req, res, next) => {
  try {
    const input = z.object({ name: z.string().min(1), priceCents: z.number().int().nonnegative(), isActive: z.boolean().optional() }).parse(req.body);
    const [existing] = await pool.query('SELECT id FROM delivery_zones WHERE city = ? LIMIT 1', [req.params.city]);
    if (existing.length) {
      await pool.query('UPDATE delivery_zones SET name = ?, price_cents = ?, is_active = ? WHERE city = ?', [input.name, input.priceCents, input.isActive === false ? 0 : 1, req.params.city]);
    } else {
      await pool.query('INSERT INTO delivery_zones (id, name, city, price_cents, is_active) VALUES (?, ?, ?, ?, ?)', [crypto.randomUUID(), input.name, req.params.city, input.priceCents, input.isActive === false ? 0 : 1]);
    }
    const [rows] = await pool.query('SELECT id, name, city, price_cents AS priceCents, is_active AS isActive FROM delivery_zones WHERE city = ? LIMIT 1', [req.params.city]);
    const zone = rows[0];
    await pool.query(
      'INSERT INTO activity_log (id, user_id, action, entity, entity_id, metadata, ip_address) VALUES (?, ?, "UPDATE", "DeliveryZone", ?, ?, ?)',
      [crypto.randomUUID(), req.session.user.id, zone.id, JSON.stringify(input), req.ip]
    );
    res.json({ ok: true, zone });
  } catch (error) { next(error); }
});

router.get('/activity', async (req, res, next) => {
  try {
    const [activity] = await pool.query(
      `SELECT a.id, a.action, a.entity, a.entity_id AS entityId, a.created_at AS createdAt, u.email AS userEmail
       FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
       ORDER BY a.created_at DESC LIMIT 200`
    );
    res.json({ ok: true, activity });
  } catch (error) { next(error); }
});

router.get('/settings', async (req, res, next) => {
  try {
    const [settings] = await pool.query('SELECT `key`, value, updated_at AS updatedAt FROM settings ORDER BY `key` ASC');
    const safeSettings = ['ADMIN','OWNER'].includes(req.session.user.role) ? settings : settings.filter(s => !/(secret|token|password|api[_-]?key)/i.test(s.key));
    res.json({ ok: true, settings: safeSettings });
  } catch (error) { next(error); }
});

router.put('/settings/:key', async (req, res, next) => {
  try {
    if (!['ADMIN','OWNER'].includes(req.session.user.role)) return res.status(403).json({ok:false,error:'Only an owner or super admin can change store settings.'});
    const value = z.unknown().parse(req.body.value);
    const [existing] = await pool.query('SELECT `key` FROM settings WHERE `key` = ? LIMIT 1', [req.params.key]);
    if (existing.length) {
      await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [JSON.stringify(value), req.params.key]);
    } else {
      await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [req.params.key, JSON.stringify(value)]);
    }
    await pool.query(
      'INSERT INTO activity_log (id, user_id, action, entity, entity_id, metadata, ip_address) VALUES (?, ?, "UPDATE", "Setting", ?, ?, ?)',
      [crypto.randomUUID(), req.session.user.id, req.params.key, JSON.stringify({ value }), req.ip]
    );
    res.json({ ok: true, setting: { key: req.params.key, value } });
  } catch (error) { next(error); }
});


// --- ERP modules: every endpoint below is protected by the router-level admin guard. ---
function pageParams(query) {
  const page = Math.max(1, Math.min(10000, Number.parseInt(query.page || '1', 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit || '25', 10) || 25));
  return { page, limit, offset: (page - 1) * limit };
}

router.post('/products', async (req, res, next) => {
  try {
    if(!requireStaffRole(req,res,['STORE_ADMIN']))return;
    const input = z.object({
      name: z.string().min(2).max(150), slug: z.string().optional(), description: z.string().default(''),
      priceCents: z.number().int().nonnegative(), comparePriceCents: z.number().int().nonnegative().nullable().optional(),
      costPriceCents: z.number().int().nonnegative().nullable().optional(), stock: z.number().int().nonnegative().default(0),
      sku: z.string().max(80).optional(), categoryId: z.string().uuid().nullable().optional(),
      imageUrl: z.string().url().max(1000).refine(v=>/^https:\/\//i.test(v)).optional(), isActive: z.boolean().default(false), metadata: z.record(z.string(), z.unknown()).optional()
    }).parse(req.body);
    const id = crypto.randomUUID(); const slug = makeSlug(input.slug || input.name).slice(0,80);
    await pool.query(`INSERT INTO products (id,slug,name,description,price_cents,compare_price_cents,cost_price_cents,stock,sku,category_id,image_url,is_active,metadata,published_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,IF(?,NOW(),NULL))`, [id,slug,input.name,input.description,input.priceCents,input.comparePriceCents ?? null,input.costPriceCents ?? null,input.stock,input.sku || null,input.categoryId || null,input.imageUrl || null,input.isActive ? 1 : 0,JSON.stringify(input.metadata || {}),input.isActive ? 1 : 0]);
    if (input.stock > 0) await pool.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason) VALUES (?,?,?, ?,?,?,?,?)',[crypto.randomUUID(),id,req.session.user.id,'RECEIVED',0,input.stock,input.stock,'Initial product stock']);
    await pool.query('INSERT INTO activity_log (id,user_id,action,entity,entity_id,metadata,ip_address) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),req.session.user.id,'CREATE','Product',id,JSON.stringify({name:input.name,slug}),req.ip]);
    res.status(201).json({ok:true,id,slug});
  } catch(error) { next(error); }
});

router.get('/products/page', async (req,res,next) => {
  try {
    const {page,limit,offset}=pageParams(req.query); const search=`%${String(req.query.search||'').slice(0,100)}%`;
    const active=req.query.status==='active'?1:req.query.status==='draft'?0:null;
    const [rows]=await pool.query(`SELECT p.id,p.slug,p.name,p.description,p.price_cents AS priceCents,p.compare_price_cents AS comparePriceCents,p.cost_price_cents AS costPriceCents,p.stock,p.sku,p.image_url AS imageUrl,p.is_active AS isActive,p.low_stock_threshold AS lowStockThreshold,p.created_at AS createdAt,c.name AS category
      FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE (p.name LIKE ? OR p.sku LIKE ?) AND (? IS NULL OR p.is_active=?) ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,[search,search,active,active,limit,offset]);
    if(!['ADMIN','OWNER'].includes(req.session.user.role))rows.forEach(p=>{p.costPriceCents=null;});
    const [[count]]=await pool.query(`SELECT COUNT(*) AS total FROM products WHERE (name LIKE ? OR sku LIKE ?) AND (? IS NULL OR is_active=?)`,[search,search,active,active]);
    res.json({ok:true,products:rows,pagination:{page,limit,total:Number(count.total),pages:Math.ceil(Number(count.total)/limit)}});
  } catch(error){next(error);}
});

router.get('/orders/:id', async (req,res,next)=>{
  try {
    const [[order]]=await pool.query(`SELECT o.*,o.subtotal_cents AS subtotalCents,o.shipping_cents AS shippingCents,o.total_cents AS totalCents,o.discount_cents AS discountCents,o.tax_cents AS taxCents,o.order_number AS orderNumber,o.first_name AS firstName,o.last_name AS lastName,o.payment_status AS paymentStatus,o.fulfilment_status AS fulfilmentStatus,o.tracking_number AS trackingNumber,o.internal_note AS internalNote FROM orders o WHERE o.id=?`,[req.params.id]);
    if(!order)return res.status(404).json({ok:false,error:'Order not found.'});
    const [items]=await pool.query('SELECT product_id AS productId,name_snapshot AS name,price_cents AS priceCents,quantity FROM order_items WHERE order_id=?',[order.id]);
    const [events]=await pool.query('SELECT e.*,u.email AS actorEmail FROM order_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.order_id=? ORDER BY e.created_at DESC',[order.id]);
    const [payments]=await pool.query('SELECT id,provider,provider_payment_id AS reference,status,amount_cents AS amountCents,currency,created_at AS createdAt FROM payments WHERE order_id=? ORDER BY created_at DESC',[order.id]);
    const [refunds]=await pool.query('SELECT id,amount_cents AS amountCents,status,reason,created_at AS createdAt FROM refunds WHERE order_id=? ORDER BY created_at DESC',[order.id]);
    res.json({ok:true,order,items,events,payments,refunds});
  }catch(error){next(error);}
});

router.patch('/orders/:id/fulfilment', async(req,res,next)=>{
  try{
    if(!requireStaffRole(req,res,['ORDER_MANAGER']))return;
    const input=z.object({status:z.enum(['UNFULFILLED','PROCESSING','PACKED','SHIPPED','DELIVERED','CANCELLED']),carrier:z.string().max(100).optional(),trackingNumber:z.string().max(190).optional(),internalNote:z.string().max(5000).optional()}).parse(req.body);
    const conn=await pool.getConnection();
    try{await conn.beginTransaction();const [[o]]=await conn.query('SELECT id,fulfilment_status FROM orders WHERE id=? FOR UPDATE',[req.params.id]);if(!o){await conn.rollback();return res.status(404).json({ok:false,error:'Order not found.'});}
      if(['SHIPPED','DELIVERED'].includes(input.status)){const [[p]]=await conn.query('SELECT payment_status FROM orders WHERE id=?',[o.id]);if(p.payment_status!=='PAID'){await conn.rollback();return res.status(409).json({ok:false,error:'Only paid orders can be shipped or delivered.'});}}
      await conn.query('UPDATE orders SET fulfilment_status=?,carrier=COALESCE(?,carrier),tracking_number=COALESCE(?,tracking_number),internal_note=COALESCE(?,internal_note),status=CASE WHEN ?="SHIPPED" THEN "SHIPPED" WHEN ?="DELIVERED" THEN "DELIVERED" WHEN ?="CANCELLED" THEN "CANCELLED" WHEN status="PAID" AND ? IN ("PROCESSING","PACKED") THEN "PROCESSING" ELSE status END WHERE id=?',[input.status,input.carrier||null,input.trackingNumber||null,input.internalNote??null,input.status,input.status,input.status,input.status,o.id]);
      const description=`Fulfilment updated: ${o.fulfilment_status} → ${input.status}`;
      await conn.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description,metadata) VALUES (?,?,?,?,?,?)',[crypto.randomUUID(),o.id,req.session.user.id,'FULFILMENT',description,JSON.stringify(input)]);
      await conn.commit();
    }catch(e){await conn.rollback();throw e;}finally{conn.release();}
    await pool.query('INSERT INTO activity_log (id,user_id,action,entity,entity_id,metadata,ip_address) VALUES (?,?,?,?,?,?,?)',[crypto.randomUUID(),req.session.user.id,'UPDATE','Order',req.params.id,JSON.stringify(input),req.ip]);
    res.json({ok:true});
  }catch(error){next(error);}
});

router.post('/orders/:id/notes',async(req,res,next)=>{try{const note=z.string().min(1).max(5000).parse(req.body.note);const [r]=await pool.query('UPDATE orders SET internal_note=CONCAT(COALESCE(internal_note,""),?) WHERE id=?',[`${new Date().toISOString()} — ${note}\n`,req.params.id]);if(!r.affectedRows)return res.status(404).json({ok:false,error:'Order not found.'});await pool.query('INSERT INTO order_events (id,order_id,actor_id,event_type,description) VALUES (?,?,?,?,?)',[crypto.randomUUID(),req.params.id,req.session.user.id,'NOTE_ADDED','Internal note added']);res.json({ok:true});}catch(e){next(e);}});

router.get('/inventory',async(req,res,next)=>{try{if(!requireStaffRole(req,res,['INVENTORY_MANAGER']))return;const [products]=await pool.query('SELECT id,name,sku,stock,low_stock_threshold AS lowStockThreshold,cost_price_cents AS costPriceCents FROM products ORDER BY stock ASC,name ASC');const [transactions]=await pool.query('SELECT t.*,p.name AS productName,u.email AS actorEmail FROM inventory_transactions t JOIN products p ON p.id=t.product_id LEFT JOIN users u ON u.id=t.actor_id ORDER BY t.created_at DESC LIMIT 100');if(!['ADMIN','OWNER'].includes(req.session.user.role))products.forEach(p=>{p.costPriceCents=null;});res.json({ok:true,products,transactions});}catch(e){next(e);}});
router.post('/inventory/adjust',async(req,res,next)=>{if(!requireStaffRole(req,res,['INVENTORY_MANAGER']))return;const inputSchema=z.object({productId:z.string().min(1),quantity:z.number().int().min(1).max(100000),type:z.enum(['RECEIVED','REMOVED','ADJUSTMENT','DAMAGED','EXPIRED']),reason:z.string().min(3).max(255),reference:z.string().max(120).optional(),notes:z.string().max(2000).optional()});const conn=await pool.getConnection();try{const input=inputSchema.parse(req.body);await conn.beginTransaction();const [[p]]=await conn.query('SELECT id,stock FROM products WHERE id=? FOR UPDATE',[input.productId]);if(!p){await conn.rollback();return res.status(404).json({ok:false,error:'Product not found.'});}const delta=input.type==='RECEIVED'?input.quantity:-input.quantity;const next=input.type==='ADJUSTMENT'?input.quantity:Number(p.stock)+delta;if(next<0){await conn.rollback();return res.status(409).json({ok:false,error:'Stock cannot become negative.'});}await conn.query('UPDATE products SET stock=? WHERE id=?',[next,p.id]);await conn.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason,reference,notes) VALUES (?,?,?,?,?,?,?,?,?,?)',[crypto.randomUUID(),p.id,req.session.user.id,input.type,p.stock,next,next-Number(p.stock),input.reason,input.reference||null,input.notes||null]);await conn.commit();res.json({ok:true,previousQuantity:Number(p.stock),newQuantity:next});}catch(e){await conn.rollback().catch(()=>{});next(e);}finally{conn.release();}});

router.get('/categories',async(req,res,next)=>{try{const [categories]=await pool.query('SELECT c.*,COUNT(p.id) AS productCount FROM categories c LEFT JOIN products p ON p.category_id=c.id GROUP BY c.id ORDER BY c.sort_order,c.name');res.json({ok:true,categories});}catch(e){next(e);}});
router.post('/categories',async(req,res,next)=>{try{const input=z.object({name:z.string().min(2).max(120),description:z.string().optional(),imageUrl:z.string().url().optional()}).parse(req.body);const id=crypto.randomUUID(),slug=makeSlug(input.name);await pool.query('INSERT INTO categories (id,name,slug,description,image_url) VALUES (?,?,?,?,?)',[id,input.name,slug,input.description||null,input.imageUrl||null]);res.status(201).json({ok:true,id,slug});}catch(e){next(e);}});
router.patch('/categories/:id',async(req,res,next)=>{try{const input=z.object({name:z.string().min(2).max(120).optional(),description:z.string().optional(),imageUrl:z.string().url().nullable().optional(),isActive:z.boolean().optional(),sortOrder:z.number().int().optional()}).parse(req.body);const map={name:'name',description:'description',imageUrl:'image_url',isActive:'is_active',sortOrder:'sort_order'};const fields=[],vals=[];for(const[k,v]of Object.entries(input)){fields.push(`${map[k]}=?`);vals.push(typeof v==='boolean'?(v?1:0):v);}if(!fields.length)return res.status(400).json({ok:false,error:'No fields to update.'});const [r]=await pool.query(`UPDATE categories SET ${fields.join(',')} WHERE id=?`,[...vals,req.params.id]);res.json({ok:true,updated:r.affectedRows});}catch(e){next(e);}});

router.get('/collections',async(req,res,next)=>{try{const [rows]=await pool.query('SELECT c.*,COUNT(cp.product_id) AS productCount FROM collections c LEFT JOIN collection_products cp ON cp.collection_id=c.id GROUP BY c.id ORDER BY c.created_at DESC');res.json({ok:true,collections:rows});}catch(e){next(e);}});
router.post('/collections',async(req,res,next)=>{try{const input=z.object({name:z.string().min(2),description:z.string().optional(),isFeatured:z.boolean().optional()}).parse(req.body);const id=crypto.randomUUID();await pool.query('INSERT INTO collections (id,name,slug,description,is_featured) VALUES (?,?,?,?,?)',[id,input.name,makeSlug(input.name),input.description||null,input.isFeatured?1:0]);res.status(201).json({ok:true,id});}catch(e){next(e);}});
router.put('/collections/:id/products',async(req,res,next)=>{const ids=z.array(z.string()).max(200).parse(req.body.productIds||[]);const conn=await pool.getConnection();try{await conn.beginTransaction();await conn.query('DELETE FROM collection_products WHERE collection_id=?',[req.params.id]);for(let i=0;i<ids.length;i++)await conn.query('INSERT INTO collection_products (collection_id,product_id,sort_order) VALUES (?,?,?)',[req.params.id,ids[i],i]);await conn.commit();res.json({ok:true});}catch(e){await conn.rollback();next(e);}finally{conn.release();}});

router.get('/discounts',async(req,res,next)=>{try{const [discounts]=await pool.query('SELECT d.*,COUNT(u.id) AS usedCount FROM discounts d LEFT JOIN discount_uses u ON u.discount_id=d.id GROUP BY d.id ORDER BY d.created_at DESC');res.json({ok:true,discounts});}catch(e){next(e);}});
router.post('/discounts',async(req,res,next)=>{try{const input=z.object({code:z.string().min(3).max(60).transform(v=>v.toUpperCase()),type:z.enum(['PERCENT','FIXED','FREE_SHIPPING']),value:z.number().int().nonnegative(),minimumOrderCents:z.number().int().nonnegative().default(0),usageLimit:z.number().int().positive().nullable().optional(),perCustomerLimit:z.number().int().positive().nullable().optional(),startsAt:z.string().datetime().nullable().optional(),expiresAt:z.string().datetime().nullable().optional()}).parse(req.body);if(input.type==='PERCENT'&&input.value>100)return res.status(400).json({ok:false,error:'Percentage cannot exceed 100.'});const id=crypto.randomUUID();await pool.query('INSERT INTO discounts (id,code,type,value,minimum_order_cents,usage_limit,per_customer_limit,starts_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)',[id,input.code,input.type,input.value,input.minimumOrderCents,input.usageLimit||null,input.perCustomerLimit||null,input.startsAt||null,input.expiresAt||null]);res.status(201).json({ok:true,id});}catch(e){next(e);}});
router.patch('/discounts/:id',async(req,res,next)=>{try{const isActive=z.boolean().parse(req.body.isActive);const [r]=await pool.query('UPDATE discounts SET is_active=? WHERE id=?',[isActive?1:0,req.params.id]);res.json({ok:true,updated:r.affectedRows});}catch(e){next(e);}});

router.get('/reviews',async(req,res,next)=>{try{const [reviews]=await pool.query('SELECT r.*,p.name AS productName,u.email AS customerEmail FROM product_reviews r JOIN products p ON p.id=r.product_id LEFT JOIN users u ON u.id=r.user_id ORDER BY r.created_at DESC LIMIT 250');res.json({ok:true,reviews});}catch(e){next(e);}});
router.patch('/reviews/:id',async(req,res,next)=>{try{const status=z.enum(['APPROVED','REJECTED','HIDDEN']).parse(req.body.status);const [r]=await pool.query('UPDATE product_reviews SET status=?,moderated_by=?,moderated_at=NOW() WHERE id=?',[status,req.session.user.id,req.params.id]);if(!r.affectedRows)return res.status(404).json({ok:false,error:'Review not found.'});res.json({ok:true});}catch(e){next(e);}});
router.get('/marketing/subscribers',async(req,res,next)=>{try{const [newsletter]=await pool.query('SELECT id,email,status,consent_source AS consentSource,consent_at AS consentAt,created_at AS createdAt FROM newsletter_subscribers ORDER BY created_at DESC');const [customers]=await pool.query("SELECT id,email,'SUBSCRIBED' AS status,'customer-account-opt-in' AS consentSource,created_at AS consentAt,created_at AS createdAt FROM users WHERE role='CUSTOMER' AND marketing_opt_in=1 ORDER BY created_at DESC");const map=new Map();for(const s of [...newsletter,...customers]){const k=s.email.toLowerCase();if(!map.has(k)||s.consentSource==='customer-account-opt-in')map.set(k,s);}res.json({ok:true,subscribers:[...map.values()]});}catch(e){next(e);}});
router.get('/marketing/subscribers.csv',async(req,res,next)=>{try{const [rows]=await pool.query("SELECT email,status,consent_source,consent_at FROM newsletter_subscribers WHERE status='SUBSCRIBED' UNION SELECT email,'SUBSCRIBED','customer-account-opt-in',created_at FROM users WHERE role='CUSTOMER' AND marketing_opt_in=1");const csv=[['email','status','consent_source','consent_at'].map(csvCell).join(','),...rows.map(r=>[r.email,r.status,r.consent_source,r.consent_at].map(csvCell).join(','))].join('\r\n');res.attachment('mills-newsletter-subscribers.csv').type('text/csv').send(csv);}catch(e){next(e);}});
router.post('/marketing/campaign',async(req,res,next)=>{try{
  if(!isEmailConfigured())return res.status(503).json({ok:false,error:'Configure Hostinger SMTP before sending campaigns.'});
  const input=z.object({subject:z.string().min(3).max(180),message:z.string().min(10).max(12000)}).parse(req.body);
  const [newsletterRows]=await pool.query("SELECT id,email,'newsletter' AS source FROM newsletter_subscribers WHERE status='SUBSCRIBED'");
  const [customerRows]=await pool.query("SELECT id,email,'customer' AS source FROM users WHERE role='CUSTOMER' AND is_active=1 AND marketing_opt_in=1");
  const recipientMap=new Map(); for(const row of [...newsletterRows,...customerRows])if(!recipientMap.has(row.email.toLowerCase()))recipientMap.set(row.email.toLowerCase(),row);
  const subscribers=[...recipientMap.values()].slice(0,1000);
  let sent=0,failed=0;
  for(const subscriber of subscribers){
    const token=crypto.randomBytes(32).toString('base64url');
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query('UPDATE newsletter_subscribers SET unsubscribe_token_hash=? WHERE email=?',[hash,subscriber.email]);
    await pool.query('UPDATE users SET marketing_unsubscribe_token_hash=? WHERE email=? AND marketing_opt_in=1',[hash,subscriber.email]);
    await pool.query('INSERT INTO marketing_unsubscribe_tokens (id,email,token_hash) VALUES (?,?,?)',[crypto.randomUUID(),subscriber.email,hash]);
    const unsubscribeUrl=`${process.env.APP_URL.replace(/\/$/,'')}/unsubscribe?token=${encodeURIComponent(token)}`;
    const html=input.message.split(/\n{2,}/).map(p=>`<p>${p.split('\n').map(line=>line.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))).join('<br>')}</p>`).join('');
    try{await sendNewsletterCampaign({to:subscriber.email,subject:input.subject,html,unsubscribeUrl});sent++;}
    catch(error){failed++;console.error('[newsletter campaign]',subscriber.email,error.message);}
  }
  await pool.query('INSERT INTO activity_log (id,user_id,action,entity,metadata,ip_address) VALUES (?,?,"SEND","NewsletterCampaign",?,?)',[crypto.randomUUID(),req.session.user.id,JSON.stringify({subject:input.subject,recipients:subscribers.length,sent,failed}),req.ip]);
  res.json({ok:true,total:subscribers.length,sent,failed});
}catch(e){next(e);}});


function isMissingTableError(error) {
  return error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_TABLE_ERROR')
    || (typeof error?.message === 'string' && /doesn.t exist|doesn't exist/i.test(error.message));
}

router.get('/recipes',async(req,res,next)=>{try{const [recipes]=await pool.query('SELECT id,title,slug,summary,body,prep_time AS prepTime,cook_time AS cookTime,servings,rub_pairing AS rubPairing,main_image_url AS mainImageUrl,gallery_images AS galleryImages,ingredients,method,status,created_at AS createdAt FROM recipes ORDER BY created_at DESC');res.json({ok:true,recipes:recipes.map(r=>({...r,galleryImages:typeof r.galleryImages==='string'?JSON.parse(r.galleryImages||'[]'):r.galleryImages,ingredients:typeof r.ingredients==='string'?JSON.parse(r.ingredients||'[]'):r.ingredients,method:typeof r.method==='string'?JSON.parse(r.method||'[]'):r.method}))});}catch(e){if (isMissingTableError(e)) return res.json({ ok: true, recipes: [] }); next(e);}});
router.post('/recipes',async(req,res,next)=>{try{const input=z.object({title:z.string().min(3).max(180),summary:z.string().max(500).optional(),body:z.string().max(12000).optional(),prepTime:z.string().max(80).optional(),cookTime:z.string().max(80).optional(),servings:z.string().max(80).optional(),rubPairing:z.string().max(150).optional(),mainImageUrl:z.string().url().max(1000),galleryImages:z.array(z.string().url().max(1000)).max(12).default([]),ingredients:z.array(z.string().max(300)).max(40).default([]),method:z.array(z.string().max(1000)).max(40).default([]),status:z.enum(['DRAFT','PUBLISHED']).default('DRAFT')}).parse(req.body);const id=crypto.randomUUID();let slug=makeSlug(input.title).slice(0,180);const [exists]=await pool.query('SELECT id FROM recipes WHERE slug=?',[slug]);if(exists.length)slug=`${slug}-${id.slice(0,8)}`;await pool.query('INSERT INTO recipes (id,title,slug,summary,body,prep_time,cook_time,servings,rub_pairing,main_image_url,gallery_images,ingredients,method,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,input.title,slug,input.summary||null,input.body||null,input.prepTime||null,input.cookTime||null,input.servings||null,input.rubPairing||null,input.mainImageUrl,JSON.stringify(input.galleryImages),JSON.stringify(input.ingredients),JSON.stringify(input.method),input.status]);res.status(201).json({ok:true,id,slug});}catch(e){next(e);}});
router.patch('/recipes/:id',async(req,res,next)=>{try{const input=z.object({title:z.string().min(3).max(180).optional(),summary:z.string().max(500).optional(),body:z.string().max(12000).optional(),prepTime:z.string().max(80).optional(),cookTime:z.string().max(80).optional(),servings:z.string().max(80).optional(),rubPairing:z.string().max(150).optional(),mainImageUrl:z.string().url().max(1000).optional(),galleryImages:z.array(z.string().url().max(1000)).max(12).optional(),ingredients:z.array(z.string().max(300)).max(40).optional(),method:z.array(z.string().max(1000)).max(40).optional(),status:z.enum(['DRAFT','PUBLISHED']).optional()}).parse(req.body);const map={title:'title',summary:'summary',body:'body',prepTime:'prep_time',cookTime:'cook_time',servings:'servings',rubPairing:'rub_pairing',mainImageUrl:'main_image_url',galleryImages:'gallery_images',ingredients:'ingredients',method:'method',status:'status'};const fields=[],values=[];for(const[k,v]of Object.entries(input)){fields.push(`\`${map[k]}\`=?`);values.push(['galleryImages','ingredients','method'].includes(k)?JSON.stringify(v):v);}if(input.title){let slug=makeSlug(input.title).slice(0,180);const [[duplicate]]=await pool.query('SELECT id FROM recipes WHERE slug=? AND id<>? LIMIT 1',[slug,req.params.id]);if(duplicate)slug=`${slug}-${crypto.randomUUID().slice(0,8)}`;fields.push('slug=?');values.push(slug);}if(!fields.length)return res.status(400).json({ok:false,error:'No changes supplied.'});const [r]=await pool.query(`UPDATE recipes SET ${fields.join(',')} WHERE id=?`,[...values,req.params.id]);if(!r.affectedRows)return res.status(404).json({ok:false,error:'Recipe not found.'});res.json({ok:true});}catch(e){next(e);}});
router.delete('/recipes/:id',async(req,res,next)=>{try{const [r]=await pool.query('DELETE FROM recipes WHERE id=?',[req.params.id]);if(!r.affectedRows)return res.status(404).json({ok:false,error:'Recipe not found.'});res.json({ok:true});}catch(e){next(e);}});

router.get('/customers/:id',async(req,res,next)=>{try{const [[customer]]=await pool.query('SELECT id,email,first_name AS firstName,last_name AS lastName,phone,created_at AS createdAt,is_active AS isActive FROM users WHERE id=? AND role="CUSTOMER"',[req.params.id]);if(!customer)return res.status(404).json({ok:false,error:'Customer not found.'});const [orders]=await pool.query('SELECT id,order_number AS orderNumber,total_cents AS totalCents,status,created_at AS createdAt FROM orders WHERE user_id=? ORDER BY created_at DESC',[customer.id]);const [notes]=await pool.query('SELECT n.note,n.created_at AS createdAt,u.email AS actorEmail FROM customer_notes n LEFT JOIN users u ON u.id=n.actor_id WHERE n.customer_id=? ORDER BY n.created_at DESC',[customer.id]);res.json({ok:true,customer,orders,notes});}catch(e){next(e);}});
router.post('/customers/:id/notes',async(req,res,next)=>{try{const note=z.string().min(1).max(5000).parse(req.body.note);await pool.query('INSERT INTO customer_notes (id,customer_id,actor_id,note) VALUES (?,?,?,?)',[crypto.randomUUID(),req.params.id,req.session.user.id,note]);res.status(201).json({ok:true});}catch(e){next(e);}});
router.get('/reports/products',async(req,res,next)=>{try{const [rows]=await pool.query(`SELECT i.product_id AS productId,i.name_snapshot AS productName,SUM(i.quantity) AS unitsSold,SUM(i.quantity*i.price_cents) AS salesCents FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.payment_status='PAID' GROUP BY i.product_id,i.name_snapshot ORDER BY unitsSold DESC`);res.json({ok:true,report:rows});}catch(e){next(e);}});
router.get('/reports/inventory.csv',async(req,res,next)=>{try{const [rows]=await pool.query('SELECT id,name,sku,stock,cost_price_cents FROM products ORDER BY name');const csv=[['id','name','sku','stock','unit_cost_aud','inventory_value_aud'].map(csvCell).join(','),...rows.map(r=>[r.id,r.name,r.sku,r.stock,r.cost_price_cents==null?'':(r.cost_price_cents/100).toFixed(2),r.cost_price_cents==null?'':(r.stock*r.cost_price_cents/100).toFixed(2)].map(csvCell).join(','))].join('\r\n');res.attachment('mills-inventory-report.csv').type('text/csv').send(csv);}catch(e){next(e);}});
router.get('/uploads/cloudinary-signature',(req,res)=>{const {CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY,CLOUDINARY_API_SECRET}=process.env;if(!CLOUDINARY_CLOUD_NAME||!CLOUDINARY_API_KEY||!CLOUDINARY_API_SECRET)return res.status(503).json({ok:false,error:'Cloudinary is not configured. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.'});const type=req.query.type==='recipes'?'recipes':'products';const timestamp=Math.floor(Date.now()/1000);const folder=`mills-smoke-grill/${type}`;const signature=crypto.createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`).digest('hex');res.json({ok:true,cloudName:CLOUDINARY_CLOUD_NAME,apiKey:CLOUDINARY_API_KEY,timestamp,folder,signature});});


router.get('/bundles',async(req,res,next)=>{try{const [bundles]=await pool.query('SELECT * FROM store_bundles ORDER BY created_at DESC');const [items]=await pool.query('SELECT bi.bundle_id AS bundleId,bi.product_id AS productId,bi.quantity,p.name AS productName FROM bundle_items bi JOIN products p ON p.id=bi.product_id');res.json({ok:true,bundles:bundles.map(b=>({...b,items:items.filter(i=>i.bundleId===b.id)}))});}catch(e){next(e);}});
router.post('/bundles',async(req,res,next)=>{const inputSchema=z.object({name:z.string().min(2).max(150),description:z.string().optional(),priceCents:z.number().int().positive(),productIds:z.array(z.string()).min(1).max(50)});const conn=await pool.getConnection();try{const input=inputSchema.parse(req.body);const id=crypto.randomUUID();await conn.beginTransaction();const [products]=await conn.query(`SELECT id FROM products WHERE is_active=1 AND id IN (${input.productIds.map(()=>'?').join(',')})`,input.productIds);if(products.length!==new Set(input.productIds).size){await conn.rollback();return res.status(400).json({ok:false,error:'One or more bundle products are unavailable.'});}await conn.query('INSERT INTO store_bundles (id,name,slug,description,price_cents,is_active) VALUES (?,?,?,?,?,0)',[id,input.name,makeSlug(input.name),input.description||null,input.priceCents]);for(const productId of new Set(input.productIds))await conn.query('INSERT INTO bundle_items (bundle_id,product_id,quantity) VALUES (?,?,1)',[id,productId]);await conn.commit();res.status(201).json({ok:true,id});}catch(e){await conn.rollback().catch(()=>{});next(e);}finally{conn.release();}});
router.patch('/bundles/:id',async(req,res,next)=>{try{const input=z.object({isActive:z.boolean().optional(),priceCents:z.number().int().positive().optional(),description:z.string().optional()}).parse(req.body);const fields=[],values=[];for(const[k,v]of Object.entries(input)){fields.push(`${{isActive:'is_active',priceCents:'price_cents',description:'description'}[k]}=?`);values.push(typeof v==='boolean'?(v?1:0):v);}if(!fields.length)return res.status(400).json({ok:false,error:'No fields supplied.'});const [r]=await pool.query(`UPDATE store_bundles SET ${fields.join(',')} WHERE id=?`,[...values,req.params.id]);res.json({ok:true,updated:r.affectedRows});}catch(e){next(e);}});

module.exports = router;
