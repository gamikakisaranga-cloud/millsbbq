(() => {
  'use strict';

  const PRODUCTS = window.MILLS_PRODUCTS || [];
  const BUNDLES = window.MILLS_BUNDLES || [];
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
  const FREE_SHIPPING_THRESHOLD = 150;
  const money = value => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(value);
  const icon = name => {
    const icons = {
      bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 8h12l1 13H5L6 8Z"/><path d="M9 9V6a3 3 0 0 1 6 0v3"/></svg>',
      eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>',
      close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      arrow: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>'
    };
    return icons[name] || '';
  };

  const state = {
    cart: JSON.parse(localStorage.getItem('mills-cart') || '[]'),
    activeProduct: null,
    modalQty: 1,
    shopFilter: 'all',
    shopSearch: '',
    shopSort: 'featured'
  };

  function saveCart() {
    localStorage.setItem('mills-cart', JSON.stringify(state.cart));
    updateCartUI();
  }

  function getProduct(id) {
    return PRODUCTS.find(p => p.id === id);
  }

  function packMarkup(product, extraClass = '') {
    return `
      <div class="pack ${extraClass}" style="--pack-color:${product.color};--pack-accent:${product.accent}">
        <div class="pack__label">
          ${product.imageUrl ? `<img class="pack__photo" src="${product.imageUrl}" alt="${product.name}" loading="lazy">` : ''}
          <img class="pack__logo" src="/assets/images/logo-bull.png" alt="" aria-hidden="true">
          <div class="pack__name">${product.name}</div>
          <div class="pack__type">Premium BBQ Rub</div>
          <div class="pack__weight">${product.size}</div>
        </div>
      </div>`;
  }

  function heatMarkup(level) {
    return `<div class="heat"><span>Heat</span><span class="heat__dots">${[1,2,3,4,5].map(n => `<i class="${n <= level ? 'on' : ''}"></i>`).join('')}</span></div>`;
  }

  function productCard(product) {
    return `
      <article class="product-card reveal" style="--card-accent:${product.accent}" data-product-card="${product.id}">
        <div class="product-card__visual">
          ${product.badge ? `<span class="product-card__badge">${product.badge}</span>` : ''}
          <button class="icon-btn product-card__quick" type="button" aria-label="Quick view ${product.name}" data-quick-view="${product.id}">${icon('eye')}</button>
          ${packMarkup(product)}
        </div>
        <div class="product-card__body">
          <div class="product-card__meta">
            <div><h3>${product.name}</h3><p class="product-card__short">${product.short}</p></div>
            <div class="product-card__price">${money(product.price)}${product.oldPrice ? `<span class="product-card__old">${money(product.oldPrice)}</span>` : ''}</div>
          </div>
          ${heatMarkup(product.heat)}
          <div class="product-card__bottom">
            <span class="product-card__profile">${product.profile}</span>
            <button class="btn btn--primary btn--small add-btn" type="button" data-add="${product.id}">${icon('bag')} Add</button>
          </div>
        </div>
      </article>`;
  }

  function renderProducts(target, items) {
    if (!target) return;
    target.innerHTML = items.map(productCard).join('');
    observeReveals(target);
  }

  function renderFeatured() {
    renderProducts($('#featured-products'), PRODUCTS.slice(0, 4));
  }

  function renderShop() {
    const grid = $('#shop-products');
    if (!grid) return;
    let items = PRODUCTS.filter(p => {
      const categoryMatch = state.shopFilter === 'all' || p.category === state.shopFilter || p.protein.includes(state.shopFilter);
      const haystack = `${p.name} ${p.short} ${p.profile} ${p.category} ${p.protein.join(' ')}`.toLowerCase();
      return categoryMatch && haystack.includes(state.shopSearch.toLowerCase());
    });
    if (state.shopSort === 'price-low') items.sort((a,b) => a.price - b.price);
    if (state.shopSort === 'price-high') items.sort((a,b) => b.price - a.price);
    if (state.shopSort === 'heat') items.sort((a,b) => b.heat - a.heat);
    if (state.shopSort === 'name') items.sort((a,b) => a.name.localeCompare(b.name));
    renderProducts(grid, items);
    const label = $('#results-label');
    if (label) label.textContent = `${items.length} product${items.length === 1 ? '' : 's'} found`;
  }

  function renderBundles() {
    const target = $('#bundle-grid');
    if (!target) return;
    target.innerHTML = BUNDLES.map(bundle => {
      const products = bundle.products.map(getProduct).filter(Boolean);
      return `
        <article class="bundle-card reveal">
          <div class="bundle-card__visual">
            ${products.map((p, i) => `<div class="pack bundle-mini" style="--pack-color:${p.color};--pack-accent:${p.accent};--rot:${(i - (products.length-1)/2)*7}deg;--z:${i+1}"><div class="pack__label"><img class="pack__logo" src="/assets/images/logo-bull.png" alt="" aria-hidden="true"><div class="pack__name">${p.name}</div><div class="pack__type">Premium BBQ Rub</div><div class="pack__weight">${p.size}</div></div></div>`).join('')}
          </div>
          <div class="bundle-card__body">
            <span class="bundle-card__tag">${bundle.tag}</span>
            <h3>${bundle.name}</h3>
            <p>${bundle.description}</p>
            <div class="bundle-card__footer">
              <div><span class="bundle-price">${money(bundle.price)}</span><span class="bundle-save">Save ${bundle.save}</span></div>
              <button class="btn btn--primary btn--small" type="button" data-bundle-add="${bundle.id}">Add box</button>
            </div>
          </div>
        </article>`;
    }).join('');
    observeReveals(target);
  }

  function addToCart(id, qty = 1, silent = false) {
    const product = getProduct(id);
    if (!product) return;
    const item = state.cart.find(i => i.id === id);
    if (item) item.qty += qty;
    else state.cart.push({ id, qty });
    saveCart();
    if (!silent) showToast(`${product.name} added to your cart`);
  }

  function addBundle(id) {
    const bundle = BUNDLES.find(b => b.id === id);
    if (!bundle) return;
    bundle.products.forEach(pid => addToCart(pid, 1, true));
    showToast(`${bundle.name} added to your cart`);
    openCart();
  }

  function cartSubtotal() {
    return state.cart.reduce((sum, item) => {
      const p = getProduct(item.id);
      return sum + (p ? p.price * item.qty : 0);
    }, 0);
  }

  function updateCartUI() {
    const count = state.cart.reduce((sum, i) => sum + i.qty, 0);
    $$('.cart-count').forEach(el => el.textContent = count);
    const target = $('#cart-items');
    const subtotalEl = $('#cart-subtotal');
    const progress = $('#shipping-bar');
    const shippingText = $('#shipping-text');
    const subtotal = cartSubtotal();
    if (subtotalEl) subtotalEl.textContent = money(subtotal);
    if (progress) progress.style.width = `${Math.min(100, (subtotal / FREE_SHIPPING_THRESHOLD) * 100)}%`;
    if (shippingText) shippingText.textContent = subtotal >= FREE_SHIPPING_THRESHOLD ? 'You unlocked free delivery.' : `Add ${money(FREE_SHIPPING_THRESHOLD - subtotal)} more for free delivery.`;
    if (!target) return;
    if (!state.cart.length) {
      target.innerHTML = `<div class="cart-empty"><div>${icon('bag')}<strong>Your cart is waiting for fire.</strong><p>Add a rub and start building your cook.</p></div></div>`;
    } else {
      target.innerHTML = state.cart.map(item => {
        const p = getProduct(item.id);
        if (!p) return '';
        return `<div class="cart-item">
          <div class="cart-item__visual">${packMarkup(p)}</div>
          <div><h4>${p.name}</h4><small>${p.size}</small><div class="qty"><button type="button" data-qty="minus" data-id="${p.id}" aria-label="Decrease quantity">−</button><span>${item.qty}</span><button type="button" data-qty="plus" data-id="${p.id}" aria-label="Increase quantity">+</button></div></div>
          <div class="cart-item__price">${money(p.price * item.qty)}<button class="cart-item__remove" type="button" data-remove="${p.id}">Remove</button></div>
        </div>`;
      }).join('');
    }
    renderCheckoutSummary();
  }

  function changeQty(id, delta) {
    const item = state.cart.find(i => i.id === id);
    if (!item) return;
    item.qty += delta;
    if (item.qty <= 0) state.cart = state.cart.filter(i => i.id !== id);
    saveCart();
  }

  function openCart() {
    $('#cart-drawer')?.classList.add('open');
    $('#drawer-overlay')?.classList.add('open');
    document.body.classList.add('no-scroll');
  }
  function closeCart() {
    $('#cart-drawer')?.classList.remove('open');
    $('#drawer-overlay')?.classList.remove('open');
    if (!$('#product-modal')?.classList.contains('open') && !$('#recipe-modal')?.classList.contains('open')) document.body.classList.remove('no-scroll');
  }

  function openProduct(id) {
    const p = getProduct(id);
    const modal = $('#product-modal');
    const body = $('#product-modal-body');
    if (!p || !modal || !body) return;
    state.activeProduct = p;
    state.modalQty = 1;
    body.innerHTML = `
      <div class="product-modal__grid">
        <div class="product-modal__visual">${packMarkup(p)}</div>
        <div class="product-modal__content">
          <span class="eyebrow">${p.badge || 'Premium BBQ Rub'}</span>
          <h2>${p.name}</h2>
          <div class="product-modal__price">${money(p.price)}</div>
          <p class="product-modal__desc">${p.description}</p>
          ${heatMarkup(p.heat)}
          <div class="product-info-row"><strong>Profile</strong><span>${p.profile}</span></div>
          <div class="product-info-row"><strong>Ingredients</strong><span>${p.ingredients}</span></div>
          <div class="product-info-row"><strong>How to use</strong><span>${p.use}</span></div>
          <div class="product-info-row"><strong>Size</strong><span>${p.size}</span></div>
          <div class="product-modal__buy">
            <div class="qty"><button type="button" data-modal-qty="minus">−</button><span id="modal-qty">1</span><button type="button" data-modal-qty="plus">+</button></div>
            <button class="btn btn--dark" type="button" data-modal-add>Add to cart · ${money(p.price)}</button>
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    $('#modal-overlay')?.classList.add('open');
    document.body.classList.add('no-scroll');
  }

  function closeModal() {
    $$('.modal').forEach(m => m.classList.remove('open'));
    $('#modal-overlay')?.classList.remove('open');
    document.body.classList.remove('no-scroll');
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function observeReveals(scope = document) {
    const items = $$('.reveal:not(.in)', scope);
    if (!('IntersectionObserver' in window)) {
      items.forEach(el => el.classList.add('in'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: .12 });
    items.forEach(el => observer.observe(el));
  }

  function initHeader() {
    const header = $('#header');
    const handler = () => header?.classList.toggle('scrolled', scrollY > 30);
    handler();
    addEventListener('scroll', handler, { passive: true });
  }

  function initMobileMenu() {
    const button = $('#mobile-toggle');
    const menu = $('#mobile-menu');
    button?.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      button.setAttribute('aria-expanded', String(open));
    });
    $$('a', menu || document.createElement('div')).forEach(a => a.addEventListener('click', () => menu.classList.remove('open')));
  }

  function initSmoke() {
    const canvas = $('#smoke-canvas');
    if (!canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    let particles = [];
    function resize() { canvas.width = innerWidth * devicePixelRatio; canvas.height = innerHeight * devicePixelRatio; ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0); }
    function reset(p, initial = false) {
      p.x = innerWidth * (.52 + Math.random() * .5);
      p.y = initial ? Math.random() * innerHeight : innerHeight + 80;
      p.r = 60 + Math.random() * 150;
      p.vx = -.12 + Math.random() * .24;
      p.vy = -.15 - Math.random() * .35;
      p.a = .008 + Math.random() * .02;
    }
    particles = Array.from({ length: innerWidth < 700 ? 7 : 14 }, () => { const p={}; reset(p, true); return p; });
    function draw() {
      ctx.clearRect(0,0,innerWidth,innerHeight);
      particles.forEach(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.y < -p.r * 2) reset(p);
        const g = ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r);
        g.addColorStop(0, `rgba(210,205,195,${p.a})`);
        g.addColorStop(1, 'rgba(210,205,195,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fill();
      });
      requestAnimationFrame(draw);
    }
    resize(); addEventListener('resize', resize); draw();
  }

  function initCursorGlow() {
    const glow = $('#cursor-glow');
    if (!glow || matchMedia('(pointer: coarse)').matches) return;
    addEventListener('pointermove', e => { glow.style.left = `${e.clientX}px`; glow.style.top = `${e.clientY}px`; }, { passive: true });
  }

  function initEmbers() {
    const box = $('#spice-dust');
    if (box) box.innerHTML = Array.from({length: 20}, (_, i) => `<i style="left:${25 + Math.random()*55}%;bottom:${Math.random()*18}%;--duration:${4 + Math.random()*4}s;animation-delay:${Math.random()*5}s"></i>`).join('');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    $$('.page-hero').forEach(hero => {
      if (hero.querySelector('.hero-embers')) return;
      const layer = document.createElement('div');
      layer.className = 'hero-embers';
      layer.setAttribute('aria-hidden', 'true');
      layer.innerHTML = Array.from({length: 14}, () => `<i style="left:${Math.random()*100}%;bottom:${Math.random()*30 - 10}%;--duration:${5 + Math.random()*5}s;animation-delay:${Math.random()*6}s"></i>`).join('');
      hero.prepend(layer);
    });
  }

  function initQuiz() {
    const quiz = $('#flavour-quiz');
    if (!quiz) return;
    const answers = {};
    quiz.addEventListener('click', e => {
      const option = e.target.closest('[data-quiz-answer]');
      if (!option) return;
      const step = Number(option.closest('.quiz__step').dataset.step);
      answers[option.dataset.key] = option.dataset.quizAnswer;
      const current = $(`.quiz__step[data-step="${step}"]`, quiz);
      const next = $(`.quiz__step[data-step="${step+1}"]`, quiz);
      current?.classList.remove('active');
      if (next) next.classList.add('active');
      else showQuizResult(answers, quiz);
      $$('.quiz__progress i', quiz).forEach((bar, i) => bar.classList.toggle('active', i <= step));
    });
    quiz.addEventListener('click', e => {
      if (e.target.closest('[data-quiz-restart]')) {
        $$('.quiz__step', quiz).forEach(s => s.classList.remove('active'));
        $('.quiz__step[data-step="1"]', quiz)?.classList.add('active');
        $$('.quiz__progress i', quiz).forEach((bar, i) => bar.classList.toggle('active', i === 0));
      }
      const add = e.target.closest('[data-quiz-add]');
      if (add) addToCart(add.dataset.quizAdd);
    });
  }

  function showQuizResult(answers, quiz) {
    let id = 'original-smoke';
    if (answers.heat === 'hot') id = 'hot-ember';
    else if (answers.protein === 'beef') id = 'brisket-black';
    else if (answers.protein === 'chicken') id = 'chicken-fire-dust';
    else if (answers.protein === 'seafood') id = 'coastal-char';
    else if (answers.protein === 'vegetables') id = 'garden-smoke';
    else if (answers.flavour === 'sweet') id = 'sweet-heat';
    else if (answers.flavour === 'garlic') id = 'smoky-garlic';
    const p = getProduct(id);
    const result = $('.quiz__step[data-step="result"]', quiz);
    result.innerHTML = `<div class="quiz-result">${packMarkup(p)}<div><span class="eyebrow">Your match</span><h3 class="quiz__question" style="font-size:3.5rem">${p.name}</h3><p>${p.description}</p><div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:20px"><button class="btn btn--dark" data-quiz-add="${p.id}">Add ${money(p.price)}</button><button class="btn btn--ghost" style="border-color:rgba(0,0,0,.2);color:#111" data-quiz-restart>Try again</button></div></div></div>`;
    result.classList.add('active');
  }

  function initForms() {
    $$('[data-demo-form]').forEach(form => form.addEventListener('submit', e => {
      e.preventDefault();
      form.reset();
      showToast(form.dataset.success || 'Thanks — your message has been received.');
    }));
    $$('.faq button').forEach(btn => btn.addEventListener('click', () => btn.closest('.faq').classList.toggle('open')));
  }

  function renderCheckoutSummary() {
    const target = $('#checkout-items');
    if (!target) return;
    const subtotal = cartSubtotal();
    target.innerHTML = state.cart.length ? state.cart.map(item => {
      const p = getProduct(item.id);
      return `<div class="checkout-item"><div class="checkout-item__thumb">${packMarkup(p)}</div><div><strong>${p.name}</strong><small>Qty ${item.qty}</small></div><span>${money(p.price * item.qty)}</span></div>`;
    }).join('') : '<p class="muted">Your cart is empty. Add products before checking out.</p>';
    const shipping = subtotal >= FREE_SHIPPING_THRESHOLD || subtotal === 0 ? 0 : 15;
    $('#checkout-subtotal') && ($('#checkout-subtotal').textContent = money(subtotal));
    $('#checkout-shipping') && ($('#checkout-shipping').textContent = shipping ? money(shipping) : 'Free');
    $('#checkout-total') && ($('#checkout-total').textContent = money(subtotal + shipping));
    const submit = $('#place-order');
    if (submit) submit.disabled = !state.cart.length;
  }

  function initCheckout() {
    const form = $('#checkout-form');
    if (!form) return;
    let createdOrder = null;
    const returnedOrderId = new URLSearchParams(location.search).get('orderId');
    if (returnedOrderId) {
      history.replaceState({}, '', '/checkout');
      resumeAdyenCheckout(returnedOrderId);
      return;
    }

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (!state.cart.length) return showToast('Your cart is empty.');
      const status = $('#checkout-status');
      const submitBtn = $('#place-order');
      const payload = {
        email: $('#checkout-email').value.trim(),
        firstName: $('#first-name').value.trim(),
        lastName: $('#last-name').value.trim(),
        phone: $('#checkout-phone').value.trim(),
        address: $('#address').value.trim(),
        city: $('#city').value.trim(),
        postcode: $('#postal').value.trim(),
        country: 'Australia',
        couponCode: $('#coupon-code')?.value.trim() || undefined,
        items: state.cart.map(item => ({ productId: item.id, quantity: item.qty }))
      };
      submitBtn.disabled = true;
      status.textContent = 'Creating your order…';
      try {
        const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'Could not create the order.');
        createdOrder = result.order;
        if ($('#checkout-shipping')) $('#checkout-shipping').textContent = result.order.shippingCents ? money(result.order.shippingCents / 100) : 'Free';
        if ($('#checkout-total')) $('#checkout-total').textContent = money(result.order.totalCents / 100);
        if ($('#checkout-discount-line')) { $('#checkout-discount-line').hidden = !result.order.discountCents; if (result.order.discountCents) $('#checkout-discount').textContent = '−' + money(result.order.discountCents / 100); }
        status.textContent = `Order ${createdOrder.orderNumber} created — total ${money(createdOrder.totalCents / 100)}. Complete payment below.`;
        submitBtn.hidden = true;
        $$('#checkout-form input, #checkout-form select').forEach(field => field.disabled = true);
        await renderAdyenDropin(createdOrder);
      } catch (error) {
        status.textContent = error.message || 'Something went wrong creating your order.';
        submitBtn.disabled = false;
      }
    });
  }

  async function renderAdyenDropin(order, existingSession = null) {
    const section = $('#adyen-section');
    const note = $('#adyen-note');
    section.hidden = false;
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const configResponse = await fetch('/api/payments/adyen/config');
    const config = await configResponse.json();
    if (!config.ok) {
      note.textContent = config.error || 'Adyen is not configured on this server.';
      return;
    }

    const sdkBase = config.environment === 'live' ? 'https://checkoutshopper-live.adyen.com' : 'https://checkoutshopper-test.adyen.com';
    const sdkUrl = `${sdkBase}/checkoutshopper/sdk/6.0.0`;
    if (!window.AdyenCheckout) {
      await new Promise((resolve, reject) => {
        const stylesheet = document.createElement('link');
        stylesheet.rel = 'stylesheet';
        stylesheet.href = `${sdkUrl}/adyen.css`;
        document.head.appendChild(stylesheet);
        const script = document.createElement('script');
        script.src = `${sdkUrl}/adyen.js`;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      }).catch(() => { note.textContent = 'Could not load Adyen Checkout. Check your connection and try again.'; });
    }
    if (!window.AdyenCheckout) return;

    try {
      let session = existingSession;
      let environment = config.environment;
      if (!session) {
        const response = await fetch('/api/payments/adyen/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: order.id }) });
        const result = await response.json();
        if (!result.ok) throw new Error(result.error || 'Could not start Adyen checkout.');
        session = result.session;
        environment = result.environment;
      }
      const checkout = await window.AdyenCheckout({
        environment,
        clientKey: config.clientKey,
        session,
        onPaymentCompleted: async paymentResult => {
          note.textContent = `Payment result: ${paymentResult.resultCode}. Waiting for Adyen confirmation…`;
          for (let attempt = 0; attempt < 10; attempt += 1) {
            const statusResponse = await fetch(`/api/payments/adyen/status/${encodeURIComponent(order.id)}`);
            const statusResult = await statusResponse.json();
            if (statusResult.status === 'PAID') {
              completeAdyenOrder(order);
              return;
            }
            if (statusResult.paymentStatus === 'FAILED') {
              note.textContent = 'Adyen did not authorize this payment. You can try again with another payment method.';
              return;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          note.textContent = 'Payment submitted. Adyen confirmation is still pending; your order will update when it is received.';
        },
        onError: () => { note.textContent = 'Adyen could not complete the payment. Please try again.'; }
      });
      checkout.create('dropin').mount('#adyen-dropin');
      note.textContent = config.environment === 'test' ? 'Adyen test environment.' : '';
    } catch (error) {
      note.textContent = error.message || 'Could not start Adyen checkout.';
    }
  }

  async function resumeAdyenCheckout(orderId) {
    const form = $('#checkout-form');
    const note = $('#adyen-note');
    const section = $('#adyen-section');
    const status = $('#checkout-status');
    try {
      const response = await fetch(`/api/payments/adyen/sessions/${encodeURIComponent(orderId)}`);
      const result = await response.json();
      if (!result.ok) throw new Error(result.error || 'Could not restore Adyen checkout.');
      if (result.status === 'PAID') {
        completeAdyenOrder({ id: orderId, orderNumber: result.orderNumber });
        return;
      }
      if (result.status !== 'PENDING' || !result.session) throw new Error('This payment session is no longer active. Place your order again to retry.');

      form.hidden = false;
      $$('#checkout-form input, #checkout-form select').forEach(field => field.disabled = true);
      $('#place-order').hidden = true;
      section.hidden = false;
      status.textContent = `Resuming payment for order ${result.orderNumber}…`;
      await renderAdyenDropin({ id: orderId, orderNumber: result.orderNumber }, result.session);
    } catch (error) {
      status.textContent = error.message || 'Could not restore your payment session. Please place the order again.';
      $('#place-order').hidden = false;
      $$('#checkout-form input, #checkout-form select').forEach(field => field.disabled = false);
      note.textContent = '';
    }
  }

  function completeAdyenOrder(order) {
    state.cart = [];
    saveCart();
    $('#checkout-form').innerHTML = `<div style="text-align:center;padding:40px 10px"><div style="width:74px;height:74px;border-radius:50%;background:rgba(255,90,24,.13);color:var(--ember);display:grid;place-items:center;margin:0 auto 20px;font-size:2rem">✓</div><h2>Payment received</h2><p class="lead" style="margin-inline:auto">Order <strong>${order.orderNumber}</strong> is paid via Adyen.</p><a class="btn btn--primary" href="/shop">Continue shopping</a></div>`;
    scrollTo({ top: 0, behavior: 'smooth' });
  }

  function initRecipes() {
    const recipes = {
      brisket: { title:'Black Bark Brisket', time:'8–10 hours', rub:'Brisket Black', ingredients:['2.5–3 kg beef brisket','Brisket Black rub','Yellow mustard or neutral oil','Apple juice for spritzing'], steps:['Trim excess hard fat, leaving a thin, even fat cap.','Apply a light binder and coat generously with Brisket Black.','Smoke at 120°C / 250°F until the bark is set and internal temperature reaches around 74°C / 165°F.','Wrap and continue cooking until probe tender, usually 93–96°C / 200–205°F.','Rest for at least one hour before slicing against the grain.'] },
      wings: { title:'Sweet Heat Wings', time:'45 minutes', rub:'Sweet Heat BBQ', ingredients:['1 kg chicken wings','Sweet Heat BBQ rub','1 tbsp neutral oil','Optional honey glaze'], steps:['Pat wings very dry and toss with oil.','Coat evenly with Sweet Heat BBQ rub.','Grill over medium heat, turning regularly, until crisp and fully cooked.','Brush with a light honey glaze during the final five minutes.','Rest briefly and serve with cooling dip.'] },
      prawns: { title:'Coastal Char Prawns', time:'20 minutes', rub:'Coastal Char', ingredients:['500 g large prawns','Coastal Char rub','1 tbsp olive oil','Fresh lime'], steps:['Clean and dry the prawns.','Toss with oil and Coastal Char immediately before cooking.','Grill over high heat for 2–3 minutes per side.','Finish with fresh lime and serve straight away.'] },
      corn: { title:'Smoky Street Corn', time:'30 minutes', rub:'Garden Smoke', ingredients:['4 corn cobs','Garden Smoke rub','Butter or olive oil','Lime and grated cheese'], steps:['Lightly coat corn with butter or oil.','Season with Garden Smoke.','Grill over medium heat, turning until charred and tender.','Finish with lime and grated cheese.'] }
    };
    document.addEventListener('click', e => {
      const trigger = e.target.closest('[data-recipe]');
      if (!trigger) return;
      e.preventDefault();
      const r = recipes[trigger.dataset.recipe];
      if (!r) return;
      const modal = $('#recipe-modal');
      const body = $('#recipe-modal-body');
      if (!modal || !body) return;
      body.innerHTML = `<div style="padding:clamp(30px,6vw,68px)"><span class="eyebrow">Fire-tested recipe</span><h2 class="display display--md">${r.title}</h2><p><strong>Time:</strong> ${r.time} &nbsp; · &nbsp; <strong>Recommended rub:</strong> ${r.rub}</p><div class="recipe-modal-body"><h3>Ingredients</h3><ul>${r.ingredients.map(i=>`<li>${i}</li>`).join('')}</ul><h3>Method</h3><ol class="recipe-steps">${r.steps.map(s=>`<li>${s}</li>`).join('')}</ol></div></div>`;
      modal.classList.add('open'); $('#modal-overlay')?.classList.add('open'); document.body.classList.add('no-scroll');
    });
  }

  function bindGlobalEvents() {
    document.addEventListener('click', e => {
      const checkout = e.target.closest('a[href="/checkout"]');
      if (checkout && !state.cart.length) {
        e.preventDefault();
        showToast('Add products to your cart before checkout.');
        return;
      }
      const add = e.target.closest('[data-add]');
      if (add) addToCart(add.dataset.add);
      const quick = e.target.closest('[data-quick-view]');
      if (quick) openProduct(quick.dataset.quickView);
      const bundle = e.target.closest('[data-bundle-add]');
      if (bundle) addBundle(bundle.dataset.bundleAdd);
      const cartOpen = e.target.closest('[data-cart-open]');
      if (cartOpen) openCart();
      if (e.target.closest('[data-cart-close]') || e.target.id === 'drawer-overlay') closeCart();
      if (e.target.closest('[data-modal-close]') || e.target.id === 'modal-overlay') closeModal();
      const qty = e.target.closest('[data-qty]');
      if (qty) changeQty(qty.dataset.id, qty.dataset.qty === 'plus' ? 1 : -1);
      const remove = e.target.closest('[data-remove]');
      if (remove) { state.cart = state.cart.filter(i => i.id !== remove.dataset.remove); saveCart(); }
      const modalQty = e.target.closest('[data-modal-qty]');
      if (modalQty) {
        state.modalQty = Math.max(1, state.modalQty + (modalQty.dataset.modalQty === 'plus' ? 1 : -1));
        $('#modal-qty').textContent = state.modalQty;
        const btn = $('[data-modal-add]');
        if (btn && state.activeProduct) btn.textContent = `Add to cart · ${money(state.activeProduct.price * state.modalQty)}`;
      }
      if (e.target.closest('[data-modal-add]') && state.activeProduct) {
        addToCart(state.activeProduct.id, state.modalQty);
        closeModal(); openCart();
      }
      const filter = e.target.closest('[data-filter]');
      if (filter) {
        state.shopFilter = filter.dataset.filter;
        $$('[data-filter]').forEach(btn => btn.classList.toggle('active', btn === filter));
        renderShop();
      }
    });
    addEventListener('keydown', e => { if (e.key === 'Escape') { closeCart(); closeModal(); } });
  }

  function initShopControls() {
    const params = new URLSearchParams(location.search);
    const requestedFilter = params.get('filter');
    if (requestedFilter) {
      state.shopFilter = requestedFilter;
      $$('[data-filter]').forEach(btn => btn.classList.toggle('active', btn.dataset.filter === requestedFilter));
      renderShop();
    }
    $('#shop-search')?.addEventListener('input', e => { state.shopSearch = e.target.value; renderShop(); });
    $('#shop-sort')?.addEventListener('change', e => { state.shopSort = e.target.value; renderShop(); });
  }

  function setYear() { $$('.current-year').forEach(el => el.textContent = new Date().getFullYear()); }

  async function init() {
    try { const response = await fetch('/api/catalog'); if (response.ok) { const catalog = await response.json(); if (catalog.ok) { const safe = v => String(v ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c])); const productsSafe = catalog.products.map(p => ({...p,id:safe(p.id),name:safe(p.name),short:safe(p.short),size:safe(p.size),category:safe(p.category),profile:safe(p.profile),badge:safe(p.badge),description:safe(p.description),ingredients:safe(p.ingredients),use:safe(p.use),imageUrl:/^https:\/\//i.test(p.imageUrl||'')?safe(p.imageUrl):'',color:/^#[0-9a-f]{6}$/i.test(p.color)?p.color:'#302b25',accent:/^#[0-9a-f]{6}$/i.test(p.accent)?p.accent:'#d9a441'})); const bundlesSafe = catalog.bundles.map(b=>({...b,id:safe(b.id),name:safe(b.name),description:safe(b.description),products:b.products.map(safe)})); window.MILLS_PRODUCTS = productsSafe; window.MILLS_BUNDLES = bundlesSafe; PRODUCTS.splice(0, PRODUCTS.length, ...productsSafe); BUNDLES.splice(0, BUNDLES.length, ...bundlesSafe); } } } catch (error) { console.warn('Using cached catalogue data.', error); }
    renderFeatured(); renderShop(); renderBundles();
    updateCartUI(); initHeader(); initMobileMenu(); initSmoke(); initCursorGlow(); initEmbers();
    observeReveals(); initQuiz(); initForms(); initCheckout(); initRecipes(); initShopControls(); bindGlobalEvents(); setYear();
  }

  document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
