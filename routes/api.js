const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const pool = require('../lib/db');
const { sendEmail, sendContactNotification, escapeHtml, isEmailConfigured } = require('../lib/mailer');
const router = express.Router();

router.get('/catalog', async (req,res,next)=>{try{const [rows]=await pool.query(`SELECT p.id,p.name,p.description,p.price_cents AS priceCents,p.compare_price_cents AS comparePriceCents,p.stock,p.image_url AS imageUrl,p.metadata,c.slug AS categorySlug,c.name AS categoryName FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE p.is_active=1 ORDER BY p.created_at DESC`);const products=rows.map(p=>{let metadata=p.metadata||{};if(typeof metadata==='string'){try{metadata=JSON.parse(metadata)}catch{metadata={}}}return{id:p.id,name:p.name,short:metadata.short||p.name,price:Number(p.priceCents)/100,oldPrice:p.comparePriceCents?Number(p.comparePriceCents)/100:null,size:metadata.netWeight?`${metadata.netWeight} g`:'',category:p.categorySlug||metadata.category||'all-purpose',protein:metadata.protein||metadata.recommendedProteins||[],heat:Number(metadata.heat||metadata.heatIndex||1),profile:metadata.profile||'',color:metadata.color||'#302b25',accent:metadata.accent||'#d9a441',badge:metadata.badge||'',description:p.description,ingredients:metadata.ingredients||'',use:metadata.use||metadata.usageInstructions||'',imageUrl:p.imageUrl,stock:Number(p.stock)}});const [bundles]=await pool.query(`SELECT b.id,b.name,b.description,b.price_cents AS priceCents,bi.product_id AS productId FROM store_bundles b LEFT JOIN bundle_items bi ON bi.bundle_id=b.id WHERE b.is_active=1 ORDER BY b.created_at DESC`);const grouped=new Map();for(const b of bundles){if(!grouped.has(b.id))grouped.set(b.id,{id:b.id,name:b.name,description:b.description||'',price:Number(b.priceCents)/100,products:[],tag:'Store bundle',save:''});if(b.productId)grouped.get(b.id).products.push(b.productId);}res.json({ok:true,products,bundles:[...grouped.values()]});}catch(e){next(e);}});

router.post('/contact', async (req, res, next) => {
  try {
    const input=z.object({name:z.string().min(2).max(120),email:z.string().email().max(190),subject:z.string().max(160).optional(),order:z.string().max(100).optional(),message:z.string().min(5).max(5000)}).parse(req.body||{});
    if(!isEmailConfigured())return res.status(503).json({ok:false,error:'The contact email service is not configured yet.'});
    await sendContactNotification(input);
    res.json({ok:true,message:'Thanks — your enquiry has been sent to the Mills Smoke & Grill team.'});
  } catch(e){next(e);}
});

router.post('/newsletter/subscribe',async(req,res,next)=>{
  try {
    const email=z.string().email().max(190).transform(v=>v.toLowerCase().trim()).parse(req.body.email);
    if(!isEmailConfigured())return res.status(503).json({ok:false,error:'Email subscriptions are temporarily unavailable. Please try again later.'});
    const token=crypto.randomBytes(32).toString('base64url');
    const hash=crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(`INSERT INTO newsletter_subscribers (id,email,status,consent_source,consent_at,unsubscribe_token_hash) VALUES (?,?, 'SUBSCRIBED','homepage-smoke-signal',NOW(),?) ON DUPLICATE KEY UPDATE status='SUBSCRIBED',consent_source='homepage-smoke-signal',consent_at=NOW(),unsubscribed_at=NULL,unsubscribe_token_hash=VALUES(unsubscribe_token_hash)`,[crypto.randomUUID(),email,hash]);
    await pool.query('UPDATE users SET marketing_unsubscribe_token_hash=? WHERE email=? AND marketing_opt_in=1',[hash,email]);
    await pool.query('INSERT INTO marketing_unsubscribe_tokens (id,email,token_hash) VALUES (?,?,?)',[crypto.randomUUID(),email,hash]);
    const baseUrl=(process.env.APP_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');
    const unsubscribeUrl=`${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`;
    if(isEmailConfigured()) await sendEmail({to:email,subject:'Welcome to the Smoke Signal',html:`<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#171512"><div style="background:#0d0c0b;color:#f2ecdf;padding:24px"><p style="color:#d9a441;letter-spacing:3px">MILLS SMOKE &amp; GRILL</p><h1>You're on the list.</h1></div><div style="padding:24px"><p>Thanks for joining the Smoke Signal. Look out for recipes, product releases and grilling tips.</p><p><a href="${unsubscribeUrl}">Unsubscribe</a></p></div></div>`,text:`Thanks for joining the Smoke Signal. Look out for recipes, product releases and grilling tips. Unsubscribe: ${unsubscribeUrl}`});
    res.status(201).json({ok:true,message:'You’re on the Smoke Signal list. Check your inbox for a welcome email.'});
  }catch(e){next(e);}
});

router.post('/newsletter/unsubscribe',async(req,res,next)=>{
  try{const token=z.string().min(20).max(200).parse(req.body.token);const hash=crypto.createHash('sha256').update(token).digest('hex');const [[record]]=await pool.query('SELECT email FROM marketing_unsubscribe_tokens WHERE token_hash=? AND used_at IS NULL LIMIT 1',[hash]);if(!record)return res.json({ok:true,message:'This unsubscribe link is invalid or has already been used.'});const conn=await pool.getConnection();try{await conn.beginTransaction();await conn.query("UPDATE newsletter_subscribers SET status='UNSUBSCRIBED',unsubscribed_at=NOW() WHERE email=?",[record.email]);await conn.query('UPDATE users SET marketing_opt_in=0,marketing_opt_in_at=NULL,marketing_unsubscribe_token_hash=NULL WHERE email=?',[record.email]);await conn.query('UPDATE marketing_unsubscribe_tokens SET used_at=NOW() WHERE email=? AND used_at IS NULL',[record.email]);await conn.commit();}catch(e){await conn.rollback();throw e;}finally{conn.release();}res.json({ok:true,message:'You have been unsubscribed from Smoke Signal emails.'});}catch(e){next(e);}
});

module.exports = router;
