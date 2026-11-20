const express = require('express');
const crypto = require('crypto');
const pool = require('../lib/db');
const { sendOrderConfirmation } = require('../lib/mailer');

const router = express.Router();


async function releaseOrderReservation(orderId, reason) {
  if (!orderId) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[order]] = await connection.query('SELECT id,order_number,status,payment_status FROM orders WHERE id=? FOR UPDATE',[orderId]);
    if (!order || order.status !== 'PENDING' || order.payment_status !== 'PENDING') { await connection.rollback(); return; }
    const [items] = await connection.query('SELECT product_id,quantity FROM order_items WHERE order_id=?',[orderId]);
    for (const item of items) {
      const [[product]] = await connection.query('SELECT stock,track_inventory FROM products WHERE id=? FOR UPDATE',[item.product_id]);
      if (!product || !product.track_inventory) continue;
      const before=Number(product.stock),after=before+Number(item.quantity);
      await connection.query('UPDATE products SET stock=? WHERE id=?',[after,item.product_id]);
      await connection.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason,reference) VALUES (?,?,NULL,?,?,?,?,?,?)',[crypto.randomUUID(),item.product_id,'ORDER_RESTOCK',before,after,item.quantity,reason,order.order_number]);
    }
    await connection.query('UPDATE orders SET status="CANCELLED",payment_status="FAILED",fulfilment_status="CANCELLED" WHERE id=?',[orderId]);
    await connection.query('INSERT INTO order_events (id,order_id,event_type,description) VALUES (?,?,?,?)',[crypto.randomUUID(),orderId,'RESERVATION_RELEASED',reason]);
    await connection.commit();
  } catch(error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

function adyenApiUrl() {
  return (process.env.ADYEN_API_URL || 'https://checkout-test.adyen.com/v71').replace(/\/+$/, '');
}

function adyenConfigured() {
  return Boolean(process.env.ADYEN_API_KEY && process.env.ADYEN_CLIENT_KEY && process.env.ADYEN_MERCHANT_ACCOUNT);
}
function canAccessOrder(req, order) { const role=req.session?.user?.role; return Boolean(order && ((req.session?.user?.id && order.user_id===req.session.user.id) || req.session?.checkoutOrders?.includes(order.id) || ['ADMIN','OWNER','STORE_ADMIN','ORDER_MANAGER','INVENTORY_MANAGER','CUSTOMER_SUPPORT'].includes(role))); }

router.get('/adyen/config', (req, res) => {
  if (!adyenConfigured()) return res.status(503).json({ ok: false, error: 'Adyen is not configured. Add ADYEN_API_KEY, ADYEN_CLIENT_KEY, and ADYEN_MERCHANT_ACCOUNT to .env.' });
  res.json({ ok: true, clientKey: process.env.ADYEN_CLIENT_KEY, environment: process.env.ADYEN_ENVIRONMENT === 'live' ? 'live' : 'test' });
});

router.post('/adyen/sessions', async (req, res, next) => {
  try {
    const [orderRows] = await pool.query('SELECT * FROM orders WHERE id = ? LIMIT 1', [req.body.orderId]);
    const order = orderRows[0];
    if (!canAccessOrder(req,order)) return res.status(404).json({ok:false,error:'Order not found.'});
    if (!order || order.status !== 'PENDING') return res.status(404).json({ ok: false, error: 'Pending order not found.' });
    if (!adyenConfigured()) { await releaseOrderReservation(order.id, 'Stock reservation released because Adyen is not configured.'); return res.status(503).json({ ok: false, error: 'Adyen is not configured. Add ADYEN_API_KEY, ADYEN_CLIENT_KEY, and ADYEN_MERCHANT_ACCOUNT to .env.' }); }

    const paymentId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO payments (id, order_id, provider, provider_payment_id, status, amount_cents) VALUES (?, ?, "ADYEN", ?, "PENDING", ?)',
      [paymentId, order.id, paymentId, order.total_cents]
    );

    let sessionResponse;
    let session;
    try {
      sessionResponse = await fetch(`${adyenApiUrl()}/sessions`, {
        method: 'POST',
        headers: { 'X-API-Key': process.env.ADYEN_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
          amount: { currency: order.currency || 'AUD', value: order.total_cents },
          reference: paymentId,
          returnUrl: `${process.env.APP_URL || `${req.protocol}://${req.get('host')}`}/checkout?orderId=${encodeURIComponent(order.id)}`,
          countryCode: 'AU',
          shopperLocale: 'en-AU',
          shopperEmail: order.email,
          channel: 'Web'
        })
      });
      session = await sessionResponse.json();
    } catch (error) {
      await pool.query('DELETE FROM payments WHERE id = ?', [paymentId]);
      await releaseOrderReservation(order.id, 'Stock reservation released because payment session creation failed.');
      throw error;
    }
    if (!sessionResponse.ok || !session.id || !session.sessionData) {
      await pool.query('DELETE FROM payments WHERE id = ?', [paymentId]);
      await releaseOrderReservation(order.id, 'Stock reservation released because Adyen rejected the payment session.');
      return res.status(502).json({ ok: false, error: 'Adyen could not start the payment session.' });
    }

    await pool.query('UPDATE payments SET provider_payment_id = ?, raw_event = ? WHERE id = ?', [session.id, JSON.stringify(session), paymentId]);
    res.json({ ok: true, session: { id: session.id, sessionData: session.sessionData }, environment: process.env.ADYEN_ENVIRONMENT === 'live' ? 'live' : 'test' });
  } catch (error) { next(error); }
});

