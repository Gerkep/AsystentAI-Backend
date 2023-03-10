const express = require('express');
require('dotenv').config()
const bodyParser = require('body-parser');
const requireAuth = require('../middlewares/requireAuth');
const mongoose = require('mongoose');
const User = mongoose.model('User');
const Plan = mongoose.model('Plan');
const Payment = mongoose.model('Payment');
const Transaction = mongoose.model('Transaction');
const Whitelist = mongoose.model('Whitelist');
const axios = require('axios');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const purchaseEndpointSecret = 'whsec_NKIX7ahLbstNif0WGd7AIsIy170RqOzc';
const subscriptionEndpointSecret = 'whsec_NInmuuTZVfBMnfTzNFZJTl0I67u62GCz';
const infaktConfig = {
  headers: {
    'X-inFakt-ApiKey': `${process.env.INFAKT_KEY}`,
    'Content-Type': 'application/json',
  },
};

const router = express.Router();

router.post('/create-checkout-session', async (req, res) => {
  const { priceId, mode, successURL, cancelURL, email, tokensAmount, planId, referrerId, isTrial, asCompany } = req.body;
  try {
    let customer;
    try {
      const customerList = await stripe.customers.list({ email: email, limit: 1 });
      if (customerList.data.length > 0) {
        // Use existing customer object
        customer = customerList.data[0];
      } else {
        // Create new customer object
        customer = await stripe.customers.create({
          email: email
        });
      }

    } catch (e) {
      console.log(e)
    }

    let session;

    //if trial check planId(assistant) and mode to create trial stripe checkout
    if(isTrial && planId == "63f0e7d075de0ef12bb8c484" && mode === "subscription"){
      try {
        const whitelist = await Whitelist.findOne({ email });
    
        if (whitelist && planId) {
          session = await stripe.checkout.sessions.create({
            customer: customer.id,
            line_items: [
              {
                price: `${priceId}`,
                quantity: 1,
              },
            ],
            metadata: {
              tokens_to_add: `${tokensAmount}`,
              plan_id: `${planId}`, //plan id
              referrer_id: `${referrerId}`,
              trial: true,
              asCompany: asCompany
            },
            mode: `${mode}`,
            subscription_data: {
              trial_settings: {end_behavior: {missing_payment_method: 'cancel'}},
              trial_period_days: 30,
            },
            payment_method_collection: 'if_required',
            success_url: `${successURL}`,
            cancel_url: `${cancelURL}`,
          });
        } 

      } catch (error) {
        console.error(error);
      }
    } else {
      session = await stripe.checkout.sessions.create({
        customer: customer.id,
        line_items: [
          {
            price: `${priceId}`,
            quantity: 1,
          },
        ],
        metadata: {
          tokens_to_add: `${tokensAmount}`,
          plan_id: `${planId}`, //plan id
          referrer_id: `${referrerId}`,
          trial: false,
          asCompany: asCompany
        },
        mode: `${mode}`,
        success_url: `${successURL}`,
        cancel_url: `${cancelURL}`,
      });
    }


    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ message: "Error creating session for price" });
    console.log(e);
  }
});



