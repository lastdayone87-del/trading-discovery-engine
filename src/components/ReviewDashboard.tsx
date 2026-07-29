import React,{useEffect,useState} from 'react';
import { CheckCircle2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import { ReviewQueueItem } from '../types';

export const ReviewDashboard:React.FC=()=>{
  const [items,setItems]=useState<ReviewQueueItem[]>([]),[selected,setSelected]=useState<ReviewQueueItem|null>(null);
  const [token,setToken]=useState(()=>localStorage.getItem('review-token')||''),[reviewer,setReviewer]=useState(()=>localStorage.getItem('reviewer-id')||'');
  const [search,setSearch]=useState(''),[country,setCountry]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const headers=()=>({Authorization:`Bearer ${token}`,'X-Reviewer-Id':reviewer});
  const load=async()=>{if(!token)return;setError('');const q=new URLSearchParams();if(search)q.set('search',search);if(country)q.set('country',country);const r=await fetch(`/api/reviews?${q}`,{headers:headers()});if(!r.ok){setError((await r.json()).error);return;}setItems(await r.json());};
  useEffect(()=>{void load()},[token,search,country]);
  const details=async(id:string)=>{const r=await fetch(`/api/reviews/${encodeURIComponent(id)}`,{headers:headers()});if(r.ok)setSelected(await r.json());else setError((await r.json()).error)};
  const act=async(action:'approve'|'reject'|'force-rescan')=>{if(!selected)return;const reason=window.prompt(`Reason for ${action}`);if(!reason)return;const notes=window.prompt('Optional notes')||'';setBusy(true);const r=await fetch(`/api/reviews/${encodeURIComponent(selected.channelId)}/${action}`,{method:'POST',headers:{...headers(),'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reviewVersion:selected.reviewVersion,reason,notes})});setBusy(false);if(!r.ok){setError((await r.json()).error);await details(selected.channelId);return;}setSelected(null);await load()};
  return <div className="space-y-5">
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
      <div className="flex items-center gap-2 mb-3"><ShieldAlert className="text-amber-500"/><h2 className="font-bold">Human Review Queue</h2></div>
      <div className="grid md:grid-cols-4 gap-2">
        <input aria-label="Reviewer API token" type="password" value={token} onChange={e=>{setToken(e.target.value);localStorage.setItem('review-token',e.target.value)}} placeholder="Reviewer API token" className="rounded-lg border p-2 bg-transparent"/>
        <input aria-label="Reviewer identity" value={reviewer} onChange={e=>{setReviewer(e.target.value);localStorage.setItem('reviewer-id',e.target.value)}} placeholder="Reviewer identity" className="rounded-lg border p-2 bg-transparent"/>
        <input aria-label="Filter reviews" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Channel or ID" className="rounded-lg border p-2 bg-transparent"/>
        <input aria-label="Filter country" value={country} onChange={e=>setCountry(e.target.value)} placeholder="Country" className="rounded-lg border p-2 bg-transparent"/>
      </div>{error&&<p className="text-red-600 text-sm mt-2">{error}</p>}
    </div>
    <div className="grid lg:grid-cols-2 gap-4">
      <section className="rounded-xl border bg-white dark:bg-slate-900 dark:border-slate-800 overflow-hidden"><h3 className="font-bold p-4 border-b dark:border-slate-800">Pending ({items.length})</h3>{items.length===0?<p className="p-6 text-sm text-slate-500">No pending reviews.</p>:items.map(i=><button key={i.channelId} onClick={()=>details(i.channelId)} className="block w-full text-left p-4 border-b dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"><b>{i.channelName}</b><div className="text-xs text-slate-500">{i.country} · version {i.reviewVersion} · {i.tradingStatus}</div></button>)}</section>
      <section className="rounded-xl border bg-white dark:bg-slate-900 dark:border-slate-800 p-4">{!selected?<p className="text-sm text-slate-500">Select a channel to inspect evidence and immutable history.</p>:<div className="space-y-4"><div><h3 className="font-bold text-lg">{selected.channelName}</h3><a className="text-indigo-600 text-sm" href={selected.youtubeUrl} target="_blank" rel="noreferrer">Open YouTube channel</a><p className="text-xs text-slate-500">{selected.country} · {selected.state} · version {selected.reviewVersion}</p></div><div><h4 className="font-semibold text-sm">Evidence snapshot</h4><pre className="text-xs overflow-auto max-h-64 bg-slate-100 dark:bg-slate-950 p-3 rounded">{JSON.stringify(selected.evidenceSnapshot,null,2)}</pre></div><div><h4 className="font-semibold text-sm">Decision history</h4>{selected.history?.length?selected.history.map(h=><div key={h.id} className="text-xs border-l-2 pl-2 my-2"><b>{h.decision}</b> by {h.reviewer} · v{h.review_version}<br/>{h.reason}{h.notes&&<> — {h.notes}</>}</div>):<p className="text-xs text-slate-500">No decisions yet.</p>}</div><div className="flex flex-wrap gap-2">{selected.state==='PENDING'&&<><button disabled={busy} onClick={()=>act('approve')} className="flex gap-1 bg-emerald-600 text-white rounded px-3 py-2"><CheckCircle2 size={16}/>Approve</button><button disabled={busy} onClick={()=>act('reject')} className="flex gap-1 bg-red-600 text-white rounded px-3 py-2"><XCircle size={16}/>Reject</button></>}{selected.state==='REJECTED'&&<button disabled={busy} onClick={()=>act('force-rescan')} className="flex gap-1 bg-amber-600 text-white rounded px-3 py-2"><RefreshCw size={16}/>Force rescan</button>}</div></div>}</section>
    </div>
  </div>
}
