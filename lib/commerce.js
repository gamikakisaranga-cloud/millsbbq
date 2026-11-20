function calculateDiscount({ type, value, subtotalCents, shippingCents }) {
  const subtotal = Math.max(0, Math.trunc(Number(subtotalCents) || 0));
  const shipping = Math.max(0, Math.trunc(Number(shippingCents) || 0));
  let discountCents = 0;
  let merchandiseDiscountCents = 0;
  let finalShippingCents = shipping;
  if (type === 'PERCENT') { merchandiseDiscountCents = Math.min(subtotal, Math.round(subtotal * Math.min(100, Math.max(0, Number(value))) / 100)); discountCents = merchandiseDiscountCents; }
  else if (type === 'FIXED') { merchandiseDiscountCents = Math.min(subtotal, Math.max(0, Math.trunc(Number(value) || 0))); discountCents = merchandiseDiscountCents; }
  else if (type === 'FREE_SHIPPING') { discountCents = shipping; finalShippingCents = 0; }
  else throw new Error('Unsupported discount type.');
  return { discountCents, shippingCents: finalShippingCents, totalCents: Math.max(0, subtotal + finalShippingCents - merchandiseDiscountCents) };
}
function makeSlug(value) { return String(value || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 140); }
module.exports = { calculateDiscount, makeSlug };
