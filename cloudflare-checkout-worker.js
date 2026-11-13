// Capella Coffee Stripe Checkout Worker
// Set STRIPE_SECRET_KEY as an encrypted Cloudflare Worker secret.
const SITE = "https://n5wbwhpfm9-lang.github.io";
const SHOP = SITE + "/capella-coffee/";
const PRICES = {
  "0.5": { once:"price_1Ub9RvDaBLaitTQvJzn0oJ5o",weekly:"price_1Ub9RvDaBLaitTQvbwSj5Jrg",biweekly:"price_1Ub9RuDaBLaitTQvtirxmCMZ",monthly:"price_1Ub9RuDaBLaitTQvKOmTfxKZ" },
  "1": { once:"price_1Ub9RvDaBLaitTQv6yXi4TMM",weekly:"price_1Ub9RvDaBLaitTQvKAOJKqjd",biweekly:"price_1Ub9RuDaBLaitTQvxveuHpu2",monthly:"price_1Ub9RvDaBLaitTQv3KPPCcmm" }
};
const SHIPPING_RATE = "shr_1Ub9svDaBLaitTQvjxVnZilj";
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json","Access-Control-Allow-Origin":SITE,"Vary":"Origin","Cache-Control":"no-store"}});
export default {
 async fetch(request,env){
  if(request.method==="OPTIONS") return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":SITE,"Access-Control-Allow-Methods":"POST, OPTIONS","Access-Control-Allow-Headers":"Content-Type","Access-Control-Max-Age":"600","Vary":"Origin"}});
  const url=new URL(request.url);
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
