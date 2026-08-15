from pathlib import Path

p=Path('server/investigationWorkflow.ts')
s=p.read_text()
old="latest?.resulting_status==='TRADING_CONFIRMED'||latest?.resulting_status==='NON_TRADING'?'COMPLETED':latest?'NEEDS_REVIEW':investigation.rows[0].state"
new="latest?.resulting_status==='TRADING_CONFIRMED'||latest?.resulting_status==='NON_TRADING'?'COMPLETED':latest?.state==='FAILED'?'OPERATIONALLY_BLOCKED':latest?.resulting_status==='NEEDS_REVIEW'?'NEEDS_REVIEW':latest?'UNRESOLVED':investigation.rows[0].state"
if s.count(old)!=1:
    raise SystemExit(f'repair projection target count {s.count(old)}')
s=s.replace(old,new,1)
old_health="COUNT(*) FILTER(WHERE state='FAILED')::int failed,COUNT(*) FILTER(WHERE state='COMPLETED')::int completed"
new_health="COUNT(*) FILTER(WHERE state='FAILED')::int failed,COUNT(*) FILTER(WHERE state='OPERATIONALLY_BLOCKED')::int operationally_blocked,COUNT(*) FILTER(WHERE state='COMPLETED')::int completed"
if s.count(old_health)!=1:
    raise SystemExit(f'health target count {s.count(old_health)}')
s=s.replace(old_health,new_health,1)
p.write_text(s)
