# 核算「闪退打断的模型调用」积分（只读 ~/.workbuddy，不改动任何东西）
import io,os,json,sqlite3,glob,datetime,collections,shutil,tempfile
TZ=datetime.timezone(datetime.timedelta(hours=8))
HOME=os.path.expanduser("~")
# 崩溃事件
crash=[]
for p in glob.glob(os.path.join(HOME,".workbuddy","logs","Crash-Log","crash-report-*.json")):
    for e in json.load(io.open(p,encoding="utf-8")).get("entries",[]):
        if e.get("type")=="renderer_crash": crash.append(e["timestamp"])
crash=sorted({c[:19] for c in crash})
crash_ms=[int(datetime.datetime.strptime(c,"%Y-%m-%dT%H:%M:%S").replace(tzinfo=TZ).timestamp()*1000) for c in crash]
# 积分表（只读副本）
td=tempfile.mkdtemp()
for suf in ("","-wal","-shm"):
    s=os.path.join(HOME,".workbuddy","workbuddy.db"+suf)
    if os.path.exists(s): shutil.copy2(s,os.path.join(td,"workbuddy.db"+suf))
con=sqlite3.connect("file:%s?mode=ro" % os.path.join(td,"workbuddy.db").replace("\\","/"),uri=True)
cred={s:json.loads(c) for s,c in con.execute("SELECT session_id,credit_json FROM session_usage") if c}
idx={}
for d in glob.glob(os.path.join(HOME,".workbuddy","projects","*")):
    for f in glob.glob(os.path.join(d,"*.jsonl")): idx[os.path.basename(f)[:-6]]=f
rows=[]
for sid,cr in cred.items():
    p=idx.get(sid)
    if not p: continue
    recs=collections.defaultdict(list)
    for line in io.open(p,encoding="utf-8",errors="replace"):
        if '"traceId"' not in line: continue
        try: o=json.loads(line)
        except Exception: continue
        t=(o.get("providerData") or {}).get("traceId")
        if t: recs[t].append((o.get("timestamp") or 0,o.get("type"),o.get("id"),o.get("parentId")))
    for t,v in cr.items():
        rr=recs.get(t)
        if not rr: continue
        calls={x[2] for x in rr if x[1]=="function_call"}
        done={x[3] for x in rr if x[1]=="function_call_result"}
        if calls-done:
            last=max(x[0] for x in rr)
            nxt=[c-last for c in crash_ms if 0<c-last]
            rows.append((last,v,min(nxt) if nxt else None))
def bucket(sec):
    return sum(v for l,v,d in rows if d is not None and d<=sec*1000)
hi10=sum(1 for l,v,d in rows if d is not None and d<=10000)
print("崩溃事件 %d 次；调用被截断 %d 次" % (len(crash_ms),len(rows)))
print("  ≤10 秒内闪退  %6.2f 积分（%d 次）" % (bucket(10),hi10))
print("  ≤60 秒内闪退  %6.2f 积分（%d 次）" % (bucket(60),sum(1 for l,v,d in rows if d is not None and d<=60000)))
print("  ≤10 分钟内闪退 %6.2f 积分（%d 次）" % (bucket(600),sum(1 for l,v,d in rows if d is not None and d<=600000)))
print("  ≤1 小时内闪退  %6.2f 积分（%d 次）" % (bucket(3600),sum(1 for l,v,d in rows if d is not None and d<=3600000)))
print("  全部截断      %6.2f 积分（%d 次）" % (sum(v for l,v,d in rows),len(rows)))
tot=sum(sum(c.values()) for c in cred.values())
print("\n积分明细表可见的已扣总量 = %.2f（%d 个会话）" % (tot,len(cred)))
print("占比：≤1 小时口径 %.2f%%" % (100*bucket(3600)/tot))
