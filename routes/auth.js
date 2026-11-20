const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const pool = require('../lib/db');
const { sendEmail, isEmailConfigured, escapeHtml } = require('../lib/mailer');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const loginAttempts = new Map();
function loginThrottle(req,res,next){const key=req.ip;const now=Date.now();const entry=loginAttempts.get(key)||{count:0,resetAt:now+15*60*1000};if(now>entry.resetAt){entry.count=0;entry.resetAt=now+15*60*1000;}if(entry.count>=10)return res.status(429).json({ok:false,error:'Too many login attempts. Try again in 15 minutes.'});req.loginAttemptKey=key;req.loginAttemptEntry=entry;next();}
function regenerateSession(req){return new Promise((resolve,reject)=>req.session.regenerate(error=>error?reject(error):resolve()));}
const credentials = z.object({
  email: z.string().email().transform(value => value.toLowerCase().trim()),
  password: z.string().min(8)
});

function requireDatabase(req, res, next) {
  if (!process.env.DATABASE_URL) return res.status(503).json({ ok: false, error: 'Account storage is not configured. Add DATABASE_URL to the server environment.' });
  next();
}

router.use(requireDatabase);

router.post('/register', async (req, res, next) => {
  try {
    const input = credentials.extend({
      address: z.string().min(3).optional(),
      phone: z.string().min(7).optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      marketingOptIn: z.boolean().optional().default(false)
    }).parse(req.body);

    if (!isEmailConfigured()) {
      return res.status(503).json({ ok: false, error: 'Email verification is not configured yet. Please contact the store.' });
    }

    const [existingRows] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [input.email]);
    if (existingRows.length) return res.status(409).json({ ok: false, error: 'An account already exists for this email.' });

    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(input.password, 12);
    const firstName = input.firstName || input.email.split('@')[0];
    const lastName = input.lastName || '';

    await pool.query(
      'INSERT INTO users (id, email, password_hash, first_name, last_name, phone, address, role, marketing_opt_in, marketing_opt_in_at) VALUES (?, ?, ?, ?, ?, ?, ?, "CUSTOMER", ?, IF(?,NOW(),NULL))',
      [id, input.email, passwordHash, firstName, lastName, input.phone || null, input.address || null, input.marketingOptIn ? 1 : 0, input.marketingOptIn ? 1 : 0]
    );

    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO email_verifications (id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 24 HOUR))',[crypto.randomUUID(),id,crypto.createHash('sha256').update(token).digest('hex')]);
    const verifyUrl = `${process.env.APP_URL.replace(/\/$/, '')}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await sendEmail({to:input.email,subject:'Verify your Mills Smoke & Grill account',html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#171512"><div style="background:#0d0c0b;color:#f2ecdf;padding:24px"><p style="color:#d9a441;letter-spacing:3px">MILLS SMOKE & GRILL</p><h1>Verify your email</h1></div><div style="padding:24px"><p>Hi ${escapeHtml(firstName)}, confirm your email address to activate your account.</p><p><a href="${verifyUrl}" style="display:inline-block;background:#e8432b;color:white;padding:13px 20px;text-decoration:none;border-radius:6px">Verify email address</a></p><p>This link expires in 24 hours. If you did not create this account, you can ignore this email.</p></div></div>`,text:`Hi ${firstName}, verify your Mills Smoke & Grill account: ${verifyUrl}. This link expires in 24 hours.`});
    } catch (mailError) {
      console.error('[verification email]', mailError.message);
      return res.status(502).json({ok:false,code:'VERIFICATION_EMAIL_FAILED',error:'Your account was created, but the verification email could not be sent. Please request a new verification email or contact the store.'});
    }
    return res.status(201).json({ok:true,verificationRequired:true,message:'Account created. Check your inbox (and spam folder) for the verification link.'});
  } catch (error) { next(error); }
});


