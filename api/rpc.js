const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : null;

const ENDPOINTS = [
  ...(HELIUS_RPC ? [HELIUS_RPC] : []),
  "https://api.mainnet-beta.solana.com"
];

const DEFAULT_TIMEOUT = 30000;
const MINT_DEFAULT = "8nd8CarQtxpN6UBmpBoc6hzHExnzMDm7d7HJSbFKpump";
const DAY = 86400;
const HISTORY_PAGE_LIMIT = 100;
const MAX_TRANSFER_PAGES = 20;
const FALLBACK_SIGNATURES = 120;
const FALLBACK_TRANSACTIONS = 180;

async function rpcCall(endpoint,payload){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),DEFAULT_TIMEOUT);
  try{
    const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(payload),signal:controller.signal,cache:"no-store"});
    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{throw new Error(`${endpoint}: invalid JSON (HTTP ${response.status})`)}
    if(!response.ok)throw new Error(`${endpoint}: HTTP ${response.status} — ${data?.error?.message||data?.message||text.slice(0,160)}`);
    if(data?.error)throw new Error(`${endpoint}: RPC ${data.error.code||""} — ${data.error.message||"RPC error"}`);
    return data;
  }finally{clearTimeout(timer)}
}

async function helius(payload){
  if(!HELIUS_RPC)throw new Error("HELIUS_API_KEY is not configured in Vercel");
  return (await rpcCall(HELIUS_RPC,payload)).result;
}

async function firstSuccessful(payload){
  const errors=[];
  for(const endpoint of ENDPOINTS){
    try{return await rpcCall(endpoint,payload)}catch(e){errors.push(e?.message||String(e))}
  }
  throw new Error(errors.join(" | "))
}

async function getAuraRanking(mint,config={commitment:"confirmed"}){
  const largest=await helius({jsonrpc:"2.0",id:1,method:"getTokenLargestAccounts",params:[mint,config]});
  const accounts=largest?.value||[];
  if(!accounts.length)throw new Error("No token accounts returned");
  const decimals=Number(accounts[0]?.decimals??6);
  const addresses=accounts.map(x=>x.address).filter(Boolean);
  const multiple=await helius({jsonrpc:"2.0",id:2,method:"getMultipleAccounts",params:[addresses,{encoding:"jsonParsed",commitment:config?.commitment||"confirmed"}]});
  const infos=multiple?.value||[];
  const byOwner=new Map();
  accounts.forEach((acc,i)=>{
    const owner=infos[i]?.data?.parsed?.info?.owner;
    const raw=Number(acc.amount);
    if(owner&&Number.isFinite(raw)&&raw>0)byOwner.set(owner,(byOwner.get(owner)||0)+raw)
  });
  const holders=[...byOwner.entries()]
    .map(([owner,raw])=>({account:"",owner,raw,ui:raw/10**decimals}))
    .filter(x=>x.raw>0)
    .sort((a,b)=>b.raw-a.raw)
    .slice(0,20);

  const enriched=[];
  for(let i=0;i<holders.length;i+=3){
    const batch=holders.slice(i,i+3);
    const out=await Promise.all(batch.map(async h=>{
      try{
        const p=await reconstructWallet(h.owner,mint,decimals);
        return {...h,...p};
      }catch(e){
        return {...h,days:null,aura:null,bought:null,sold:null,activityStatus:"unavailable",historyError:e?.message||"History unavailable"};
      }
    }));
    enriched.push(...out);
  }
  return {ok:true,method:"getAuraRanking",mint,decimals,holders:enriched};
}

// Helius getTransfersByAddress is the preferred history source. It supports
// max 100 rows/page and cursor pagination. Do NOT send a Solana-style params
// object as the second RPC argument beyond the documented config fields.
async function getTransfers(wallet,mint){
  let paginationToken=null;
  const all=[];
  let lastError=null;
  for(let page=0;page<MAX_TRANSFER_PAGES;page++){
    const config={mint,limit:HISTORY_PAGE_LIMIT,sortOrder:"asc",commitment:"finalized"};
    if(paginationToken)config.paginationToken=paginationToken;
    try{
      const result=await helius({jsonrpc:"2.0",id:`transfer-${Date.now()}-${page}`,method:"getTransfersByAddress",params:[wallet,config]});
      const data=result?.data||[];
      all.push(...data);
      paginationToken=result?.paginationToken||null;
      if(!paginationToken||!data.length)break;
    }catch(e){
      lastError=e;
      break;
    }
  }
  if(all.length)return {events:all,source:"helius-transfers",partial:!!paginationToken};
  throw lastError||new Error("No transfer history returned");
}

