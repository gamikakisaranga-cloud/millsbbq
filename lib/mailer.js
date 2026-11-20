const tls = require('node:tls');
const crypto = require('node:crypto');

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

function isEmailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.MAIL_FROM &&
    process.env.APP_URL
  );
}

function cleanHeader(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function encodeHeader(value) {
  const clean = cleanHeader(value);
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

function wrapBase64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') || '';
}

function parseMailbox(value) {
  const clean = cleanHeader(value);
  const match = clean.match(/<([^<>]+)>/);
  const address = (match ? match[1] : clean).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
    throw new Error('MAIL_FROM or recipient is not a valid email address.');
  }
  return address;
}

function createSmtpSession() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  if (port !== 465) {
    throw new Error('This built-in SMTP sender is configured for Hostinger SSL SMTP on port 465. Set SMTP_PORT=465 and SMTP_SECURE=true.');
  }

  const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
  socket.setTimeout(20000, () => socket.destroy(new Error('SMTP connection timed out.')));

  let buffer = '';
  let lines = [];
  const responses = [];
  const waiters = [];
  let terminalError;

  const deliver = () => {
    while (responses.length && waiters.length) waiters.shift()(responses.shift());
  };

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        responses.push(lines.join('\n'));
        lines = [];
        deliver();
      }
    }
  });
  socket.on('error', error => {
    terminalError = error;
    while (waiters.length) waiters.shift()(null, error);
  });
  socket.on('close', () => {
    if (!terminalError) terminalError = new Error('SMTP connection closed unexpectedly.');
    while (waiters.length) waiters.shift()(null, terminalError);
  });

  const readResponse = () => new Promise((resolve, reject) => {
    if (responses.length) return resolve(responses.shift());
    if (terminalError) return reject(terminalError);
    waiters.push((response, error) => error ? reject(error) : resolve(response));
  });

  const expect = async (allowed, action) => {
    const response = await readResponse();
    const code = Number(response.slice(0, 3));
    if (!allowed.includes(code)) throw new Error(`SMTP ${action} failed: ${response}`);
    return response;
  };

  const command = async (value, allowed, action) => {
    socket.write(`${value}\r\n`);
    return expect(allowed, action);
  };

  return { socket, readResponse, expect, command };
}

