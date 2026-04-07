// ===================================================
// SERVICE : Stripe
// ===================================================
// TODO: Insérez vos clés Stripe dans le .env :
//   STRIPE_SECRET_KEY=sk_live_xxx   (ou sk_test_xxx en dev)
//   STRIPE_WEBHOOK_SECRET=whsec_xxx
//   FRONTEND_URL=https://votre-site.vercel.app
// ===================================================

const Stripe = require('stripe');

// Initialisation du client Stripe
// La clé secrète ne doit JAMAIS être exposée côté client
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
});

// ─── createCheckoutSession ───────────────────────────
async function createCheckoutSession({
  priceId,
  customerEmail,
  plan,
  successUrl,
  cancelUrl,
  mode = 'subscription', // 'subscription' ou 'payment' pour à l'unité
}) {
  const session = await stripe.checkout.sessions.create({
    mode,
    customer_email:   customerEmail,
    line_items: [{
      price:    priceId,
      quantity: 1,
    }],
    metadata: { plan },
    success_url: successUrl + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url:  cancelUrl,
    billing_address_collection: 'auto',
    payment_method_types: ['card'],
    locale: 'fr',
    // Activer la saisie de code promo dans le Checkout Stripe
    allow_promotion_codes: true,
  });

  return session;
}

// ─── createPortalSession ─────────────────────────────
async function createPortalSession({ customerId, returnUrl }) {
  const session = await stripe.billingPortal.sessions.create({
    customer:   customerId,
    return_url: returnUrl,
  });
  return session;
}

// ─── constructWebhookEvent ───────────────────────────
function constructWebhookEvent(payload, sig, secret) {
  return stripe.webhooks.constructEvent(payload, sig, secret);
}

// ─── getCustomer ─────────────────────────────────────
async function getCustomer(customerId) {
  return stripe.customers.retrieve(customerId);
}

// ─── cancelSubscription ──────────────────────────────
async function cancelSubscription(subscriptionId) {
  return stripe.subscriptions.cancel(subscriptionId);
}

module.exports = {
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  getCustomer,
  cancelSubscription,
};