router.get('/adyen/sessions/:orderId', async (req, res, next) => {
  try {
    const [rows] = await pool.query(`SELECT o.id,o.user_id,o.status AS orderStatus, o.order_number AS orderNumber,
      p.status AS paymentStatus, p.raw_event AS rawEvent
      FROM orders o LEFT JOIN payments p ON p.id = (
        SELECT latest.id FROM payments latest WHERE latest.order_id = o.id AND latest.provider = 'ADYEN'
        ORDER BY latest.created_at DESC LIMIT 1
      ) WHERE o.id = ? LIMIT 1`, [req.params.orderId]);
    const payment = rows[0];
    if (!payment || !canAccessOrder(req,{id:payment.id,user_id:payment.user_id})) return res.status(404).json({ ok: false, error: 'Order not found.' });
    if (payment.orderStatus === 'PAID') return res.json({ ok: true, status: 'PAID', orderNumber: payment.orderNumber });
    if (payment.paymentStatus !== 'PENDING') return res.json({ ok: true, status: payment.paymentStatus, orderNumber: payment.orderNumber });

    const session = typeof payment.rawEvent === 'string' ? JSON.parse(payment.rawEvent) : payment.rawEvent;
    if (!session?.id || !session.sessionData) return res.status(404).json({ ok: false, error: 'Adyen session not found.' });
    res.json({ ok: true, status: payment.orderStatus, orderNumber: payment.orderNumber, session: { id: session.id, sessionData: session.sessionData } });
  } catch (error) { next(error); }
});

router.get('/adyen/status/:orderId', async (req, res, next) => {
  try {
    const [orderRows] = await pool.query(`SELECT o.id,o.user_id,o.status,
      (SELECT p.status FROM payments p WHERE p.order_id = o.id AND p.provider = 'ADYEN' ORDER BY p.created_at DESC LIMIT 1) AS paymentStatus
      FROM orders o WHERE o.id = ? LIMIT 1`, [req.params.orderId]);
    if (!orderRows[0] || !canAccessOrder(req,{id:orderRows[0].id,user_id:orderRows[0].user_id})) return res.status(404).json({ ok: false, error: 'Order not found.' });
    res.json({ ok: true, status: orderRows[0].status, paymentStatus: orderRows[0].paymentStatus });
  } catch (error) { next(error); }
});