//listening for one-time purchases as well as first payment of subscription
router.post('/one-time-checkout-webhook', bodyParser.raw({type: 'application/json'}), async (request, response) => {
  const payload = request.rawBody;
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, purchaseEndpointSecret);
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }
  const transactionData = event.data.object;
  if (event.type === 'checkout.session.completed') {
    let email = transactionData.customer_details.email;
    try{
      User.findOne({ email: email }, async (err, user) => {

        if(user){
          let transaction;
          let purchase;
          let invoiceData;
          let infaktClientId;
          const today = new Date();
          const year = today.getFullYear();
          const month = String(today.getMonth() + 1).padStart(2, '0');
          const day = String(today.getDate()).padStart(2, '0');

          if (transactionData.metadata.plan_id) { //initial subscription purchase
            try {
              const planId = transactionData.metadata.plan_id;
              const plan = await Plan.findById(planId);
              user.plan = plan;
              user.tokenBalance += plan.monthlyTokens;

              if(transactionData.metadata.trial){
                await Whitelist.deleteOne({ email });
              }

              // Create a new purchase
              purchase = new Payment({
                price: plan.price,
                tokens: plan.monthlyTokens,
                title: `Aktywacja subskrypcji ${plan.name}`,
                type: "one-time",
                timestamp: new Date()
              });
              user.purchases.push(purchase);

              // Create a new transaction
              transaction = new Transaction({
                  value: plan.monthlyTokens,
                  title: `Aktywacja subskrypcji ${plan.name}`,
                  type: 'income',
                  timestamp: Date.now()
              });
              user.transactions.push(transaction);

              //checking if transaction was referred
              if (transactionData.metadata.referrer_id) {
              try {
                const referrer = await User.findOne({ _id: transactionData.metadata.referrer_id });
                if(referrer){
                user.tokenBalance += 30000;
                referrer.tokenBalance += 30000;
    
                const referralTransaction = new Transaction({
                    value: 30000,
                    title: "30 000 elixiru w prezencie za polecenie",
                    type: "income",
                    timestamp: Date.now()
                });

                user.transactions.push(referralTransaction);
                referrer.transactions.push(referralTransaction);
    
                const referrerBalanceSnapshot = {
                  timestamp: new Date(),
                  balance: referrer.tokenBalance
                };
                referrer.tokenHistory.push(referrerBalanceSnapshot);
    
                User.findOneAndUpdate(
                  { _id: transactionData.metadata.referrer_id },
                  { $inc: { "referralCount": 1 } },
                  { upsert: true },
                  function(err, user) {
                    if (err) throw err;
                  }
                );
                await referrer.save();
                await referralTransaction.save();
              }
            } catch (e) {
              console.log(e)
            }
            }

            //generate invoices only if it's not trial  and it was a company
            if(transactionData.metadata.trial === "false"){
              if(user.accountType === "company" && transactionData.metadata.asCompany === "true"){
                 //check if client is in infakt if not then create new one
                let infaktClientsResponse = await axios.get(`https://api.infakt.pl/v3/clients.json?q[email_eq]=${user.contactEmail}`, infaktConfig);
                let infaktClients = infaktClientsResponse.data;
                if (infaktClients.length > 0) {
                  infaktClientId = infaktClients[0].id;
                } else {
                  createInfaktClient = await axios.post('https://api.infakt.pl/v3/clients.json', {
                    client: {
                      "name": user.fullName,
                      "email": user.email,
                      "company_name": user.companyName,
                      "street": user.street,
                      "street_number": user.streetNumber,
                      "flat_number": user.apartmentNumber,
                      "city": user.city,
                      "country": "Polska",
                      "postal_code": user.postalCode,
                      "nip": user.nip,
                      "mailing_company_mail": user.contactEmail
                    }
                  }, infaktConfig);
                  infaktClientId = createInfaktClient.data.id;
                }
                invoiceData = { //for companies
                  invoice: {
                    "client_company_name": user.companyName, 
                    "invoice_date": `${year}-${month}-${day}`,
                    "sale_date": `${year}-${month}-${day}`,
                    "status": "paid",
                    "paid_date": `${year}-${month}-${day}`,
                    "payment_method": "card",
                    "client_id": infaktClientId,
                    "paid_price": plan.price * 100, 
                    "services":[
                      {
                        "name": `Miesi??czna Subskrypcja Oprogramowania Aplikacji AsystentAI (Pakiet ${plan.name})`, 
                         "pkwiu": "62.01", 
                         "tax_symbol": 23,
                         "gross_price": plan.price * 100, 
                      }
                    ]
                  },
                };
              }
            }
            } catch (err) {
              console.log(err)
            }

          } else { //one-time purchase
            const tokensToAdd = parseInt(transactionData.metadata.tokens_to_add);
            user.tokenBalance += tokensToAdd;

            // Create a new purchase
            purchase = new Payment({
              price: transactionData.amount_total / 100,
              tokens: tokensToAdd,
              title: `Do??adowanie ${tokensToAdd} token??w`,
              type: "one-time",
              timestamp: new Date()
            });
            user.purchases.push(purchase);

            // Create a new transaction
            transaction = new Transaction({
                value: tokensToAdd,
                title: `Do??adowanie ${tokensToAdd} token??w`,
                type: 'income',
                timestamp: Date.now()
            });
            user.transactions.push(transaction);

          //generate infakt invoice object
          if(user.accountType === "company" && transactionData.metadata.asCompany === "true"){
            //check if client is in infakt if not then create new one
            let infaktClientsResponse = await axios.get(`https://api.infakt.pl/v3/clients.json?q[email_eq]=${user.contactEmail}`, infaktConfig);
            let infaktClients = infaktClientsResponse.data;
            if (infaktClients.length > 0) {
              infaktClientId = infaktClients[0].id;
            } else {
              createInfaktClient = await axios.post('https://api.infakt.pl/v3/clients.json', {
                client: {
                  "name": user.fullName,
                  "email": user.email,
                  "company_name": user.companyName,
                  "street": user.street,
                  "street_number": user.streetNumber,
                  "flat_number": user.apartmentNumber,
                  "city": user.city,
                  "country": "Polska",
                  "postal_code": user.postalCode,
                  "nip": user.nip,
                  "mailing_company_mail": user.contactEmail
                }
              }, infaktConfig);
               infaktClientId = createInfaktClient.data.id;
            }            
            invoiceData = {
              invoice: {
                "client_company_name": user.companyName, 
                "invoice_date": `${year}-${month}-${day}`,
                "sale_date": `${year}-${month}-${day}`,
                "status": "paid",
                "paid_date": `${year}-${month}-${day}`,
                "payment_method": "card",
                "client_id": infaktClientId,
                "paid_price": transactionData.amount_total, 
                "services":[
                  {
                     "name": `Jednorazowe do??adowanie miesi??cznej Subskrypcji - "Elixir ${tokensToAdd}ml`, 
                     "pkwiu": "62.01", 
                     "tax_symbol": 23,
                     "gross_price": transactionData.amount_total, 
                  }
                ]
              },
            };
          }

          }

          // Create a new balance snapshot and add it to the user's tokenHistory
          const balanceSnapshot = {
              timestamp: Date.now(),
              balance: user.tokenBalance
          };
          user.tokenHistory.push(balanceSnapshot);

          // Save the user and send invoice
          try {
            await user.save();
            await transaction.save();
            await purchase.save();
            if (transactionData.metadata.trial === "false" && user.accountType === "company" && transactionData.metadata.asCompany === "true") {
              await axios.post('https://api.infakt.pl/v3/invoices.json', invoiceData, infaktConfig);
              await new Promise(resolve => setTimeout(resolve, 2500));
              const latestInvoice = await axios.get('https://api.infakt.pl/v3/invoices.json?limit=1', infaktConfig);
              const lastInvoiceID = latestInvoice.data.entities[0].id;
              await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/paid.json`, {invoice: {"status": "paid"}}, infaktConfig);
              await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/deliver_via_email.json`, {"print_type": "original"}, infaktConfig);
            }
          } catch (error) {
            console.error(`Error: ${JSON.stringify(error.response.data)}`);
          }
        }
      });
    } catch (e) {
      return response.status(400).send(`Webhook Error: ${e.message}`);
    }
  }

  response.status(200).send('Webhook received');
});


