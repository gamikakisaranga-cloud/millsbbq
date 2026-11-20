const express = require('express');
const router = express.Router();
const pool = require('../lib/db');

function isMissingTableError(error) {
  return error && (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ER_BAD_TABLE_ERROR')
    || (typeof error?.message === 'string' && /doesn.t exist|doesn't exist/i.test(error.message));
}

router.get('/', async (req, res, next) => {
  try { const [recipes]=await pool.query("SELECT title,slug,summary,prep_time AS prepTime,cook_time AS cookTime,rub_pairing AS rubPairing,main_image_url AS mainImageUrl FROM recipes WHERE status='PUBLISHED' ORDER BY created_at DESC LIMIT 3"); res.render('index',{recipes}); } catch(e){
    if (isMissingTableError(e)) return res.render('index', { recipes: [] });
    next(e);
  }
});

router.get('/shop', (req, res) => {
  res.render('shop');
});

router.get('/story', (req, res) => {
  res.render('story');
});

router.get('/recipes', async (req, res, next) => {
  try { const [recipes] = await pool.query("SELECT title,slug,summary,prep_time AS prepTime,cook_time AS cookTime,servings,rub_pairing AS rubPairing,main_image_url AS mainImageUrl,gallery_images AS galleryImages,ingredients,method,body FROM recipes WHERE status='PUBLISHED' ORDER BY created_at DESC"); res.render('recipes',{recipes}); } catch(e){
    if (isMissingTableError(e)) return res.render('recipes', { recipes: [] });
    next(e);
  }
});
router.get('/recipes/:slug',async(req,res,next)=>{try{const [[recipe]]=await pool.query("SELECT title,slug,summary,prep_time AS prepTime,cook_time AS cookTime,servings,rub_pairing AS rubPairing,main_image_url AS mainImageUrl,gallery_images AS galleryImages,ingredients,method,body FROM recipes WHERE slug=? AND status='PUBLISHED' LIMIT 1",[req.params.slug]);if(!recipe)return res.status(404).send('Recipe not found.');for(const key of ['galleryImages','ingredients','method'])if(typeof recipe[key]==='string'){try{recipe[key]=JSON.parse(recipe[key]);}catch{recipe[key]=[];}}res.render('recipe-detail',{recipe});}catch(e){
  if (isMissingTableError(e)) return res.status(404).send('Recipe not found.');
  next(e);
}});

router.get('/reset-password',(req,res)=>res.render('reset-password'));
router.get('/unsubscribe',(req,res)=>res.render('unsubscribe',{token:String(req.query.token||'')}));

router.get('/contact', (req, res) => {
  res.render('contact');
});

router.get('/checkout', (req, res) => {
  res.render('checkout');
});

function renderAccount(req,res,initialTab='dashboard',orderId=''){return res.render('account',{initialTab,orderId});}
router.get('/account',(req,res)=>renderAccount(req,res));
router.get('/account/orders',(req,res)=>renderAccount(req,res,'orders'));
router.get('/account/orders/:id',(req,res)=>renderAccount(req,res,'orders',req.params.id));
router.get('/account/profile',(req,res)=>renderAccount(req,res,'profile'));
router.get('/account/addresses',(req,res)=>renderAccount(req,res,'addresses'));
router.get('/account/wishlist',(req,res)=>renderAccount(req,res,'wishlist'));
router.get('/account/settings',(req,res)=>renderAccount(req,res,'security'));

function renderAdmin(req,res,initialView='overview',extra={}) {
  if (!req.session?.user) return res.redirect('/account?next=/admin');
  if (!['ADMIN','OWNER','STORE_ADMIN','ORDER_MANAGER','INVENTORY_MANAGER','CUSTOMER_SUPPORT'].includes(req.session.user.role)) return res.redirect('/account');
  return res.render('admin', { user:req.session.user, initialView, ...extra });
}
router.get('/admin', (req,res)=>renderAdmin(req,res));
router.get('/admin/products/new',(req,res)=>renderAdmin(req,res,'products',{openNew:true}));
router.get('/admin/orders/:id',(req,res)=>renderAdmin(req,res,'orders',{orderId:req.params.id}));
router.get('/admin/products/:id/edit',(req,res)=>renderAdmin(req,res,'products',{productId:req.params.id}));
router.get('/admin/customers/:id',(req,res)=>renderAdmin(req,res,'customers',{customerId:req.params.id}));
router.get('/admin/:section',(req,res)=>{const sections={sales:'sales',orders:'orders',products:'products',categories:'categories',collections:'categories',bundles:'categories',inventory:'inventory',customers:'customers',discounts:'discounts',reviews:'reviews',recipes:'recipes',marketing:'marketing',reports:'reports',activity:'activity',settings:'settings'};const view=sections[req.params.section];if(!view)return res.status(404).send('Admin page not found.');return renderAdmin(req,res,view);});

module.exports = router;