function isValidAdyenNotification(item) {
  if (!process.env.ADYEN_HMAC_KEY || !item.additionalData?.hmacSignature) return false;
  const amount = item.amount || {};
  const signedFields = [item.pspReference, item.originalReference || '', item.merchantAccountCode, item.merchantReference, amount.value, amount.currency, item.eventCode, item.success].join(':');
  const expected = crypto.createHmac('sha256', Buffer.from(process.env.ADYEN_HMAC_KEY, 'hex')).update(signedFields, 'utf8').digest('base64');
  const actualBuffer = Buffer.from(item.additionalData.hmacSignature, 'base64');
  const expectedBuffer = Buffer.from(expected, 'base64');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

router.post('/adyen/webhook', async (req, res, next) => {
  try {
    const items = (req.body.notificationItems || []).map(entry => entry.NotificationRequestItem).filter(Boolean);
    if (!items.length || !items.every(isValidAdyenNotification)) return res.status(401).send('Invalid notification signature.');

    for (const item of items) {
      if (item.eventCode === 'REFUND') {
        const refundId = item.merchantReference;
        const [[refund]] = await pool.query('SELECT id,order_id,amount_cents,currency FROM refunds WHERE id=? LIMIT 1',[refundId]);
        if (!refund || Number(item.amount?.value)!==Number(refund.amount_cents) || item.amount?.currency!==refund.currency || item.merchantAccountCode!==process.env.ADYEN_MERCHANT_ACCOUNT) continue;
        const refundStatus = item.success === 'true' ? 'SUCCEEDED' : 'FAILED';
        const connection = await pool.getConnection();
        try { await connection.beginTransaction();
          const [[locked]] = await connection.query('SELECT status FROM refunds WHERE id=? FOR UPDATE',[refundId]);
          if (locked && locked.status === 'PENDING') {
            await connection.query('UPDATE refunds SET status=?,provider_ref=? WHERE id=?',[refundStatus,item.pspReference||null,refundId]);
            if (refundStatus === 'SUCCEEDED') {
              const [[totals]] = await connection.query("SELECT COALESCE(SUM(amount_cents),0) AS refunded FROM refunds WHERE order_id=? AND status='SUCCEEDED'",[refund.order_id]);
              const [[order]] = await connection.query('SELECT total_cents FROM orders WHERE id=? FOR UPDATE',[refund.order_id]);
              const full = Number(totals.refunded) >= Number(order.total_cents);
              await connection.query('UPDATE orders SET payment_status=?,status=IF(?,"REFUNDED",status) WHERE id=?',[full?'REFUNDED':'PARTIALLY_REFUNDED',full?1:0,refund.order_id]);
            }
            await connection.query('INSERT INTO order_events (id,order_id,event_type,description,metadata) VALUES (?,?,?,?,?)',[crypto.randomUUID(),refund.order_id,'REFUND_'+refundStatus,`Adyen refund ${refundStatus.toLowerCase()}`,JSON.stringify({refundId,pspReference:item.pspReference})]);
          }
          await connection.commit();
        } catch(e) { await connection.rollback(); throw e; } finally { connection.release(); }
        continue;
      }
      if (item.eventCode !== 'AUTHORISATION') continue;
      const connection = await pool.getConnection();
      let confirmedOrderId = null;
      try {
        await connection.beginTransaction();
        const [[payment]] = await connection.query('SELECT id, order_id, status FROM payments WHERE id = ? AND provider = "ADYEN" FOR UPDATE', [item.merchantReference]);
        if (!payment) { await connection.rollback(); continue; }
        // Adyen may retry notifications. Only the first terminal transition mutates order/stock.
        if (payment.status === 'PENDING') {
          const status = item.success === 'true' ? 'PAID' : 'FAILED';
          const [[order]] = await connection.query('SELECT id, order_number, total_cents, currency, payment_status FROM orders WHERE id = ? FOR UPDATE', [payment.order_id]);
          if (status === 'PAID' && (!order || Number(item.amount?.value) !== Number(order.total_cents) || item.amount?.currency !== order.currency || item.merchantAccountCode !== process.env.ADYEN_MERCHANT_ACCOUNT)) { await connection.rollback(); continue; }
          await connection.query('UPDATE payments SET provider_payment_id = ?, status = ?, raw_event = ? WHERE id = ?', [item.pspReference, status, JSON.stringify(item), payment.id]);
          if (order && status === 'PAID') {
            await connection.query('UPDATE orders SET status = "PAID", payment_status = "PAID", payment_provider = "ADYEN" WHERE id = ?', [order.id]);
            await connection.query('INSERT INTO order_events (id,order_id,event_type,description,metadata) VALUES (?,?,?,?,?)', [crypto.randomUUID(), order.id, 'PAYMENT_CONFIRMED', 'Payment confirmed by Adyen', JSON.stringify({pspReference:item.pspReference})]);
            confirmedOrderId = order.id;
          } else if (order && status === 'FAILED') {
            const [items] = await connection.query('SELECT product_id,quantity FROM order_items WHERE order_id=?', [order.id]);
            for (const line of items) {
              const [[product]] = await connection.query('SELECT stock FROM products WHERE id=? FOR UPDATE', [line.product_id]);
              if (!product) continue;
              const before = Number(product.stock); const after = before + Number(line.quantity);
              await connection.query('UPDATE products SET stock=? WHERE id=?', [after,line.product_id]);
              await connection.query('INSERT INTO inventory_transactions (id,product_id,actor_id,type,previous_quantity,new_quantity,quantity_change,reason,reference) VALUES (?,?,NULL,?,?,?,?,?,?)', [crypto.randomUUID(),line.product_id,'ORDER_RESTOCK',before,after,line.quantity,'Restored after failed payment',order.order_number]);
            }
            await connection.query('UPDATE orders SET status="CANCELLED",payment_status="FAILED",fulfilment_status="CANCELLED" WHERE id=?',[order.id]);
            await connection.query('INSERT INTO order_events (id,order_id,event_type,description) VALUES (?,?,?,?)',[crypto.randomUUID(),order.id,'PAYMENT_FAILED','Payment failed; reserved stock restored']);
          }
        }
        await connection.commit();
      } catch (transactionError) { await connection.rollback(); throw transactionError; }
      finally { connection.release(); }
      if (confirmedOrderId) { try { const mail = await sendOrderConfirmation(pool, confirmedOrderId); if (mail.sent) await pool.query('INSERT INTO order_events (id,order_id,event_type,description,metadata) VALUES (?,?,?,?,?)',[crypto.randomUUID(),confirmedOrderId,'EMAIL_SENT','Order confirmation email sent',JSON.stringify({providerId:mail.id})]); } catch(mailError) { console.error('[order confirmation email]',mailError.message); } }
    }
    res.status(200).type('text/plain').send('[accepted]');
  } catch (error) { next(error); }
});

module.exports = router;