async function getTokenAccounts(wallet,mint){
  const result=await helius({jsonrpc:"2.0",id:`ta-${Date.now()}`,method:"getTokenAccountsByOwner",params:[wallet,{mint},{encoding:"jsonParsed",commitment:"finalized"}]});
  return result?.value||[];
}

// Free/standard-RPC fallback. It reconstructs balance changes from the
// wallet's token accounts when the Helius transfer-history method is not
// available on the current Helius plan.
async function getFallbackTransfers(wallet,mint){
  const tokenAccounts=await getTokenAccounts(wallet,mint);
  const addresses=[wallet,...tokenAccounts.map(x=>x.pubkey).filter(Boolean)];
  const sigMap=new Map();
  for(const address of addresses){
    try{
      const result=await helius({jsonrpc:"2.0",id:`sig-${Date.now()}-${address}`,method:"getSignaturesForAddress",params:[address,{limit:FALLBACK_SIGNATURES,commitment:"finalized"}]});
      for(const s of result||[])if(s?.signature&&!s.err)sigMap.set(s.signature,s.blockTime||0);
    }catch{}
  }
  const signatures=[...sigMap.entries()].sort((a,b)=>Number(a[1])-Number(b[1])).slice(-FALLBACK_TRANSACTIONS);
  const events=[];
  for(let i=0;i<signatures.length;i+=10){
    const batch=signatures.slice(i,i+10);
    const txs=await Promise.all(batch.map(([signature])=>helius({jsonrpc:"2.0",id:`tx-${signature}`,method:"getTransaction",params:[signature,{encoding:"jsonParsed",commitment:"finalized",maxSupportedTransactionVersion:0}]}).catch(()=>null)));
    for(let j=0;j<txs.length;j++){
      const tx=txs[j];
      if(!tx?.meta)continue;
      const pre=tx.meta.preTokenBalances||[];
      const post=tx.meta.postTokenBalances||[];
      const map=new Map();
      for(const b of pre)if(b?.mint===mint&&(b.owner===wallet||tokenAccounts.some(a=>a.pubkey===b.accountIndex)))map.set(`${b.accountIndex}:${b.mint}:${b.owner||wallet}`,Number(b.uiTokenAmount?.uiAmount||0));
      for(const b of post){
        if(b?.mint!==mint)continue;
        if(b.owner!==wallet && !tokenAccounts.some(a=>a.pubkey===b.accountIndex))continue;
        const key=`${b.accountIndex}:${b.mint}:${b.owner||wallet}`;
        const before=map.get(key)||0;
        const after=Number(b.uiTokenAmount?.uiAmount||0);
        const delta=after-before;
        if(delta!==0)events.push({timestamp:tx.blockTime,blockTime:tx.blockTime,amount:String(Math.abs(delta)),uiAmount:String(Math.abs(delta)),delta,signature:batch[j][0]});
        map.delete(key);
      }
      for(const [key,before] of map)if(before>0)events.push({timestamp:tx.blockTime,blockTime:tx.blockTime,amount:String(before),uiAmount:String(before),delta:-before,signature:batch[j][0]});
    }
  }
  return {events,source:"standard-rpc-fallback",partial:signatures.length>=FALLBACK_TRANSACTIONS};
}

function amountUi(t,decimals=6){
  if(t?.uiAmount!==undefined&&t?.uiAmount!==null)return Number(t.uiAmount);
  const raw=Number(t?.amount??t?.tokenAmount??0);
  return Number.isFinite(raw)?raw/10**Number(t?.decimals??decimals):0;
}

function transferDelta(t,wallet,decimals){
  if(Number.isFinite(Number(t?.delta)))return Number(t.delta);
  const amount=amountUi(t,decimals);
  const from=t?.fromUserAccount??t?.from??t?.sender??null;
  const to=t?.toUserAccount??t?.to??t?.recipient??null;
  if(!Number.isFinite(amount)||amount<=0)return 0;
  if(to===wallet&&from!==wallet)return amount;
  if(from===wallet&&to!==wallet)return -amount;
  if(t?.type==="mint"&&to===wallet)return amount;
  if(t?.type==="burn"&&from===wallet)return -amount;
  return 0;
}

