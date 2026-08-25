const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

const ENDPOINTS = [
  ...(HELIUS_RPC ? [HELIUS_RPC] : []),
  "https://api.mainnet.solana.com",
  "https://api.mainnet-beta.solana.com"
];

const DEFAULT_TIMEOUT = 30000;
const MINT_DEFAULT = "8nd8CarQtxpN6UBmpBoc6hzHExnzMDm7d7HJSbFKpump";
const DAY = 86400;
const HISTORY_PAGE_LIMIT = 100;
const MAX_HISTORY_PAGES = 20;

async function rpcCall(endpoint,payload){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),DEFAULT_TIMEOUT);
  try{
    const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(payload),signal:controller.signal,cache:"no-store"});
    const text=await response.text();let data;
    try{data=JSON.parse(text)}catch{throw new Error(`${endpoint}: invalid JSON (HTTP ${response.status})`)}
    if(!response.ok)throw new Error(`${endpoint}: HTTP ${response.status} — ${data?.error?.message||data?.message||text.slice(0,160)}`);
    if(data?.error)throw new Error(`${endpoint}: RPC ${data.error.code||""} — ${data.error.message||"RPC error"}`);
    return data;
  }finally{clearTimeout(timer)}
}
async function helius(payload){if(!HELIUS_RPC)throw new Error("HELIUS_API_KEY is not configured in Vercel");return (await rpcCall(HELIUS_RPC,payload)).result}
async function firstSuccessful(payload){
  const errors=[];
  for(const endpoint of ENDPOINTS){try{return await rpcCall(endpoint,payload)}catch(e){errors.push(e?.message||String(e))}}
  throw new Error(errors.join(" | "))
}

async function getAuraRanking(mint,config={commitment:"confirmed"}){
  const largest=await helius({jsonrpc:"2.0",id:1,method:"getTokenLargestAccounts",params:[mint,config]});
  const accounts=largest?.value||[];if(!accounts.length)throw new Error("No token accounts returned");
  const decimals=Number(accounts[0]?.decimals??6),addresses=accounts.map(x=>x.address).filter(Boolean);
  const multiple=await helius({jsonrpc:"2.0",id:2,method:"getMultipleAccounts",params:[addresses,{encoding:"jsonParsed",commitment:config?.commitment||"confirmed"}]});
  const infos=multiple?.value||[],byOwner=new Map();
  accounts.forEach((acc,i)=>{const owner=infos[i]?.data?.parsed?.info?.owner,raw=Number(acc.amount);if(owner&&Number.isFinite(raw)&&raw>0)byOwner.set(owner,(byOwner.get(owner)||0)+raw)});
  let holders=[...byOwner.entries()].map(([owner,raw])=>({account:"",owner,raw,ui:raw/10**decimals})).filter(x=>x.raw>0).sort((a,b)=>b.raw-a.raw).slice(0,20);
  // Historical enrichment is deliberately done only for the top 20 and in small batches.
  // This avoids hammering the public Solana RPCs and keeps the Helius key server-side.
  const enriched=[];
  for(let i=0;i<holders.length;i+=4){
    const batch=holders.slice(i,i+4);
    const out=await Promise.all(batch.map(async h=>{
      try{
        const p=await reconstructWallet(h.owner,mint,decimals);
        return {...h,...p};
      }catch(e){
        return {...h,days:0,aura:0,bought:0,sold:0,activityStatus:"unavailable"};
      }
    }));
    enriched.push(...out);
  }
  return {ok:true,method:"getAuraRanking",mint,decimals,holders:enriched};
}

async function getTransfers(wallet,mint){
  let token=null,all=[];
  for(let page=0;page<MAX_HISTORY_PAGES;page++){
    const config={sortOrder:"asc",limit:HISTORY_PAGE_LIMIT,commitment:"finalized",filters:{status:"succeeded",mint}};
    if(token)config.paginationToken=token;
    const result=await helius({jsonrpc:"2.0",id:Date.now()+page,method:"getTransfersByAddress",params:[wallet,config]});
    const data=result?.data||[];all.push(...data);token=result?.paginationToken||null;
    if(!token || !data.length)break;
  }
  return all;
}

function amountUi(t,decimals=6){
  if(t?.uiAmount!==undefined && t?.uiAmount!==null) return Number(t.uiAmount);
  const raw=Number(t?.amount??t?.tokenAmount??0);
  return Number.isFinite(raw)?raw/10**Number(t?.decimals??decimals):0;
}

function transferDelta(t,wallet,decimals){
  const amount=amountUi(t,decimals);
  const from=t?.fromUserAccount??t?.from??t?.sender??null;
  const to=t?.toUserAccount??t?.to??t?.recipient??null;
  if(!Number.isFinite(amount)||amount<=0)return 0;
  if(to===wallet && from!==wallet)return amount;
  if(from===wallet && to!==wallet)return -amount;
  return 0;
}