//listening for subscription renewals
router.post('/subscription-checkout-webhook', bodyParser.raw({type: 'application/json'}), async (request, response) => {
  const payload = request.rawBody;
  const sig = request.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, subscriptionEndpointSecret);
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }
  const transactionData = event.data.object;

  if (event.type === 'invoice.paid' && event.data.object.billing_reason === 'subscription_cycle') {
    try {

    User.findOne({ email: transactionData.customer_details.email }, async (err, user) => {
      if(user) {
        
        let transaction;
        let invoiceData;
        let infaktClientId;

        try {
          const planId = transactionData.metadata.plan_id;
          const plan = await Plan.findById(planId);

          user.tokenBalance += plan.monthlyTokens;
  
          // Create a new transaction
          transaction = new Transaction({
              value: plan.monthlyTokens,
              title: `Miesi??czne do??adowanie ${plan.monthlyTokens} token??w`,
              type: 'income',
              timestamp: Date.now()
          });
          user.transactions.push(transaction);


          if(user.accountType === "company"){
             //generate infakt invoice for first subscription payment
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
          
            let infaktClientsResponse = await axios.get(`https://api.infakt.pl/v3/clients.json?q[email_eq]=${user.contactEmail}`, infaktConfig);
            let infaktClients = infaktClientsResponse.data;
            if (infaktClients.length > 0) {
              infaktClientId = infaktClients[0].id;
            }
            invoiceData = { //for companies
              invoice: {
                "client_company_name": user.companyName, 
                "invoice_date": `${year}-${month}-${day}`,
                "sale_date": `${year}-${month}-${day}`,
                "status": "paid",
                "paid_date": `${year}-${month}-${day}`,
                "payment_method": "card",
                "client_id": infaktClientId,
                "paid_price": plan.price * 100, 
                "services":[
                  {
                     "name": `Miesi??czna Subskrypcja Oprogramowania Aplikacji AsystentAI (Pakiet ${plan.name})`, 
                     "pkwiu": "62.01", 
                     "tax_symbol": 23,
                     "gross_price": plan.price * 100, 
                  }
                ]
              },
            };
          }

        } catch (error) {
          console.error(`Error saving user: ${error.message}`);
        }

        // Create a new balance snapshot and add it to the user's tokenHistory
        const balanceSnapshot = {
            timestamp: Date.now(),
            balance: user.tokenBalance
        };
        user.tokenHistory.push(balanceSnapshot);

        // Save the user
        try {
          if (user.accountType === "company"){
            await axios.post('https://api.infakt.pl/v3/invoices.json', invoiceData, infaktConfig);
            await new Promise(resolve => setTimeout(resolve, 2500));
            const latestInvoice = await axios.get('https://api.infakt.pl/v3/invoices.json?limit=1', infaktConfig);
            const lastInvoiceID = latestInvoice.data.entities[0].id;
            await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/paid.json`, {invoice: {"status": "paid"}}, infaktConfig);
            await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/deliver_via_email.json`, {"print_type": "original"}, infaktConfig);
          }
          await user.save();
          await transaction.save();
        } catch (error) {
          console.error(`Error saving user: ${error.message}`);
        }
      }
    });
    } catch (e) {
      return response.status(400).send(`Webhook Error: ${e.message}`);
    }
  } 

  response.status(200).send('Webhook received');
});