function reconstruct(events,wallet,decimals,now=Math.floor(Date.now()/1000)){
  const normalized=events.map(t=>({
    ts:Number(t.timestamp??t.blockTime??t.time??0),
    delta:transferDelta(t,wallet,decimals),
    sig:t.signature||""
  })).filter(x=>x.ts>0&&x.delta!==0).sort((a,b)=>a.ts-b.ts);

  let balance=0,bought=0,sold=0,weightedSeconds=0,previousTs=normalized.length?normalized[0].ts:now;
  let firstPositive=null,lastZero=null,lastActivity=null;
  for(const e of normalized){
    const dt=Math.max(0,e.ts-previousTs);
    if(balance>0)weightedSeconds+=balance*dt;
    if(e.delta>0){bought+=e.delta;if(!firstPositive)firstPositive=e.ts}
    else{sold+=-e.delta;if(balance+e.delta<=0)lastZero=e.ts}
    balance=Math.max(0,balance+e.delta);
    if(balance>0)lastActivity=e.ts;
    previousTs=e.ts;
  }
  if(balance>0)weightedSeconds+=balance*Math.max(0,now-previousTs);
  const days=firstPositive?Math.floor(Math.max(0,now-(lastZero&&lastZero>firstPositive?lastZero:firstPositive))/DAY):0;
  return {amount:balance,bought,sold,aura:Math.floor(weightedSeconds/DAY),days,firstHeldAt:firstPositive||null,lastActivityAt:lastActivity||null,events:normalized.length};
}

async function reconstructWallet(wallet,mint,decimals){
  try{
    const primary=await getTransfers(wallet,mint);
    const p=reconstruct(primary.events,wallet,decimals);
    return {...p,activityStatus:primary.partial?"partial":"ok",historySource:primary.source};
  }catch(primaryError){
    try{
      const fallback=await getFallbackTransfers(wallet,mint);
      const p=reconstruct(fallback.events,wallet,decimals);
      return {...p,activityStatus:fallback.partial?"partial":"fallback",historySource:fallback.source,historyError:primaryError?.message||"Helius history unavailable"};
    }catch(fallbackError){
      return {amount:0,bought:0,sold:0,aura:0,days:null,events:0,activityStatus:"unavailable",historySource:"none",historyError:`History unavailable. ${primaryError?.message||""}`};
    }
  }
}

async function getAuraProfile(wallet,mint){
  // Balance lookup is independent from historical analytics so Check Aura
  // continues to work even when historical Helius endpoints are unavailable.
  const [supply,accounts,rankingData]=await Promise.all([
    helius({jsonrpc:"2.0",id:1,method:"getTokenSupply",params:[mint,{commitment:"confirmed"}]}),
    getTokenAccounts(wallet,mint),
    getAuraRanking(mint,{commitment:"confirmed"})
  ]);
  const decimals=Number(supply.value.decimals);
  const supplyUi=Number(supply.value.uiAmount||Number(supply.value.amount)/10**decimals);
  const amount=accounts.reduce((s,a)=>s+Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount||0),0);
  const history=await reconstructWallet(wallet,mint,decimals);
  const ranking=rankingData.holders.map(x=>({owner:x.owner,amount:x.ui}));
  const rank=amount>0?ranking.filter(x=>x.amount>amount).length+1:null;
  return {wallet,amount,pct:supplyUi?amount/supplyUi*100:0,bought:history.bought,sold:history.sold,aura:history.aura,days:history.days,rank,events:history.events,activityStatus:history.activityStatus,historySource:history.historySource,historyError:history.historyError||null};
}

export default async function handler(req,res){
  if(req.method!=="POST")return res.status(405).json({error:"Method not allowed",message:"Use POST."});
  try{
    const payload=typeof req.body==="string"?JSON.parse(req.body):req.body;
    const method=payload?.method;
    if(!method)return res.status(400).json({error:"Missing method",message:"A JSON-RPC method is required."});
    const mint=payload?.params?.[0]||MINT_DEFAULT;
    if(method==="getAuraRanking"){
      const result=await getAuraRanking(mint,payload?.params?.[1]||{commitment:"confirmed"});
      return res.status(200).json({jsonrpc:"2.0",id:payload?.id??1,result});
    }
    if(method==="getAuraProfile"){
      const wallet=payload?.params?.[0];
      const profileMint=payload?.params?.[1]?.mint||MINT_DEFAULT;
      if(!wallet)return res.status(400).json({error:"Missing wallet",message:"A Solana wallet is required."});
      const result=await getAuraProfile(wallet,profileMint);
      return res.status(200).json({jsonrpc:"2.0",id:payload?.id??1,result});
    }
    return res.status(200).json(await firstSuccessful(payload));
  }catch(error){
    return res.status(502).json({error:"Solana RPC proxy error",message:error?.message||"Unknown error"});
  }
}
