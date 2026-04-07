// ===================================================
// ROUTE : /api/payments
// Intégration Stripe Checkout + Webhooks
// ===================================================

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const stripeService = require('../services/stripe');
const { requireAuth } = require('./auth');

const router   = express.Router();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// TODO: Configurez vos Price IDs Stripe dans le .env
// STRIPE_PRICE_STARTER=price_xxx
// STRIPE_PRICE_PRO=price_xxx
// STRIPE_PRICE_ILLIMITE=price_xxx
// STRIPE_PRICE_UNIT=price_xxx

const PRICE_MAP = {
  starter:  process.env.STRIPE_PRICE_STARTER,
  pro:      process.env.STRIPE_PRICE_PRO,
  expert:   process.env.STRIPE_PRICE_EXPERT,
  illimite: process.env.STRIPE_PRICE_ILLIMITE,
  unit:     process.env.STRIPE_PRICE_UNIT,
};

// ─── POST /api/payments/checkout ─────────────────────
// Crée une session Stripe Checkout et retourne l'URL
router.post('/checkout', async (req, res) => {
  const { plan, email } = req.body;

  if (!plan || !PRICE_MAP[plan]) {
    return res.status(400).json({ error: 'Plan invalide' });
  }

  try {
    const session = await stripeService.createCheckoutSession({
      priceId:    PRICE_MAP[plan],
      customerEmail: email,
      plan,
      successUrl: `${process.env.FRONTEND_URL}/pages/dashboard.html?payment=success`,
      cancelUrl:  `${process.env.FRONTEND_URL}/pages/register.html?payment=cancelled`,
      mode:       plan === 'unit' ? 'payment' : 'subscription',
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[payments/checkout]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/portal ───────────────────────
// Portail client Stripe (gérer abonnement, factures)
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', req.user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'Aucun abonnement actif trouvé.' });
    }

    const session = await stripeService.createPortalSession({
      customerId: profile.stripe_customer_id,
      returnUrl:  `${process.env.FRONTEND_URL}/pages/dashboard.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/payments/webhook ──────────────────────
// Reçoit les événements Stripe (raw body requis)
// Note : express.raw() est configuré dans server.js pour cette route
router.post('/webhook', async (req, res) => {
  const sig     = req.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET; // TODO: définir dans .env

  let event;
  try {
    event = stripeService.constructWebhookEvent(req.body, sig, secret);
  } catch (err) {
    console.error('[webhook] Signature invalide :', err.message);
    return res.status(400).json({ error: 'Signature Stripe invalide' });
  }

  // Traiter les événements Stripe
  try {
    switch (event.type) {

      // Paiement réussi (abonnement ou unit)
      case 'checkout.session.completed': {
        const session = event.data.object;
        const email   = session.customer_email;
        const plan    = session.metadata?.plan;

        // Trouver l'user Supabase par email pour récupérer son UUID
        const { data: authData } = await supabase.auth.admin.listUsers({ perPage: 1000 });
        const authUser = authData?.users?.find(u => u.email === email);

        if (authUser) {
          // UPSERT : crée le profil s'il n'existe pas, le met à jour sinon
          await supabase
            .from('profiles')
            .upsert({
              id:                     authUser.id,
              email,
              plan,
              stripe_customer_id:     session.customer,
              stripe_subscription_id: session.subscription,
              updated_at:             new Date().toISOString(),
            }, { onConflict: 'id' });
        } else {
          // Fallback : update par email si l'user existe déjà sans UUID connu
          await supabase
            .from('profiles')
            .update({ plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription, updated_at: new Date().toISOString() })
            .eq('email', email);
        }

        console.log(`✅ Paiement validé : ${email} → ${plan}`);
        break;
      }

      // Abonnement renouvelé
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await supabase
          .from('profiles')
          .update({ updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        break;
      }

      // Paiement échoué
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await supabase
          .from('profiles')
          .update({ plan: null, updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', invoice.customer);
        console.warn(`⚠️ Paiement échoué pour customer : ${invoice.customer}`);
        break;
      }

      // Abonnement résilié
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await supabase
          .from('profiles')
          .update({ plan: null, updated_at: new Date().toISOString() })
          .eq('stripe_customer_id', sub.customer);
        break;
      }

      default:
        // Événement non géré — ignorer
        break;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('[webhook] Erreur traitement :', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/payments/status ────────────────────────
router.get('/status', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, plan_active, stripe_customer_id')
    .eq('id', req.user.id)
    .single();

  res.json({
    plan:        profile?.plan || null,
    active:      !!profile?.plan,
    hasCustomer: !!profile?.stripe_customer_id,
  });
});

module.exports = router;