async function sendEmail({ to, subject, html, text }) {
  if (!isEmailConfigured()) {
    throw new Error('Email is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM and APP_URL.');
  }

  const fromHeader = cleanHeader(process.env.MAIL_FROM);
  const fromAddress = parseMailbox(fromHeader);
  const toAddress = parseMailbox(to);
  const boundary = `mills-${crypto.randomBytes(12).toString('hex')}`;
  const message = [
    `From: ${fromHeader}`,
    `To: ${toAddress}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${process.env.SMTP_HOST}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(text || ''),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(html || ''),
    `--${boundary}--`,
    ''
  ].join('\r\n').replace(/(^|\r\n)\./g, '$1..');

  const smtp = createSmtpSession();
  try {
    await new Promise((resolve, reject) => {
      smtp.socket.once('secureConnect', resolve);
      smtp.socket.once('error', reject);
    });
    await smtp.expect([220], 'greeting');
    await smtp.command(`EHLO ${process.env.APP_URL.replace(/^https?:\/\//, '').split('/')[0]}`, [250], 'EHLO');
    await smtp.command('AUTH LOGIN', [334], 'AUTH LOGIN');
    await smtp.command(Buffer.from(process.env.SMTP_USER, 'utf8').toString('base64'), [334], 'SMTP username');
    await smtp.command(Buffer.from(process.env.SMTP_PASS, 'utf8').toString('base64'), [235], 'SMTP password');
    await smtp.command(`MAIL FROM:<${fromAddress}>`, [250], 'MAIL FROM');
    await smtp.command(`RCPT TO:<${toAddress}>`, [250, 251], 'RCPT TO');
    await smtp.command('DATA', [354], 'DATA');
    smtp.socket.write(`${message.replace(/\r?\n/g, '\r\n')}\r\n.\r\n`);
    await smtp.expect([250], 'message delivery');
    smtp.socket.write('QUIT\r\n');
    await smtp.expect([221], 'QUIT');
    return { sent: true, messageId: 'smtp-accepted' };
  } finally {
    smtp.socket.end();
  }
}

async function sendOrderConfirmation(pool, orderId) {
  const [[order]] = await pool.query('SELECT order_number,email,first_name,subtotal_cents,shipping_cents,discount_cents,total_cents,currency FROM orders WHERE id=?',[orderId]);
  if (!order) return { sent:false, reason:'Order not found.' };
  const [items] = await pool.query('SELECT name_snapshot,quantity,price_cents FROM order_items WHERE order_id=?',[orderId]);
  const money = n => new Intl.NumberFormat('en-AU',{style:'currency',currency:order.currency||'AUD'}).format(Number(n)/100);
  const rows = items.map(i=>`<tr><td style="padding:10px;border-bottom:1px solid #ddd">${escapeHtml(i.name_snapshot)} × ${Number(i.quantity)}</td><td style="padding:10px;border-bottom:1px solid #ddd;text-align:right">${money(i.price_cents*i.quantity)}</td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#171512"><div style="background:#0d0c0b;color:#f2ecdf;padding:28px"><p style="letter-spacing:4px;color:#d9a441">MILLS SMOKE & GRILL</p><h1>Payment confirmed.</h1><p>Thanks ${escapeHtml(order.first_name)} — your order is in the smokehouse queue.</p></div><div style="padding:24px"><h2>Order ${escapeHtml(order.order_number)}</h2><table style="width:100%;border-collapse:collapse">${rows}</table><p>Subtotal: ${money(order.subtotal_cents)}<br>Shipping: ${money(order.shipping_cents)}<br>Discount: −${money(order.discount_cents)}<br><strong>Total paid: ${money(order.total_cents)}</strong></p><p>We’ll send another update when your order ships.</p><p>Mills Smoke & Grill</p></div></div>`;
  const text = `Payment confirmed for order ${order.order_number}. Total paid: ${money(order.total_cents)}. Thank you, ${order.first_name}.`;
  return sendEmail({to:order.email,subject:`Order ${order.order_number} confirmed — Mills Smoke & Grill`,html,text});
}

async function sendOrderInvoice(pool, orderId) {
  const [[order]] = await pool.query('SELECT order_number,email,first_name,last_name,address,city,state,postcode,country,subtotal_cents,shipping_cents,discount_cents,tax_cents,total_cents,currency,payment_status,status,created_at FROM orders WHERE id=?',[orderId]);
  if (!order) return { sent:false, reason:'Order not found.' };
  const [items] = await pool.query('SELECT name_snapshot,quantity,price_cents FROM order_items WHERE order_id=?',[orderId]);
  const money = n => new Intl.NumberFormat('en-AU',{style:'currency',currency:order.currency||'AUD'}).format(Number(n||0)/100);
  const rows = items.map(i=>`<tr><td style="padding:10px;border-bottom:1px solid #ddd">${escapeHtml(i.name_snapshot)}</td><td style="padding:10px;border-bottom:1px solid #ddd;text-align:center">${Number(i.quantity)}</td><td style="padding:10px;border-bottom:1px solid #ddd;text-align:right">${money(i.price_cents*i.quantity)}</td></tr>`).join('');
  const address = [order.address,order.city,order.state,order.postcode,order.country].filter(Boolean).map(escapeHtml).join(', ');
  const invoiceUrl = `${process.env.APP_URL.replace(/\/$/,'')}/account/orders/${encodeURIComponent(orderId)}/invoice`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#171512"><header style="background:#0d0c0b;color:#f2ecdf;padding:28px"><p style="color:#d9a441;letter-spacing:3px">MILLS SMOKE &amp; GRILL</p><h1>Order invoice</h1><p>Thank you for your order, ${escapeHtml(order.first_name)}.</p></header><main style="padding:24px"><h2>Invoice ${escapeHtml(order.order_number)}</h2><p>Order date: ${new Date(order.created_at).toLocaleDateString('en-AU')}<br>Payment status: ${escapeHtml(order.payment_status||order.status)}</p><p><b>Bill to</b><br>${escapeHtml(order.first_name)} ${escapeHtml(order.last_name)}<br>${escapeHtml(order.email)}<br>${address}</p><table style="width:100%;border-collapse:collapse"><thead><tr><th align="left">Item</th><th>Qty</th><th align="right">Total</th></tr></thead><tbody>${rows}</tbody></table><p style="text-align:right;line-height:1.8">Subtotal: ${money(order.subtotal_cents)}<br>Shipping: ${money(order.shipping_cents)}<br>Discount: −${money(order.discount_cents)}<br>Tax: ${money(order.tax_cents)}<br><b>Total: ${money(order.total_cents)}</b></p><p><a href="${invoiceUrl}">View / print invoice in your account</a></p><p>Questions? Reply to this email or contact inquiries@millsbbq.com.au.</p></main></div>`;
  const text = `Mills Smoke & Grill invoice ${order.order_number}\nOrder date: ${new Date(order.created_at).toLocaleDateString('en-AU')}\n${items.map(i=>`${i.name_snapshot} x ${i.quantity}: ${money(i.price_cents*i.quantity)}`).join('\n')}\nTotal: ${money(order.total_cents)}\nInvoice: ${invoiceUrl}`;
  return sendEmail({to:order.email,subject:`Your Mills Smoke & Grill invoice — ${order.order_number}`,html,text});
}

async function sendContactNotification({name,email,subject,order,message}) {
  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto"><h2>New website enquiry</h2><p><b>Name:</b> ${escapeHtml(name)}<br><b>Email:</b> ${escapeHtml(email)}<br><b>Subject:</b> ${escapeHtml(subject||'General enquiry')}<br><b>Order:</b> ${escapeHtml(order||'Not supplied')}</p><h3>Message</h3><p style="white-space:pre-wrap">${escapeHtml(message)}</p></div>`;
  return sendEmail({to:process.env.CONTACT_TO||'inquiries@millsbbq.com.au',subject:`Website enquiry: ${cleanHeader(subject||'General enquiry')}`,html,text:`New website enquiry\nName: ${name}\nEmail: ${email}\nSubject: ${subject||'General enquiry'}\nOrder: ${order||'Not supplied'}\n\n${message}`});
}

async function sendNewsletterCampaign({to,subject,html,unsubscribeUrl}) {
  const footer = `<hr style="border:0;border-top:1px solid #ddd;margin:28px 0"><p style="font:12px Arial;color:#777">You are receiving this because you subscribed to Mills Smoke &amp; Grill updates. <a href="${unsubscribeUrl}">Unsubscribe</a>.</p>`;
  return sendEmail({to,subject,html:`<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#171512">${html}${footer}</div>`,text:`${String(html).replace(/<[^>]*>/g,' ')}\n\nUnsubscribe: ${unsubscribeUrl}`});
}

module.exports = { sendEmail, sendOrderConfirmation, sendOrderInvoice, sendContactNotification, sendNewsletterCampaign, escapeHtml, isEmailConfigured };
