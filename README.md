# Mills Smoke & Grill — Express + MySQL ERP

This repository is the existing Mills Smoke & Grill Express application extended with database-backed store operations. It remains **Express + EJS + MySQL + Adyen**; it has not been converted to Next.js, Prisma, PostgreSQL or Supabase.

## Requirements

- Node.js 18+ (Node 20+ recommended)
- MySQL 8.0+ or a compatible MariaDB version
- An Adyen Checkout account for live/test payments (optional until checkout is enabled)
- Cloudinary account for persistent product-image uploads (optional)
- Hostinger email mailbox for SMTP-based verification and order emails (recommended for this deployment)

## Local setup

1. Create a MySQL database with `utf8mb4` and a dedicated application user.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` and a unique `SESSION_SECRET` (at least 32 characters in production).
3. Set `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` (12+ characters).
4. Install packages and apply the base schema plus ERP migration:

   ```bash
   npm install
   npm run db:setup
   npm run db:seed
   npm test
   npm start
   ```

5. Visit `http://localhost:3000/account`, sign in with the admin email/password you configured, then open `/admin`.

`db:setup` applies `database/schema.sql`, `database/migrations/002_erp.sql` and `database/migrations/003_customer_marketing_recipes.sql`. It tolerates duplicate-column errors so the ERP migration can be re-run after a successful application. Back up production data before applying schema changes.

The seed script requires `ADMIN_INITIAL_PASSWORD`. It does not print or ship default login credentials. A demo customer is created only if both `DEMO_CUSTOMER_EMAIL` and `DEMO_CUSTOMER_PASSWORD` are explicitly configured. Re-running the seed no longer resets stock quantities on existing products.

## Optional integrations

### Adyen Checkout

Configure `ADYEN_ENVIRONMENT`, `ADYEN_API_URL`, `ADYEN_API_KEY`, `ADYEN_CLIENT_KEY`, `ADYEN_MERCHANT_ACCOUNT`, and `ADYEN_HMAC_KEY`. Configure an Adyen Standard webhook pointing to `/api/payments/adyen/webhook` and enable HMAC signing. The application trusts signed provider notifications—not a browser return URL—as payment confirmation. Test with Adyen test credentials before enabling live mode.

### Transactional email (Hostinger SMTP)

Configure the Hostinger mailbox `inquiries@millsbbq.com.au` and set `SMTP_HOST=smtp.hostinger.com`, `SMTP_PORT=465`, `SMTP_SECURE=true`, `SMTP_USER=inquiries@millsbbq.com.au`, `SMTP_PASS` (the mailbox password), `MAIL_FROM=Mills Smoke & Grill <inquiries@millsbbq.com.au>`, and `APP_URL=https://millsbbq.com.au`. Keep the mailbox password only in the hosting environment variables; never commit it to the project. When configured:

- Customer registration sends a 24-hour email-verification link.
- Unverified customers cannot sign in until verification is complete.
- A successful Adyen authorisation sends an order confirmation email.
- Admins can resend an order confirmation from the order detail view.

Email verification is required for customer registration. If SMTP is not configured, customer registration is blocked until email delivery is configured. Unverified users can request a fresh verification link from the account sign-in page. No email is reported as sent unless the SMTP server accepts the message.

### Product image uploads (Cloudinary)

Set `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET`. The server signs uploads; the browser uploads image bytes directly to Cloudinary. The API secret is never sent to the browser. If Cloudinary is not configured, the product image upload action reports that setup is required.

## Implemented modules

- Storefront catalogue is loaded from active MySQL products and active bundle records.
- Homepage and recipes pages display published recipes managed in the ERP; recipe detail pages show ingredients, method and image gallery.
- Separate `/admin` ERP workspace with overview, sales reporting, orders, products, categories, collections, bundles, inventory, customers, discounts, reviews, newsletter subscriber export, reports, activity and settings views.
- Product create/edit, publication state, SKU, pricing, stock, image URL and Cloudinary upload.
- Inventory adjustments and order stock reservations are recorded as inventory transactions.
- Coupon validation and usage limits are checked server-side during order creation.
- Order detail timeline, fulfilment updates, tracking details, internal notes, Adyen refund requests and confirmation-email resend.
- Adyen authorisation and refund webhook handling with HMAC verification and idempotent terminal transitions.
- Customer dashboard, order history/detail, reorder using current availability, profile editing, addresses, wishlist, password change and account deletion request.
- Role names supported: `OWNER`, `ADMIN`, `STORE_ADMIN`, `ORDER_MANAGER`, `INVENTORY_MANAGER`, `CUSTOMER_SUPPORT`, and `CUSTOMER`. Existing admin seed account uses `ADMIN`.

## Important operational notes / remaining work before production

This is an extension of the supplied application, not a claim that every item in the original aspirational brief is complete. The following still require implementation or live verification before production:

- Database integration tests against your actual MySQL version and a full end-to-end checkout test with Adyen sandbox credentials.
- Automatic expiry/release of stock reservations for abandoned, unpaid orders. Failed payment, payment-session failure and administrator cancellation release reservations; abandoned sessions need a scheduled expiry worker.
- Multiple product image gallery, drag-and-drop ordering, alt-text editor, rich-text product editor, variants, complete BBQ metadata/SEO editor and category/collection storefront merchandising controls.
- Full role/permission administration UI and granular restrictions for every read/write action. The critical refund, inventory, product, order and settings operations have role checks, but this should receive a formal security review.
- PayPal, shipping carrier APIs, automated tax calculation, full returns workflow, and tax-compliance reporting are not configured or claimed as implemented.
- Newsletter campaigns are sent synchronously through the Hostinger SMTP mailbox. Check Hostinger mailbox sending limits and send smaller campaigns if the subscriber list grows; for high-volume marketing use a dedicated campaign provider.
- Email-change verification and customer self-service account deletion completion are request workflows, not automatic account mutations.
- Product bundles are managed in the ERP, but bundle component stock calculation and bundle checkout integration still need to be connected before publishing bundles.
- Review submission/storefront moderation display and collection-based coupon eligibility are not fully wired into the storefront checkout.
- Add production monitoring, backups, log retention, HTTPS, rate-limit storage shared across instances, and an independent penetration test.

## Main routes

- Storefront: `/`, `/shop`, `/story`, `/recipes`, `/contact`, `/checkout`
- Customer: `/account`; APIs under `/api/account/*`
- Admin: `/admin`; APIs under `/api/admin/*`
- Authentication: `/api/auth/*` (registration verification, resend verification, forgot password and reset password)
- Newsletter: `/api/newsletter/subscribe`, `/api/newsletter/unsubscribe`
- Recipes: `/recipes`, `/recipes/:slug`; admin CRUD at `/api/admin/recipes`
- Orders: `/api/orders/*`
- Payments: `/api/payments/adyen/*`
- Public catalogue: `/api/catalog`

## Security

Do not commit `.env`. Keep database credentials, Adyen API/HMAC keys, SMTP mailbox password and Cloudinary API secret server-side. Use HTTPS in production. Use a strong unique session secret. Rotate any credentials that may have been included in older copies of this project. The application stores money as integer AUD cents and does not store card numbers.
