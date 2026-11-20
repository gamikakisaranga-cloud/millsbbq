const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
dotenv.config();

const helmet = require('helmet');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const mysql = require('mysql2');

const pageRoutes = require('./routes/pages');
const apiRoutes = require('./routes/api');
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const accountRoutes = require('./routes/account');

const app = express();
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Production requires a SESSION_SECRET of at least 32 characters.');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.DATABASE_URL && process.env.SESSION_SECRET) {
  const pool = mysql.createPool(process.env.DATABASE_URL);
  const sessionStore = new MySQLStore({ schema: { tableName: 'user_sessions', columnNames: { session_id: 'session_id', expires: 'expires', data: 'data' } } }, pool);
  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 24 * 7 }
  }));
} else {
  app.use(session({ secret: process.env.SESSION_SECRET || 'development-only-session-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
}
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

app.use('/', pageRoutes);
app.use('/api', apiRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/account', accountRoutes);

app.use((error, req, res, next) => {
  console.error('[server error]', error);
  if (error.name === 'ZodError') return res.status(400).json({ ok: false, error: 'Invalid request data.', details: error.issues });
  if (error.status === 400) return res.status(400).json({ ok: false, error: error.message });
  res.status(500).json({ ok: false, error: 'Something went wrong.' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).send('<h1>404 — Page not found</h1><p><a href="/">Back to home</a></p>');
});

app.listen(PORT, () => {
  console.log(`Mills Smoke & Grill running at http://localhost:${PORT}`);
});
