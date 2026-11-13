// Capella Pages Functions API. Requires D1 binding DB, ACCESS_TEAM_DOMAIN,
// ACCESS_AUD, and ADMIN_EMAILS (comma-separated). All endpoints require a
// verified Cloudflare Access JWT, including requests to *.pages.dev.
const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"content-type":"application/json","cache-control":"no-store"}});
const allowedStatuses=["pending","roasted","packed","shipped","picked_up"];
const paymentStatuses=["awaiting_payment","paid","cancelled","refunded"];
function nextFriday(date=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date).map(x=>[x.type,x.value]));
 const d=new Date(Date.UTC(+p.year,+p.month-1,+p.day));let n=(5-d.getUTCDay()+7)%7;
 if(n===0&&(+p.hour>=10))n=7;
 d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);
}
function b64(s){return Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0))}
async function verify(request,env){
 const token=request.headers.get("Cf-Access-Jwt-Assertion");
 if(!token||!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD||!env.ADMIN_EMAILS)return false;
 const chunks=token.split(".");if(chunks.length!==3)return false;
 try{
  const header=JSON.parse(new TextDecoder().decode(b64(chunks[0])));
  const body=JSON.parse(new TextDecoder().decode(b64(chunks[1])));
  const domain=env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//,"").replace(/\/$/,"");
  if(header.alg!=="RS256"||!header.kid||body.iss!=="https://"+domain||!Array.isArray(body.aud)||!body.aud.includes(env.ACCESS_AUD)||body.exp<=Date.now()/1000||body.nbf>Date.now()/1000)return false;
  if(!env.ADMIN_EMAILS.split(",").map(x=>x.trim().toLowerCase()).includes(String(body.email||"").toLowerCase()))return false;
  const response=await fetch("https://"+domain+"/cdn-cgi/access/certs");
  if(!response.ok)return false;
  const jwks=await response.json();const jwk=jwks.keys.find(x=>x.kid===header.kid);
  if(!jwk)return false;
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,b64(chunks[2]),new TextEncoder().encode(chunks[0]+"."+chunks[1]));
 }catch(e){console.error("Access verification failed",e);return false}
}
const fail=(msg,s=400)=>reply({error:msg},s);
async function ensureRecurring(db){
 const now=nextFriday();const until=new Date(now+"T12:00:00Z");until.setUTCDate(until.getUTCDate()+70);const limit=until.toISOString().slice(0,10);
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
      db.prepare("INSERT OR IGNORE INTO orders(id,source,customer_name,customer_email,status,delivery_method,notes,roast_window_date,amount_total_cents) VALUES (?,?,?,?,?,?,?,?,?)").bind(id,"manual",p.customer_name,p.customer_email,p.payment_method==="stripe"?"awaiting_payment":p.payment_status,p.delivery_method,"Recurring custom order · "+p.payment_method+(p.notes?" · "+p.notes:""),friday,p.quantity*p.unit_price_cents),
      db.prepare("INSERT INTO order_items(order_id,bag_size_oz,quantity,unit_price_cents) VALUES (?,?,?,?)").bind(id,p.bag_size_oz,p.quantity,p.unit_price_cents)
     ]);
    }
   }
   day.setUTCDate(day.getUTCDate()+(p.interval_weeks*7));
  }
 }
}
async function handle(request,env,path){
 const db=env.DB;if(!db)return fail("Database binding DB is missing",503);
 if(request.method==="GET"&&path==="dashboard"){
  await ensureRecurring(db);
  const window=new URL(request.url).searchParams.get("window")||nextFriday();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(window))return fail("Invalid date");
  const {results:orders}=await db.prepare(`SELECT o.*,COALESCE(SUM(CASE WHEN i.bag_size_oz=16 THEN i.quantity ELSE 0 END),0) AS one_pound_bags,COALESCE(SUM(CASE WHEN i.bag_size_oz=8 THEN i.quantity ELSE 0 END),0) AS half_pound_bags FROM orders o LEFT JOIN order_items i ON i.order_id=o.id WHERE o.roast_window_date=? GROUP BY o.id ORDER BY o.created_at DESC`).bind(window).all();
  const pending=orders.filter(o=>o.fulfillment_status!=="shipped"&&o.fulfillment_status!=="picked_up"&&o.status!=="cancelled"&&o.status!=="refunded"&&(o.status==="paid"||o.source==="manual"));
  const one=pending.reduce((n,o)=>n+o.one_pound_bags,0),half=pending.reduce((n,o)=>n+o.half_pound_bags,0);
  const {results:plans}=await db.prepare("SELECT * FROM recurring_custom_orders ORDER BY active DESC,customer_name").all();
  return reply({window,summary:{one_pound_bags:one,half_pound_bags:half,total_bags:one+half,total_roasted_pounds:one+half/2},orders,plans});
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
  await db.prepare("UPDATE recurring_custom_orders SET active=? WHERE id=?").bind(x.active?1:0,id).run();
  return reply({ok:true});
 }
 return fail("Not found",404);
}
export async function onRequest(context){
 const {request,env}=context;
 if(!await verify(request,env))return fail("Unauthorized: verify Access settings and admin email",401);
 try{return await handle(request,env,context.params.path?.join("/")||"")}
 catch(e){console.error("Capella admin API error",e);return fail("Unable to load or update orders",500)}
}
