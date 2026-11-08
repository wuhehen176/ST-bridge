const CSS = `
.bbh { display:grid; gap:16px; width:100%; max-width:860px; min-width:0; font-size:13px; line-height:1.55; color:inherit;
  --bbh-accent:#4d6bfe; --bbh-accent-soft:rgba(77,107,254,.08); --bbh-line:rgba(127,127,127,.24);
  --bbh-fill:rgba(127,127,127,.07); --bbh-danger:#e5484d; --bbh-ok:#1a9f60; }
.bbh * { box-sizing:border-box; }
.bbh-head { display:grid; gap:3px; }
.bbh-title { margin:0; font-size:17px; font-weight:650; }
.bbh-sub { margin:0; opacity:.6; }
.bbh-tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--bbh-line); padding-bottom:7px; }
.bbh-tab { appearance:none; font:inherit; color:inherit; background:transparent; border:0; border-radius:7px; padding:6px 10px; cursor:pointer; opacity:.65; }
.bbh-tab:hover { background:var(--bbh-fill); opacity:1; }
.bbh-tab.is-on { background:var(--bbh-accent-soft); color:var(--bbh-accent); opacity:1; font-weight:600; }
.bbh-card { display:grid; gap:12px; padding:14px; border:1px solid var(--bbh-line); border-radius:12px; min-width:0; }
.bbh-card-title { margin:0; font-size:14px; font-weight:600; }
.bbh-note { margin:0; font-size:12px; opacity:.58; }
.bbh-grid2 { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
.bbh-field { display:grid; gap:4px; min-width:0; align-content:start; }
.bbh-field > span { font-size:12px; opacity:.7; }
.bbh-field > small { line-height:1.35; }
.bbh-input, .bbh-textarea, .bbh-select { width:100%; min-height:34px; box-sizing:border-box; font:inherit; color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); border-radius:8px; padding:7px 9px; outline:none; }
.bbh-input:focus, .bbh-textarea:focus, .bbh-select:focus { border-color:var(--bbh-accent); }
.bbh-textarea { min-height:80px; resize:vertical; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
.bbh-check { display:flex; align-items:flex-start; gap:8px; font-size:13px; cursor:pointer; }
.bbh-check input { margin-top:3px; accent-color:var(--bbh-accent); }
.bbh-check span { display:grid; gap:1px; }
.bbh-check small { font-size:11px; opacity:.55; }
.bbh-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.bbh-btn { appearance:none; font:inherit; font-size:13px; color:#fff; background:var(--bbh-accent); border:0; border-radius:8px; padding:6px 14px; cursor:pointer; }
.bbh-btn:hover:not(:disabled) { background:#3d5bf0; }
.bbh-btn:disabled { opacity:.45; cursor:default; }
.bbh-btn.secondary { color:inherit; background:var(--bbh-fill); border:1px solid var(--bbh-line); }
.bbh-btn.secondary:hover:not(:disabled) { background:rgba(127,127,127,.14); }
.bbh-btn.danger { background:var(--bbh-danger); }
.bbh-btn.danger:hover:not(:disabled) { background:#c93b40; }
.bbh-status { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 12px; border-radius:10px; background:var(--bbh-accent-soft); }
.bbh-savebar { position:sticky; top:0; z-index:6; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; padding:8px 10px; border:1px solid var(--bbh-line); border-radius:10px; background:var(--bbh-fill); background:color-mix(in srgb, Canvas 94%, transparent); backdrop-filter:blur(8px); box-shadow:0 4px 14px rgba(0,0,0,.06); }
.bbh-savebar-state { font-size:12px; font-weight:550; }
.bbh-savebar-state.dirty { color:var(--bbh-danger); }
.bbh-savebar-state.clean { color:var(--bbh-ok); }
.bbh-dot { width:8px; height:8px; border-radius:50%; background:var(--bbh-ok); flex:none; }
.bbh-dot.off { background:var(--bbh-danger); }
.bbh-pill { font-size:11px; padding:1px 7px; border-radius:999px; background:var(--bbh-fill); opacity:.8; }
.bbh-error { margin:0; padding:9px 12px; border-radius:9px; color:var(--bbh-danger); background:rgba(229,72,77,.08); white-space:pre-wrap; }
.bbh-notice { margin:0; padding:9px 12px; border-radius:9px; color:var(--bbh-ok); background:rgba(26,159,96,.08); white-space:pre-wrap; }
.bbh-list { display:grid; gap:8px; }
.bbh-item { display:flex; gap:12px; align-items:flex-start; padding:10px 12px; border:1px solid var(--bbh-line); border-radius:10px; min-width:0; }
.bbh-item-main { flex:1; min-width:0; display:grid; gap:2px; }
.bbh-item-title { font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-sub { font-size:12px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-meta { font-size:11px; opacity:.5; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-item-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
.bbh-pre { margin:0; padding:10px 12px; border-radius:9px; background:var(--bbh-fill); max-height:300px; overflow:auto; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
.bbh-kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:4px 12px; font-size:12px; }
.bbh-kv > span:nth-child(odd) { opacity:.55; }
.bbh-kv > span:nth-child(even) { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.bbh-danger-card { border-color:rgba(229,72,77,.35); }
.bbh-danger-card .bbh-card-title { color:var(--bbh-danger); }
.bbh-fold summary { cursor:pointer; opacity:.7; font-size:12px; }
.bbh-fold[open] summary { margin-bottom:8px; }
@media (max-width:640px) { .bbh-grid2 { grid-template-columns:1fr; } .bbh-item { flex-direction:column; } .bbh-item-actions { justify-content:flex-start; } }
`

module.exports = { CSS }
