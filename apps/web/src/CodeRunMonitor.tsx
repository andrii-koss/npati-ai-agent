import { useEffect, useState } from "react";
import { monitorCodeRun, type DevelopmentProcessProgressItem as Event } from "@npati/shared";
import { getStoredAuthToken } from "./AuthContext";
import { AgentExecutionTrace } from "./AgentExecutionTrace";
import type { CompanyRun } from "./activity-types";
type MonitorData={run:CompanyRun;summary:ReturnType<typeof monitorCodeRun>;events:Event[];page:{nextCursor:string|null;total:number}};

export function CodeRunMonitor({companyId,runId,isUk}:{companyId:string;runId:string;isUk:boolean}) {
  const [data,setData]=useState<MonitorData>();
  const [error,setError]=useState("");
  const [tab,setTab]=useState("timeline"), [agent,setAgent]=useState(""), [status,setStatus]=useState(""), [since,setSince]=useState("");
  const [pages,setPages]=useState(1);
  useEffect(()=>{setPages(1);setData(undefined);},[companyId,runId]);
  useEffect(()=>{
    let stopped=false, inFlight=false, timer:ReturnType<typeof setTimeout>;
    const controller=new AbortController();
    const load=async()=>{
      if(inFlight || stopped) return;
      if(document.hidden) {timer=setTimeout(load,3000);return;}
      inFlight=true;
      try {
        const token=getStoredAuthToken(), headers:HeadersInit=token?{authorization:`Bearer ${token}`} : {};
        let cursor:string|null=null, combined:Event[]=[];
        for(let n=0;n<pages;n++) {
          const response:Response=await fetch(`/api/companies/${encodeURIComponent(companyId)}/code/monitor/runs/${encodeURIComponent(runId)}?limit=50${cursor?"&cursor="+encodeURIComponent(cursor):""}`,{headers,signal:controller.signal});
          if(!response.ok) throw new Error(`Monitoring HTTP ${response.status}`);
          const next:MonitorData=await response.json(); combined.push(...next.events); cursor=next.page.nextCursor;
          if(n===pages-1 || !cursor) {if(!stopped) {setData({...next,events:combined});setError("");}break;}
        }
      } catch(e) {if(!stopped) setError(e instanceof Error?e.message:String(e));}
      inFlight=false;
      if(!stopped) timer=setTimeout(load,3000);
    };
    const visible=()=>{if(!document.hidden){clearTimeout(timer);void load();}};
    void load();document.addEventListener("visibilitychange",visible);
    return()=>{stopped=true;controller.abort();clearTimeout(timer);document.removeEventListener("visibilitychange",visible);};
  },[companyId,runId,pages]);
  const text=(en:string,uk:string)=>isUk?uk:en;
  if(!data) return <div className="trace-detail-card" role="status">{error || text("Loading Coding Run…","Завантаження Coding Run…")}</div>;
  const s=data.summary;
  const source=tab==="live" ? s.activeActions : data.events;
  const filtered=source.filter(e=>(!agent || e.agentId===agent) && (!status || e.status===status) && (!since || Date.parse(e.at)>=Date.parse(since)) && (tab==="timeline" || tab==="performance" || tab==="tools" && !!e.tool || tab==="terminal" && !!e.command || tab==="errors" && (e.status==="failed" || !!e.error || !!e.errorCode) || tab==="live"));
  return <div className="trace-detail-card">
    <header className="trace-card-header"><h2>{data.run.task}</h2>{data.run.requestedMode==="coding_setup" && <span>{text("Preparation ID","ID підготовки")}: </span>}<code>{runId}</code> <span className={`status-pill ${data.run.status}`}>{data.run.status}</span></header>
    {error && <p role="alert" className="trace-error-box">{error} · {text("Retrying automatically; showing saved data.","Автоматичне перепідключення; показано останні дані.")}</p>}
    <div className="trace-meta-row">
      {data.run.turnIndex!==undefined && <span>{text("Turn","Крок моделі")}: {data.run.turnIndex}</span>}
      {data.run.workerId && <span>Worker: <code>{data.run.workerId}</code></span>}
      {data.run.heartbeatAt && <span>Heartbeat: <time>{data.run.heartbeatAt}</time></span>}
      {data.run.leaseExpiresAt && <span>Lease: <time>{data.run.leaseExpiresAt}</time></span>}
      <span>{text("Elapsed","Час")}: {(s.durationMs/1000).toFixed(0)}s</span><span>Tool Calls: {s.toolCalls}</span>
      <span>{text("Succeeded / failed","Успішні / невдалі")}: {s.successful} / {s.failed}</span><span>{text("Observed retries","Виявлені повторні спроби")}: {s.retries}</span>
      <span>{text("Since confirmed progress","Від підтвердженого прогресу")}: {(s.noProgressMs/1000).toFixed(0)}s</span>
    </div>
    <p>{text("Last action","Остання дія")}: {s.lastAction?.title ?? "—"} · {s.lastAction?.at}</p>
    <p>{text("Last error","Остання помилка")}: {s.lastError?.error ?? s.lastError?.errorCode ?? s.lastError?.title ?? "—"}</p>
    <p>{text("Last confirmed progress","Останній підтверджений прогрес")}: {s.progressId ? s.lastProgressAt : text("No recorded evidence yet","Підтверджень ще немає")}</p>
    <details className="trace-section" open={s.warnings.length>0}><summary>Loop Detection · {s.warnings.length}</summary>{s.warnings.length===0 && <p>{text("No suspicious repetition detected in recorded events.","Підозрілих повторень у записаних подіях не виявлено.")}</p>}{s.warnings.map((w,i)=><div key={i} className="trace-error-box" role="status"><strong>{w.label}</strong><p>{w.reason}</p>{w.eventId && <code>{w.eventId}</code>}</div>)}</details>
    <div className="activity-controls-row">
      <select aria-label="Event type" value={tab} onChange={e=>setTab(e.target.value)}>{[["timeline","Timeline"],["live","Live Activity"],["tools","Tool Calls"],["terminal","Terminal Logs"],["errors","Errors & Warnings"],["performance","Performance"]].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select>
      <select aria-label="Agent" value={agent} onChange={e=>setAgent(e.target.value)}><option value="">{text("All agents","Усі агенти")}</option>{[...new Set(data.events.map(e=>e.agentId).filter(Boolean))].map(id=><option key={id}>{id}</option>)}</select>
      <select aria-label="Event status" value={status} onChange={e=>setStatus(e.target.value)}><option value="">{text("All statuses","Усі статуси")}</option>{["running","completed","failed","cancelled","waiting_for_approval"].map(v=><option key={v}>{v}</option>)}</select>
      <input type="datetime-local" aria-label="Events since" value={since} onChange={e=>setSince(e.target.value)}/>
    </div>
    <small>{text("Filters apply to loaded events","Фільтри застосовано до завантажених подій")}: {data.events.length} / {data.page.total}</small>
    {tab==="performance" && <div className="trace-meta-row">{[...filtered].sort((a,b)=>(b.durationMs ?? 0)-(a.durationMs ?? 0)).slice(0,10).map(e=><p key={e.id}>{e.tool ?? e.title}: {e.durationMs===undefined?"—":e.durationMs+"ms"}</p>)}</div>}
    <AgentExecutionTrace items={filtered} isUk={isUk} showIdentity/>
    {data.page.nextCursor && <button type="button" className="button-secondary" onClick={()=>setPages(p=>p+1)}>{text("Load more","Завантажити ще")}</button>}
  </div>;
}
