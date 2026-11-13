// Capella Coffee Stripe Checkout Worker
// Set STRIPE_SECRET_KEY as an encrypted Cloudflare Worker secret.
const SITE = "https://copacapella.com";
const SHOP = SITE + "/";
const PRICES = {
  "0.5": { once:"price_1Ub9RvDaBLaitTQvJzn0oJ5o",weekly:"price_1Ub9RvDaBLaitTQvbwSj5Jrg",biweekly:"price_1Ub9RuDaBLaitTQvtirxmCMZ",monthly:"price_1Ub9RuDaBLaitTQvKOmTfxKZ" },
  "1": { once:"price_1Ub9RvDaBLaitTQv6yXi4TMM",weekly:"price_1Ub9RvDaBLaitTQvKAOJKqjd",biweekly:"price_1Ub9RuDaBLaitTQvxveuHpu2",monthly:"price_1Ub9RvDaBLaitTQv3KPPCcmm" }
};
const SHIPPING_RATE = "shr_1Ub9svDaBLaitTQvjxVnZilj";
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":SITE,"Vary":"Origin","Cache-Control":"no-store"}});

const priceSizes = Object.fromEntries(Object.entries(PRICES).flatMap(([size, frequencies]) => Object.values(frequencies).map(id => [id, size === "1" ? 16 : 8])));
async function stripeGet(path, env) {
  const response = await fetch("https://api.stripe.com/v1/" + path, {headers: {Authorization:"Bearer " + env.STRIPE_SECRET_KEY}});
  if (!response.ok) throw Error("Stripe lookup failed (" + response.status + ")");
  return response.json();
}
function nextRoastFriday(unixSeconds) {
  // Friday 10:00 America/Los_Angeles cutoff, daylight-saving aware.
  const date = new Date(unixSeconds * 1000);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date).map(x=>[x.type,x.value]));
  const day = new Date(Date.UTC(+p.year, +p.month-1, +p.day));
  const weekday = day.getUTCDay();
  let offset = (5-weekday+7)%7;
  if (offset===0 && (+p.hour>10 || (+p.hour===10 && +p.minute>=0))) offset=7;
  day.setUTCDate(day.getUTCDate()+offset);
  return day.toISOString().slice(0,10);
}
async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts=Object.fromEntries(header.split(",").map(x=>x.trim().split("=")));
  const timestamp=Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now()/1000-timestamp)>300) return false;
  const signatures=header.split(",").filter(x=>x.trim().startsWith("v1=")).map(x=>x.trim().slice(3));
  if (!signatures.length) return false;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(parts.t+"."+payload));
  const hex=Array.from(new Uint8Array(signature),b=>b.toString(16).padStart(2,"0")).join("");
  return signatures.some(x=>x.length===hex.length && x.split("").reduce((diff,c,i)=>diff | (c.charCodeAt(0)^hex.charCodeAt(i)),0)===0);
}
async function savePaidOrder(env, event, details) {
  const {id, sessionId=null, paymentIntent=null, subscriptionId=null, name=null, email=null, delivery, address=null, request=null, items, total=null, created}=details;
  if (!items.length) throw Error("No coffee line items found for paid order");
  if (!["shipping","pickup"].includes(delivery)) throw Error("Unknown delivery method");
  const existing=await env.DB.prepare("SELECT event_id FROM stripe_events WHERE event_id=?").bind(event.id).first();
  if (existing) return;
  const priorOrder=await env.DB.prepare("SELECT id FROM orders WHERE id=?").bind(id).first();
  if (priorOrder) {
    await env.DB.prepare("INSERT OR IGNORE INTO stripe_events(event_id,event_type) VALUES (?,?)").bind(event.id,event.type).run();
    return;
  }
  const order=env.DB.prepare(`INSERT OR IGNORE INTO orders
    (id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_subscription_id,source,customer_name,customer_email,status,delivery_method,shipping_address_json,special_request,roast_window_date,amount_total_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,sessionId,paymentIntent,subscriptionId,"stripe",name,email,"paid",delivery,address?JSON.stringify(address):null,request,nextRoastFriday(created),total);
  const statements=[order,...items.map(item=>env.DB.prepare("INSERT INTO order_items (order_id,bag_size_oz,quantity,unit_price_cents,stripe_price_id) VALUES (?,?,?,?,?)").bind(id,item.oz,item.quantity,item.unitPrice,item.priceId)),env.DB.prepare("INSERT OR IGNORE INTO stripe_events(event_id,event_type) VALUES (?,?)").bind(event.id,event.type)];
  await env.DB.batch(statements);
}
async function processStripeEvent(event,env) {
  if (event.type==="checkout.session.completed" && event.data.object.mode==="payment") {
    const session=event.data.object;
    if (session.payment_status!=="paid") return;
    const lines=await stripeGet("checkout/sessions/"+encodeURIComponent(session.id)+"/line_items?limit=100",env);
    const items=lines.data.filter(x=>priceSizes[x.price?.id]).map(x=>({oz:priceSizes[x.price.id],quantity:x.quantity,unitPrice:x.price.unit_amount,priceId:x.price.id}));
    const request=session.custom_fields?.find(x=>x.key==="special_request")?.text?.value||null;
    await savePaidOrder(env,event,{id:"checkout_"+session.id,sessionId:session.id,paymentIntent:session.payment_intent, name:session.customer_details?.name,email:session.customer_details?.email,delivery:session.metadata?.delivery,address:session.collected_information?.shipping_details?.address||session.shipping_details?.address,request,items,total:session.amount_total,created:session.created});
  }
  if (event.type==="invoice.paid") {
    const invoice=event.data.object;
    // Stripe sends an invoice.paid event for both initial and renewal subscription invoices.
    const subscriptionId=typeof invoice.subscription==="string"?invoice.subscription:invoice.parent?.subscription_details?.subscription;
    if (!subscriptionId) return;
    const subscription=await stripeGet("subscriptions/"+encodeURIComponent(subscriptionId),env);
    const delivery=subscription.metadata?.delivery;
    const invoiceLines=await stripeGet("invoices/"+encodeURIComponent(invoice.id)+"/lines?limit=100",env);
    const items=invoiceLines.data.map(line=>{
      const id=line.price?.id||line.pricing?.price_details?.price;
      return priceSizes[id]?{oz:priceSizes[id],quantity:line.quantity||1,unitPrice:line.price?.unit_amount||null,priceId:id}:null;
    }).filter(Boolean);
    const customer=await stripeGet("customers/"+encodeURIComponent(invoice.customer),env);
    await savePaidOrder(env,event,{id:"invoice_"+invoice.id,subscriptionId,paymentIntent:typeof invoice.payment_intent==="string"?invoice.payment_intent:null,name:customer.name,email:invoice.customer_email||customer.email,delivery,address:customer.shipping?.address||null,request:subscription.metadata?.special_request||null,items,total:invoice.amount_paid,created:invoice.created});
  }
}

export default {
 async fetch(request,env){
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":SITE,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600","Vary":"Origin"}});
  const url=new URL(request.url);
  if(url.pathname==="/stripe-webhook" && request.method==="POST") {
    if(!env.DB || !env.STRIPE_WEBHOOK_SECRET) return new Response("Webhook not configured",{status:503});
    const raw=await request.text();
    if(!await verifyStripeSignature(raw,request.headers.get("Stripe-Signature"),env.STRIPE_WEBHOOK_SECRET)) return new Response("Invalid signature",{status:400});
    try {await processStripeEvent(JSON.parse(raw),env);return new Response("ok",{status:200})}
    catch(e){console.error("Stripe webhook processing failed",e);return new Response("Processing failed",{status:500})}
  }
  if(url.pathname!=="/checkout"||request.method!=="POST") return json({error:"Not found"},404);
  if(request.headers.get("Origin")!==SITE) return json({error:"Origin not allowed"},403);
  if(!env.STRIPE_SECRET_KEY) return json({error:"Checkout is not configured"},503);
  let input;
  try{input=await request.json()}catch{return json({error:"Invalid request"},400)}
  const size=String(input.size),frequency=String(input.frequency),delivery=String(input.delivery);
  const price=PRICES[size]?.[frequency];
  if(!price||!["shipping","pickup"].includes(delivery))return json({error:"Invalid purchase selection"},400);
  const subscription=frequency!=="once";
  const params=new URLSearchParams();
  params.set("mode",subscription?"subscription":"payment");
  params.set("line_items[0][price]",price);
  params.set("line_items[0][quantity]","1");
  params.set("success_url",SHOP+"?checkout=success");
  params.set("cancel_url",SHOP+"?checkout=cancelled");
  params.set("allow_promotion_codes","true");
  params.set("custom_fields[0][key]","special_request");
  params.set("custom_fields[0][label][type]","custom");
  params.set("custom_fields[0][label][custom]","Special requests (optional)");
  params.set("custom_fields[0][type]","text");
  params.set("custom_fields[0][optional]","true");
  params.set("custom_fields[0][text][maximum_length]","255");
  params.set("billing_address_collection","auto");
  if(!subscription) params.set("customer_creation","always");
  params.set("metadata[delivery]",delivery);
  params.set("metadata[bag_size]",size);
  params.set("metadata[frequency]",frequency);
  if(subscription){
    params.set("subscription_data[metadata][delivery]",delivery);
    params.set("subscription_data[metadata][bag_size]",size);
    params.set("subscription_data[metadata][frequency]",frequency);
  }
  if(delivery==="shipping"){
    params.set("shipping_address_collection[allowed_countries][0]","US");
    if(subscription){
      // Recurring line item: $10 is charged again on every subscription invoice.
      params.set("line_items[1][price_data][currency]","usd");
      params.set("line_items[1][price_data][unit_amount]","1000");
      params.set("line_items[1][price_data][product_data][name]","USPS Priority Mail shipping");
      params.set("line_items[1][price_data][recurring][interval]",frequency==="monthly"?"month":"week");
      params.set("line_items[1][price_data][recurring][interval_count]",frequency==="biweekly"?"2":"1");
      params.set("line_items[1][quantity]","1");
    } else {
      params.set("shipping_options[0][shipping_rate]",SHIPPING_RATE);
    }
  }
  try{
    const response=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{"Authorization":"Bearer "+env.STRIPE_SECRET_KEY,"Content-Type":"application/x-www-form-urlencoded"},body:params});
    const result=await response.json();
    if(!response.ok){console.error("Stripe Checkout error",result.error?.message);return json({error:"Could not start checkout. Please try again."},502)}
    return json({url:result.url});
  }catch(e){console.error(e);return json({error:"Checkout temporarily unavailable"},502)}
 }
};
