const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateDiscount, makeSlug } = require('../lib/commerce');
test('percentage discount is calculated in integer cents', () => {
  assert.deepEqual(calculateDiscount({type:'PERCENT',value:15,subtotalCents:10001,shippingCents:1200}), {discountCents:1500,shippingCents:1200,totalCents:9701});
});
test('fixed discount cannot exceed merchandise subtotal', () => {
  assert.deepEqual(calculateDiscount({type:'FIXED',value:5000,subtotalCents:3000,shippingCents:900}), {discountCents:3000,shippingCents:900,totalCents:900});
});
test('free shipping removes only the shipping amount', () => {
  assert.deepEqual(calculateDiscount({type:'FREE_SHIPPING',value:0,subtotalCents:8000,shippingCents:1200}), {discountCents:1200,shippingCents:0,totalCents:8000});
});
test('slugs are URL-safe', () => assert.equal(makeSlug('Brisket Black & Smoke!'), 'brisket-black-smoke'));