router.post('/cancel-subscription', requireAuth, async (req, res) => {
  const user = req.user;
  try {
    const customer = await stripe.customers.list({ email: user.email });
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.data[0].id,
    });
    const currentSubscriptionID = subscriptions.data[0].id;
    const deleted = await stripe.subscriptions.del(
      currentSubscriptionID
    );
    await User.updateOne({ _id: user._id }, { plan: null });

    res.status(200).json({ message: "Subscription cancelled", deletedSubscription: deleted });
  } catch (e) {
  res.status(500).json({message: "Error cancelling subscripiton", error: e})
  }
});


router.post('/update-subscription', requireAuth, async (req, res) => {
  const user = req.user;
  const { priceId, planId } = req.body;

  try {
    const customer = await stripe.customers.list({ email: user.email });
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.data[0].id,
    });

    if(subscriptions.data.length > 0){
      await stripe.subscriptions.del( //delete previous subscription
        subscriptions.data[0].id
      );
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); //wait for stripe
    
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customer.data[0].id,
      type: 'card',
    });

    const subscription = await stripe.subscriptions.create({ //subscribe to new price
      customer: customer.data[0].id,
      default_payment_method: paymentMethods.data[0].id, // use the first card in the list
      items: [
        {price: `${priceId}`},
      ],
    });

    const plan = await Plan.findById(planId);
    user.plan = plan;
    user.tokenBalance += plan.monthlyTokens;

    const purchase = new Payment({
        price: plan.price,
        tokens: plan.monthlyTokens,
        title: `Aktywacja subskrypcji ${plan.name}`,
        type: "one-time",
        timestamp: new Date()
    });
    user.purchases.push(purchase);

    const transaction = new Transaction({
        value: plan.monthlyTokens,
        title: `Aktywacja subskrypcji ${plan.name}`,
        type: 'income',
        timestamp: Date.now()
    });
    user.transactions.push(transaction);


    if(user.accountType === "company"){
      let invoiceData;
      const today = new Date();
      const year = today.getFullYear();
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const day = String(today.getDate()).padStart(2, '0');
      let infaktClientId;
      //check if client is in infakt if not then create new one
      let infaktClientsResponse = await axios.get(`https://api.infakt.pl/v3/clients.json?q[email_eq]=${user.contactEmail}`, infaktConfig);
      let infaktClients = infaktClientsResponse.data;
      if (infaktClients.length > 0) {
        infaktClientId = infaktClients[0].id;
      }
      invoiceData = { //for companies
        invoice: {
          "client_company_name": user.companyName, 
          "invoice_date": `${year}-${month}-${day}`,
          "sale_date": `${year}-${month}-${day}`,
          "payment_method": "card",
          "status": "paid",
          "paid_date": `${year}-${month}-${day}`,
          "client_id": infaktClientId,
          "paid_price": plan.price * 100, 
          "services":[
            {
               "name": `Miesi??czna Subskrypcja Oprogramowania Aplikacji AsystentAI (Pakiet ${plan.name})`, 
               "pkwiu": "62.01", 
               "tax_symbol": 23,
               "gross_price": plan.price * 100, 
            }
          ]
        },
      };
    }

    const balanceSnapshot = {
      timestamp: Date.now(),
      balance: user.tokenBalance
    };
    user.tokenHistory.push(balanceSnapshot);

    try {
      if(user.accountType === "company"){
        await axios.post('https://api.infakt.pl/v3/invoices.json', invoiceData, infaktConfig);
        await new Promise(resolve => setTimeout(resolve, 2500));
        const latestInvoice = await axios.get('https://api.infakt.pl/v3/invoices.json?limit=1', infaktConfig);
        const lastInvoiceID = latestInvoice.data.entities[0].id;
        await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/paid.json`, {invoice: {"status": "paid"}}, infaktConfig);
        await axios.post(`https://api.infakt.pl/v3/invoices/${lastInvoiceID}/deliver_via_email.json`, {"print_type": "original"}, infaktConfig);
      }
      await user.save();
      await transaction.save();
      await purchase.save();
    } catch (error) {
      console.error(`Error: ${JSON.stringify(error.response.data)}`);
    }

    res.status(200).json({ message: "Subscription updated", subscription });
} catch (e) {
  res.status(500).json({message: "Error updating subscripiton", error: e})
}
});


module.exports = router;   