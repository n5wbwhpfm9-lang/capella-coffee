// Capella Pages Functions API. Requires D1 binding DB, ACCESS_TEAM_DOMAIN,
// ACCESS_AUD, and ADMIN_EMAILS (comma-separated). All endpoints require a
// verified Cloudflare Access JWT, including requests to *.pages.dev.
const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
const allowedStatuses=["pending","roasted","packed","shipped","picked_up"];
const paymentStatuses=["awaiting_payment","paid","cancelled","refunded"];
function nextFriday(date=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date).map(x=>[x.type,x.value]));
 const d=new Date(Date.UTC(+p.year,+p.month-1,+p.day));let n=(5-d.getUTCDay()+7)%7;
 if(n===0&&(+p.hour>=15))n=7;
 d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);
}
// Dashboard production window changes on Sunday at midnight Pacific,
// independent of the Friday 10 AM customer ordering cutoff.
function productionFriday(date=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"}).formatToParts(date).map(x=>[x.type,x.value]));
 const d=new Date(Date.UTC(+p.year,+p.month-1,+p.day));
 const offset=(5-d.getUTCDay()+7)%7;
 d.setUTCDate(d.getUTCDate()+offset);
 return d.toISOString().slice(0,10);
}
function b64(s){return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0))}
async function verify(request,env){
 const reject=reason=>({ok:false,reason});
 const token=request.headers.get("Cf-Access-Jwt-Assertion");
 if(!token)return reject("missing_access_assertion");
 if(!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD||!env.ADMIN_EMAILS)return reject("missing_server_configuration");
 const chunks=token.split(".");if(chunks.length!==3)return reject("invalid_token_format");
 try{
  const header=JSON.parse(new TextDecoder().decode(b64(chunks[0])));
  const body=JSON.parse(new TextDecoder().decode(b64(chunks[1])));
  const domain=env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,"").replace(/\/$/,"");
  if(header.alg!=="RS256"||!header.kid)return reject("unsupported_token_signature");
  if(body.iss!=="https://"+domain)return reject("issuer_mismatch");
  if(![].concat(body.aud||[]).includes(env.ACCESS_AUD.trim()))return reject("audience_mismatch");
  if(!body.exp||body.exp<=Date.now()/1000||(body.nbf&&body.nbf>Date.now()/1000))return reject("token_expired_or_not_yet_valid");
  if(!env.ADMIN_EMAILS.split(",").map(x=>x.trim().toLowerCase()).includes(String(body.email||"").toLowerCase()))return reject("email_not_authorized");
  const response=await fetch("https://"+domain+"/cdn-cgi/access/certs");
  if(!response.ok)return reject("certificates_unavailable");
  const jwks=await response.json();const jwk=jwks.keys.find(x=>x.kid===header.kid);
  if(!jwk)return reject("signing_key_not_found");
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  return (await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,b64(chunks[2]),new TextEncoder().encode(chunks[0]+"."+chunks[1])))?{ok:true}:reject("invalid_signature");
 }catch(e){console.error("Access verification failed",e);return reject("verification_exception")}
}
const fail=(msg,s=400)=>reply({error:msg},s);
async function ensureRecurring(db){
 const now=productionFriday();const until=new Date(now+"T12:00:00Z");until.setUTCDate(until.getUTCDate()+70);const limit=until.toISOString().slice(0,10);
 const {results:plans}=await db.prepare("SELECT * FROM recurring_custom_orders WHERE active=1 AND start_friday<=?").bind(limit).all();
 for(const p of plans){
  let day=new Date(p.start_friday+"T12:00:00Z");
  for(let i=0;i<12&&day.toISOString().slice(0,10)<=limit;i++){
   const friday=day.toISOString().slice(0,10);
   if(friday>=now){
    const id="rec_"+p.id+"_"+friday;
    const existing=await db.prepare("SELECT id FROM orders WHERE id=?").bind(id).first();
    if(!existing){
     await db.batch([
      db.prepare("INSERT OR IGNORE INTO orders(id,source,customer_name,customer_email,status,delivery_method,notes,roast_window_date,amount_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,"manual",p.customer_name,p.customer_email,"awaiting_payment",p.delivery_method,"Recurring custom order · "+p.payment_method+(p.notes?" · "+p.notes:""),friday,p.quantity*p.unit_price_cents),
      db.prepare("INSERT INTO order_items(order_id,bag_size_oz,quantity,unit_price_cents) VALUES (?,?,?,?)").bind(id,p.bag_size_oz,p.quantity,p.unit_price_cents)
     ]);
    }
   }
   day.setUTCDate(day.getUTCDate()+(p.interval_weeks*7));
  }
 }
}

// Test email preview uses the same HTML markup as the checkout Worker template.
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function sendTestEmail(env,recipient){
 if(!env.RESEND_API_KEY)return fail("Add RESEND_API_KEY to capella-admin Pages secrets first",503);
 const order=await env.DB.prepare("SELECT * FROM orders WHERE source='stripe' AND status='paid' ORDER BY created_at DESC LIMIT 1").first();
 if(!order)return fail("No paid Stripe order available for email preview",404);
 const {results:items}=await env.DB.prepare("SELECT bag_size_oz,quantity,unit_price_cents FROM order_items WHERE order_id=?").bind(order.id).all();
 if(!items.length)return fail("Sample order has no items",422);
 const pickup=order.delivery_method==="pickup";
 const greeting=order.customer_name?"Hi "+escapeHtml(order.customer_name.split(" ")[0])+",":"Hello,";
 const fulfillment=pickup?"We'll email you when your coffee is ready for pickup in Yakima.":"We'll email you when your coffee has shipped.";
 const orderRows=items.map(i=>'<tr><td style="padding:12px 0;font:16px Georgia,serif;color:#382318">'+escapeHtml(i.quantity+' × Ethiopia Yirgacheffe · '+(i.bag_size_oz===16?'1 lb':'½ lb'))+'</td></tr>').join('');
 const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f1ec;padding:20px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#fffdfb;border-radius:16px"><tr><td align="center" style="padding:32px 28px 12px"><img src="https://copacapella.com/assets/capella-email-logo.png" alt="Capella Coffee Roasters" width="220" style="display:block;max-width:85%;height:auto;color:#b76b50;font:26px Georgia,serif"><div style="border-bottom:1px solid #d9a28f;margin-top:25px"></div></td></tr><tr><td style="padding:18px 32px 28px;font-family:Georgia,serif;color:#382318"><h1 style="text-align:center;font-size:30px;font-weight:normal;line-height:1.2">Your coffee order is confirmed!</h1><p style="font-size:16px;line-height:1.6">${greeting}</p><p style="font-size:16px;line-height:1.6">Thanks for ordering Capella Coffee. We're excited to roast something good for you.</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f2ed;border-radius:12px"><tr><td style="padding:20px 22px"><h2 style="font-size:22px;font-weight:normal;margin:0 0 12px">Your order</h2><table role="presentation" width="100%">${orderRows}<tr><td style="border-top:1px solid #ddc9bd;padding-top:12px"><strong>Amount paid: ${order.amount_total_cents==null?'':('$'+(order.amount_total_cents/100).toFixed(2))}</strong></td></tr></table><p style="font-size:15px"><strong>Delivery:</strong> ${pickup?'Free Yakima pickup':'USPS Priority Mail'}</p></td></tr></table><h2 style="font-size:22px;font-weight:normal;margin:26px 0 8px">Our roasting schedule</h2><p style="font-size:16px;line-height:1.6">We roast fresh coffee in small batches each Friday and Saturday. Orders placed before Friday at 10:00 AM Pacific are scheduled for that week's roasting window. Orders placed at or after the cutoff are scheduled for the following week.</p><p style="font-size:16px;line-height:1.6">${fulfillment}</p><p style="font-size:16px;line-height:1.6">Thanks for supporting our little Yakima roastery!</p><p style="text-align:center;font-size:16px;font-style:italic;margin-top:28px">Questions? Just reply to this email.</p><p style="text-align:center;font:13px Arial,sans-serif;color:#8b6c5c;line-height:1.7">Capella Coffee · Freshly roasted. Yakima born.<br><a href="mailto:hello@copacapella.com" style="color:#aa6049">hello@copacapella.com</a></p></td></tr><tr><td><img src="https://copacapella.com/assets/coffee-cherries-email.png" alt="Coffee cherries" width="580" style="display:block;width:100%;height:auto;opacity:.35;filter:grayscale(1)"></td></tr></table></td></tr></table></body></html>`;
 const response=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:"Capella Coffee <orders@copacapella.com>",to:[recipient],reply_to:"hello@copacapella.com",subject:"[TEST] Your Capella Coffee order is confirmed!",html})});
 const result=await response.json().catch(()=>({}));
 if(!response.ok){console.error("Capella test email failed",response.status,result.message);return fail("Test email send failed ("+response.status+")",502)}
 return reply({ok:true,message:"Test email sent to "+recipient});
}
async function handle(request,env,path){
 const db=env.DB;if(!db)return fail("Database binding DB is missing",503);
 if(request.method==="POST"&&path==="test-email"){
  const x=await request.json().catch(()=>({}));
  const recipient=String(x.email||"").trim().toLowerCase();
  const allowed=env.ADMIN_EMAILS?.split(",").map(x=>x.trim().toLowerCase())||[];
  if(!allowed.includes(recipient))return fail("Test emails may only be sent to authorized admins",403);
  return sendTestEmail(env,recipient);
 }

 if(request.method==="GET"&&path==="finances"){
  const month=new URL(request.url).searchParams.get("month")||new Intl.DateTimeFormat("en-CA",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit"}).format(new Date()).slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))return fail("Invalid month");
  const from=month+"-01",to=new Date(Date.UTC(+month.slice(0,4),+month.slice(5),1)).toISOString().slice(0,10);
  const revenue=await db.prepare("SELECT COUNT(*) AS order_count,COALESCE(SUM(amount_total_cents),0) AS gross_cents FROM orders WHERE status='paid' AND substr(created_at,1,10)>=? AND substr(created_at,1,10)<?").bind(from,to).first();
  let expenses=[],expenseTotal=0,needsSetup=false;
  try{
   const x=await db.prepare("SELECT * FROM finance_expenses WHERE expense_date>=? AND expense_date<? ORDER BY expense_date DESC,created_at DESC LIMIT 500").bind(from,to).all();
   expenses=x.results;expenseTotal=expenses.reduce((n,e)=>n+e.amount_cents,0);
  }catch(e){if(String(e).includes("no such table"))needsSetup=true;else throw e}
  return reply({month,needsSetup,revenue:{gross_cents:revenue.gross_cents,order_count:revenue.order_count},expenses,expense_total_cents:expenseTotal,unadjusted_margin_cents:revenue.gross_cents-expenseTotal,notes:"Gross paid order amounts may include shipping and sales tax. Stripe fees and inventory costs are included only if entered as expenses. This is not accounting net income or a tax calculation."});
 }
 if(request.method==="POST"&&path==="finances/expenses"){
  const x=await request.json().catch(()=>({})),amount=Number(x.amount_cents);
  const categories=["green_beans","packaging","shipping","processing_fees","equipment","supplies","marketing","other"];
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x.expense_date||"")||!categories.includes(x.category)||!Number.isSafeInteger(amount)||amount<=0||amount>100000000)return fail("Invalid expense");
  const id=crypto.randomUUID();
  try{await db.prepare("INSERT INTO finance_expenses(id,expense_date,category,vendor,description,amount_cents) VALUES (?,?,?,?,?,?)").bind(id,x.expense_date,x.category,String(x.vendor||"").slice(0,150),String(x.description||"").slice(0,500),amount).run()}
  catch(e){if(String(e).includes("no such table"))return fail("Run database/finance-migration.sql in D1 first",503);throw e}
  return reply({id},201);
 }
 if(request.method==="GET"&&path==="dashboard"){
  await ensureRecurring(db);
  const window=new URL(request.url).searchParams.get("window")||productionFriday();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(window))return fail("Invalid date");
  const {results:orders}=await db.prepare(`SELECT o.*,COALESCE(SUM(CASE WHEN i.bag_size_oz=16 THEN i.quantity ELSE 0 END),0) AS one_pound_bags,COALESCE(SUM(CASE WHEN i.bag_size_oz=8 THEN i.quantity ELSE 0 END),0) AS half_pound_bags FROM orders o LEFT JOIN order_items i ON i.order_id=o.id WHERE (o.roast_window_date=? OR (o.roast_window_date<? AND o.fulfillment_status NOT IN ('shipped','picked_up') AND o.status NOT IN ('cancelled','refunded'))) GROUP BY o.id ORDER BY o.roast_window_date ASC,o.created_at DESC`).bind(window,window).all();
  const currentOrders=orders.filter(o=>o.roast_window_date===window&&o.fulfillment_status!=="shipped"&&o.fulfillment_status!=="picked_up"&&o.status!=="cancelled"&&o.status!=="refunded");
  const outstanding=orders.filter(o=>o.roast_window_date<window);
  const pending=currentOrders.filter(o=>o.roast_window_date===window&&o.fulfillment_status!=="shipped"&&o.fulfillment_status!=="picked_up"&&o.status!=="cancelled"&&o.status!=="refunded"&&(o.status==="paid"||o.source==="manual"));
  const one=pending.reduce((n,o)=>n+o.one_pound_bags,0),half=pending.reduce((n,o)=>n+o.half_pound_bags,0);
  const {results:plans}=await db.prepare("SELECT * FROM recurring_custom_orders ORDER BY active DESC,customer_name").all();
  return reply({window,summary:{one_pound_bags:one,half_pound_bags:half,total_bags:one+half,total_roasted_pounds:one+half/2},orders:currentOrders,outstanding,plans});
 }
 if(request.method==="POST"&&path==="orders"){
  const x=await request.json();
  const quantity=Number(x.quantity),oz=Number(x.bag_size_oz),price=Number(x.unit_price_cents);
  if(!x.customer_name||!["shipping","pickup"].includes(x.delivery_method)||![8,16].includes(oz)||!Number.isInteger(quantity)||quantity<1||quantity>1000||!Number.isInteger(price)||price<0||!paymentStatuses.includes(x.payment_status))return fail("Invalid order");
  const friday=x.roast_window_date||nextFriday();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(friday))return fail("Invalid roast date");
  const id="manual_"+crypto.randomUUID();
  await db.batch([
   db.prepare("INSERT INTO orders(id,source,customer_name,customer_email,status,delivery_method,special_request,notes,roast_window_date,amount_total_cents) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,"manual",String(x.customer_name).slice(0,150),String(x.customer_email||"").slice(0,254),x.payment_status,x.delivery_method,String(x.special_request||"").slice(0,500),String(x.notes||"").slice(0,500),friday,price*quantity),
   db.prepare("INSERT INTO order_items(order_id,bag_size_oz,quantity,unit_price_cents) VALUES (?,?,?,?)").bind(id,oz,quantity,price)
  ]);
  return reply({id},201);
 }
 if(request.method==="POST"&&path==="recurring"){
  const x=await request.json();const quantity=Number(x.quantity),oz=Number(x.bag_size_oz),price=Number(x.unit_price_cents),weeks=Number(x.interval_weeks);
  if(!x.customer_name||!["shipping","pickup"].includes(x.delivery_method)||![8,16].includes(oz)||![1,2,4].includes(weeks)||!Number.isInteger(quantity)||quantity<1||quantity>1000||!Number.isInteger(price)||price<0||!["venmo","cash","check","stripe","other"].includes(x.payment_method)||!["paid","awaiting_payment"].includes(x.payment_status)||!/^\d{4}-\d{2}-\d{2}$/.test(x.start_friday))return fail("Invalid recurring order");
  if(new Date(x.start_friday+"T12:00:00Z").getUTCDay()!==5)return fail("Start date must be a Friday");
  const id=crypto.randomUUID();
  await db.prepare("INSERT INTO recurring_custom_orders(id,customer_name,customer_email,bag_size_oz,quantity,interval_weeks,start_friday,delivery_method,payment_method,payment_status,unit_price_cents,notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,String(x.customer_name).slice(0,150),String(x.customer_email||"").slice(0,254),oz,quantity,weeks,x.start_friday,x.delivery_method,x.payment_method,x.payment_status,price,String(x.notes||"").slice(0,500)).run();
  return reply({id},201);
 }
 if(request.method==="PATCH"&&path.startsWith("orders/")){
  const id=decodeURIComponent(path.slice(7));const x=await request.json();
  if(x.fulfillment_status!==undefined){
   if(!allowedStatuses.includes(x.fulfillment_status))return fail("Invalid fulfillment status");
   await db.prepare("UPDATE orders SET fulfillment_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(x.fulfillment_status,id).run();
  }
  if(x.payment_status!==undefined){
   if(!paymentStatuses.includes(x.payment_status))return fail("Invalid payment status");
   const o=await db.prepare("SELECT source FROM orders WHERE id=?").bind(id).first();
   if(!o||o.source!=="manual")return fail("Only manual orders can have payment status edited");
   await db.prepare("UPDATE orders SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(x.payment_status,id).run();
  }
  return reply({ok:true});
 }
 if(request.method==="PATCH"&&path.startsWith("recurring/")){
  const id=decodeURIComponent(path.slice(10)),x=await request.json();
  if(typeof x.active!=="boolean")return fail("Invalid status");
  const plan=await db.prepare("SELECT id,active FROM recurring_custom_orders WHERE id=?").bind(id).first();
  if(!plan)return fail("Recurring order not found",404);
  if(!x.active){
   const now=productionFriday();
   await db.batch([
    db.prepare("UPDATE recurring_custom_orders SET active=0 WHERE id=?").bind(id),
    db.prepare("UPDATE orders SET status='cancelled',updated_at=CURRENT_TIMESTAMP WHERE id LIKE ? AND roast_window_date>=? AND status='awaiting_payment' AND fulfillment_status NOT IN ('shipped','picked_up') AND source='manual'").bind("rec_"+id+"_%",now)
   ]);
  }else{
   await db.prepare("UPDATE recurring_custom_orders SET active=1 WHERE id=?").bind(id).run();
  }
  return reply({ok:true});
 }
 return fail("Not found",404);
}
export async function onRequest(context){
 const {request,env}=context;
 const auth=await verify(request,env);
 if(!auth.ok)return fail("Unauthorized: "+auth.reason,401);
 try{return await handle(request,env,context.params.path?.join("/")||"")}
 catch(e){console.error("Capella admin API error",e);return fail("Unable to load or update orders",500)}
}