function reconstruct(transfers,wallet,decimals,now=Math.floor(Date.now()/1000)){
  const events=transfers.map(t=>({
    ts:Number(t.timestamp??t.blockTime??t.time??0),
    delta:transferDelta(t,wallet,decimals),
    sig:t.signature||""
  })).filter(x=>x.ts>0&&x.delta!==0).sort((a,b)=>a.ts-b.ts);

  let balance=0,bought=0,sold=0,weightedSeconds=0,previousTs=events.length?events[0].ts:now;
  let firstPositive=null,lastZero=null,lastActivity=null;
  for(const e of events){
    const dt=Math.max(0,e.ts-previousTs);
    if(balance>0)weightedSeconds+=balance*dt;
    if(e.delta>0){bought+=e.delta;if(!firstPositive)firstPositive=e.ts}
    else {sold+=-e.delta;if(balance+e.delta<=0)lastZero=e.ts}
    balance=Math.max(0,balance+e.delta);
    if(balance>0)lastActivity=e.ts;
    previousTs=e.ts;
  }
  if(balance>0)weightedSeconds+=balance*Math.max(0,now-previousTs);

  // Current streak: time since the last event that reduced the reconstructed balance to zero.
  // If there was never a zero after the first receipt, use the first receipt.
  const streakStart=balance>0?(lastZero&&lastZero>0?lastZero:(firstPositive||now)):null;
  const days=streakStart?Math.floor(Math.max(0,now-streakStart)/DAY):0;
  const aura=Math.floor(weightedSeconds/DAY);
  return {amount:balance,bought,sold,aura,days,firstHeldAt:firstPositive||null,lastActivityAt:lastActivity||null,events:events.length,activityStatus:"ok"};
}

async function reconstructWallet(wallet,mint,decimals){
  const transfers=await getTransfers(wallet,mint);
  const p=reconstruct(transfers,wallet,decimals);
  // If transfer history is truncated by the safety cap, label it as an estimate rather than pretending it is exact.
  if(transfers.length>=HISTORY_PAGE_LIMIT*MAX_HISTORY_PAGES)p.activityStatus="partial";
  return p;
}

async function getAuraProfile(wallet,mint){
  const [supply,rankingData]=await Promise.all([
    helius({jsonrpc:"2.0",id:1,method:"getTokenSupply",params:[mint,{commitment:"confirmed"}]}),
    getAuraRanking(mint,{commitment:"confirmed"})
  ]);
  const decimals=Number(supply.value.decimals),supplyUi=Number(supply.value.uiAmount||Number(supply.value.amount)/10**decimals);
  const profile=await reconstructWallet(wallet,mint,decimals);
  if(!profile.amount){
    const accounts=await helius({jsonrpc:"2.0",id:2,method:"getTokenAccountsByOwner",params:[wallet,{mint},{encoding:"jsonParsed",commitment:"confirmed"}]});
    profile.amount=(accounts.value||[]).reduce((s,a)=>s+Number(a.account.data.parsed.info.tokenAmount.uiAmount||0),0);
  }
  const ranking=rankingData.holders.map(x=>({owner:x.owner,amount:x.ui}));
  const rank=profile.amount>0?ranking.filter(x=>x.amount>profile.amount).length+1:null;
  return {wallet,amount:profile.amount,pct:supplyUi?profile.amount/supplyUi*100:0,bought:profile.bought,sold:profile.sold,aura:profile.aura,days:profile.days,rank,events:profile.events,activityStatus:profile.activityStatus};
}

export default async function handler(req,res){
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed",message:"Use POST."});
  try{
    const payload=typeof req.body==="string"?JSON.parse(req.body):req.body;
    const method=payload?.method,mint=payload?.params?.[0]||MINT_DEFAULT;
    if(!method)return res.status(400).json({error:"Missing method",message:"A JSON-RPC method is required."});
    if(method==="getAuraRanking"){
      const result=await getAuraRanking(mint,payload?.params?.[1]||{commitment:"confirmed"});
      return res.status(200).json({jsonrpc:"2.0",id:payload?.id??1,result});
    }
    if(method==="getAuraProfile"){
      const wallet=payload?.params?.[0],profileMint=payload?.params?.[1]?.mint||MINT_DEFAULT;
      if(!wallet)return res.status(400).json({error:"Missing wallet",message:"A Solana wallet is required."});
      const result=await getAuraProfile(wallet,profileMint);
      return res.status(200).json({jsonrpc:"2.0",id:payload?.id??1,result});
    }
    return res.status(200).json(await firstSuccessful(payload));
  }catch(error){
    return res.status(502).json({error:"Solana RPC proxy error",message:error?.message||"Unknown error"});
  }
}