router.post('/forgot-password', async (req,res,next)=>{
  try {
    const email=z.string().email().transform(v=>v.toLowerCase().trim()).parse(req.body.email);
    if(!isEmailConfigured())return res.status(503).json({ok:false,error:'Password reset email is not configured yet. Please contact the store.'});
    if(isEmailConfigured()) {
      const [[user]]=await pool.query('SELECT id,email,first_name FROM users WHERE email=? AND role="CUSTOMER" AND is_active=1 LIMIT 1',[email]);
      if(user) {
        const token=crypto.randomBytes(32).toString('base64url');
        await pool.query('UPDATE password_resets SET used_at=NOW() WHERE user_id=? AND used_at IS NULL',[user.id]);
        await pool.query('INSERT INTO password_resets (id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 1 HOUR))',[crypto.randomUUID(),user.id,crypto.createHash('sha256').update(token).digest('hex')]);
        const url=`${process.env.APP_URL.replace(/\/$/,'')}/reset-password?token=${encodeURIComponent(token)}`;
        await sendEmail({to:user.email,subject:'Reset your Mills Smoke & Grill password',html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#171512"><div style="background:#0d0c0b;color:#f2ecdf;padding:24px"><p style="color:#d9a441;letter-spacing:3px">MILLS SMOKE &amp; GRILL</p><h1>Reset your password</h1></div><div style="padding:24px"><p>Hi ${escapeHtml(user.first_name)}, use the button below to choose a new password.</p><p><a href="${url}" style="background:#e8432b;color:#fff;padding:13px 20px;text-decoration:none;border-radius:6px">Create a new password</a></p><p>This link expires in one hour and can only be used once. If you did not request this, ignore this email.</p></div></div>`,text:`Reset your password using this one-time link (expires in 1 hour): ${url}`});
      }
    }
    res.json({ok:true,message:'If an account exists for that email, a password reset link has been sent.'});
  } catch(e){next(e);}
});

router.post('/reset-password', async(req,res,next)=>{
  try {
    const input=z.object({token:z.string().min(20).max(200),password:z.string().min(8).max(128)}).parse(req.body);
    const hash=crypto.createHash('sha256').update(input.token).digest('hex');
    const [[reset]]=await pool.query('SELECT id,user_id FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW() LIMIT 1',[hash]);
    if(!reset)return res.status(400).json({ok:false,error:'This password reset link is invalid or has expired. Request a new one.'});
    const passwordHash=await bcrypt.hash(input.password,12);
    const conn=await pool.getConnection();
    try { await conn.beginTransaction(); await conn.query('UPDATE users SET password_hash=? WHERE id=?',[passwordHash,reset.user_id]); await conn.query('UPDATE password_resets SET used_at=NOW() WHERE user_id=? AND used_at IS NULL',[reset.user_id]); await conn.query('DELETE FROM email_verifications WHERE user_id=?',[reset.user_id]); await conn.commit(); }
    catch(e){await conn.rollback();throw e;} finally {conn.release();}
    res.json({ok:true,message:'Your password has been updated. You can now sign in.'});
  } catch(e){next(e);}
});

router.post('/login', loginThrottle, async (req, res, next) => {
  try {
    const input = credentials.parse(req.body);
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [input.email]);
    const user = rows[0];
    if (!user || !user.is_active || !(await bcrypt.compare(input.password, user.password_hash))) {
      req.loginAttemptEntry.count += 1; loginAttempts.set(req.loginAttemptKey, req.loginAttemptEntry);
      return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    }
    if (!user.email_verified_at) return res.status(403).json({ok:false,code:'EMAIL_NOT_VERIFIED',error:'Please verify your email address before signing in.'});
    loginAttempts.delete(req.loginAttemptKey);
    await regenerateSession(req);
    req.session.user = { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, role: user.role };
    await pool.query(
      'INSERT INTO activity_log (id, user_id, action, entity, entity_id, ip_address) VALUES (?, ?, "LOGIN", "User", ?, ?)',
      [crypto.randomUUID(), user.id, user.id, req.ip]
    );
    res.json({ ok: true, user: req.session.user });
  } catch (error) { next(error); }
});


router.get('/verify-email',async(req,res,next)=>{try{const token=z.string().min(20).max(200).parse(req.query.token);const hash=crypto.createHash('sha256').update(token).digest('hex');const [[record]]=await pool.query('SELECT id,user_id FROM email_verifications WHERE token_hash=? AND used_at IS NULL AND expires_at>NOW() LIMIT 1',[hash]);if(!record)return res.status(400).send('This verification link is invalid or has expired.');await pool.query('UPDATE users SET email_verified_at=NOW() WHERE id=?',[record.user_id]);await pool.query('UPDATE email_verifications SET used_at=NOW() WHERE id=?',[record.id]);res.redirect('/account?verified=1');}catch(e){next(e);}});
router.post('/resend-verification',async(req,res,next)=>{try{const email=z.string().email().transform(v=>v.toLowerCase().trim()).parse(req.body.email);const [[user]]=await pool.query('SELECT id,email,email_verified_at FROM users WHERE email=? AND role="CUSTOMER"',[email]);if(user&&!user.email_verified_at&&isEmailConfigured()){const token=crypto.randomBytes(32).toString('base64url');await pool.query('INSERT INTO email_verifications (id,user_id,token_hash,expires_at) VALUES (?,?,?,DATE_ADD(NOW(),INTERVAL 24 HOUR))',[crypto.randomUUID(),user.id,crypto.createHash('sha256').update(token).digest('hex')]);const url=`${(process.env.APP_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'')}/api/auth/verify-email?token=${encodeURIComponent(token)}`;await sendEmail({to:user.email,subject:'Verify your Mills Smoke & Grill account',html:`<p><a href="${url}">Verify your email address</a></p>`,text:url});}res.json({ok:true,message:'If the account needs verification, a new link has been sent.'});}catch(e){next(e);}});

router.post('/logout', (req, res, next) => req.session.destroy(error => error ? next(error) : res.json({ ok: true })));
router.get('/me', requireAuth, (req, res) => res.json({ ok: true, user: req.session.user }));

module.exports = router;
