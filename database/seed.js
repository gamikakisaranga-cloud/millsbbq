// Seeds the admin account, a demo customer account, the product catalog,
// default delivery zones and store settings.
// Usage: npm run db:seed
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../lib/db');

const PRODUCTS = [
  { id: 'original-smoke', name: 'Original Smoke Rub', description: 'A deep, balanced blend built for everyday grilling. Smoky paprika, garlic, pepper and a gentle sweetness create a rich bark without overpowering the meat.', priceCents: 1299, stock: 120, metadata: { category: 'all-purpose', heat: 1, badge: 'Best Seller' } },
  { id: 'brisket-black', name: 'Brisket Black', description: 'A dark, pepper-forward rub designed for brisket, beef ribs and steaks. It builds a dramatic crust and a long, savoury finish.', priceCents: 1499, stock: 90, metadata: { category: 'beef', heat: 2, badge: 'Pitmaster Pick' } },
  { id: 'sweet-heat', name: 'Sweet Heat BBQ', description: 'Brown sugar and warm spices meet a clean chilli finish. Made for ribs, pulled pork, wings and anything that loves caramelised edges.', priceCents: 1349, stock: 100, metadata: { category: 'pork', heat: 3, badge: 'Crowd Favourite' } },
  { id: 'chicken-fire-dust', name: 'Chicken Fire Dust', description: 'A bright, aromatic blend that turns chicken into the centrepiece. Citrus, herbs and medium spice bring colour, crispness and balance.', priceCents: 1199, stock: 110, metadata: { category: 'chicken', heat: 2, badge: '' } },
  { id: 'hot-ember', name: 'Hot Ember Rub', description: 'A high-heat blend that still respects the food. Layered chillies, smoke and tang create an intense but rounded finish.', priceCents: 1399, stock: 75, metadata: { category: 'hot', heat: 5, badge: 'Extra Hot' } },
  { id: 'smoky-garlic', name: 'Smoky Garlic', description: 'A versatile seasoning for the grill, oven and kitchen table. Roasted garlic and gentle smoke make vegetables, potatoes and proteins instantly richer.', priceCents: 1099, stock: 130, metadata: { category: 'all-purpose', heat: 1, badge: 'Kitchen Essential' } },
  { id: 'coastal-char', name: 'Coastal Char', description: 'A clean citrus-pepper rub for prawns, fish, calamari and grilled vegetables. Fresh, aromatic and quick to caramelise.', priceCents: 1249, stock: 85, metadata: { category: 'seafood', heat: 2, badge: 'New' } },
  { id: 'garden-smoke', name: 'Garden Smoke', description: 'Earthy herbs, smoke and a touch of sweetness make mushrooms, corn, potatoes and roasted vegetables impossible to ignore.', priceCents: 1049, stock: 95, metadata: { category: 'vegetables', heat: 1, badge: 'Plant Friendly' } }
];

async function upsertUser({ email, password, firstName, lastName, role, phone, address }) {
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  const passwordHash = await bcrypt.hash(password, 12);
  if (rows.length) {
    await pool.query('UPDATE users SET password_hash = ?, role = ?, is_active = 1, email_verified_at = COALESCE(email_verified_at,NOW()) WHERE email = ?', [passwordHash, role, email]);
    return rows[0].id;
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO users (id, email, password_hash, first_name, last_name, phone, address, role, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
    [id, email, passwordHash, firstName, lastName, phone || null, address || null, role]
  );
  return id;
}

async function upsertProduct(product) {
  const [rows] = await pool.query('SELECT id FROM products WHERE id = ? LIMIT 1', [product.id]);
  if (rows.length) {
    await pool.query(
      'UPDATE products SET name = ?, description = ?, price_cents = ?, metadata = ? WHERE id = ?',
      [product.name, product.description, product.priceCents, JSON.stringify(product.metadata), product.id]
    );
    return;
  }
  await pool.query(
    'INSERT INTO products (id, slug, name, description, price_cents, stock, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [product.id, product.id, product.name, product.description, product.priceCents, product.stock, JSON.stringify(product.metadata)]
  );
}

async function upsertDeliveryZone(zone) {
  const [rows] = await pool.query('SELECT id FROM delivery_zones WHERE city = ? LIMIT 1', [zone.city]);
  if (rows.length) return;
  await pool.query('INSERT INTO delivery_zones (id, name, city, price_cents) VALUES (?, ?, ?, ?)', [crypto.randomUUID(), zone.name, zone.city, zone.priceCents]);
}

async function upsertSetting(key, value) {
  const [rows] = await pool.query('SELECT `key` FROM settings WHERE `key` = ? LIMIT 1', [key]);
  if (rows.length) {
    await pool.query('UPDATE settings SET value = ? WHERE `key` = ?', [JSON.stringify(value), key]);
  } else {
    await pool.query('INSERT INTO settings (`key`, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
  }
}

async function main() {
  if (!process.env.ADMIN_INITIAL_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD.length < 12) throw new Error('Set ADMIN_INITIAL_PASSWORD to a unique password of at least 12 characters before seeding.');
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@millssmokeandgrill.com').toLowerCase();
  await upsertUser({
    email: adminEmail,
    password: process.env.ADMIN_INITIAL_PASSWORD || 'change-this-password',
    firstName: 'Mills',
    lastName: 'Admin',
    role: 'ADMIN'
  });
  console.log(`Admin account ready: ${adminEmail}`);

  if (process.env.DEMO_CUSTOMER_EMAIL && process.env.DEMO_CUSTOMER_PASSWORD) {
    const customerEmail = process.env.DEMO_CUSTOMER_EMAIL.toLowerCase();
    await upsertUser({ email: customerEmail, password: process.env.DEMO_CUSTOMER_PASSWORD, firstName: 'Demo', lastName: 'Customer', role: 'CUSTOMER' });
    console.log(`Demo customer account ready: ${customerEmail}`);
  }

  for (const product of PRODUCTS) await upsertProduct(product);
  console.log(`Seeded ${PRODUCTS.length} products.`);

  await upsertSetting('store', {
    currency: 'AUD',
    timezone: process.env.APP_TIMEZONE || 'Australia/Melbourne',
    freeShippingThresholdCents: Number(process.env.FREE_SHIPPING_THRESHOLD_CENTS || 15000),
    flatDeliveryCents: 1500,
    deliveryCountry: 'Australia'
  });

  await upsertDeliveryZone({ name: 'Melbourne Metro', city: 'Melbourne', priceCents: 995 });
  await upsertDeliveryZone({ name: 'Sydney Metro', city: 'Sydney', priceCents: 1295 });
  await upsertDeliveryZone({ name: 'Brisbane Metro', city: 'Brisbane', priceCents: 1495 });
  await upsertDeliveryZone({ name: 'Perth Metro', city: 'Perth', priceCents: 1995 });
  console.log('Delivery zones and store settings ready.');
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
