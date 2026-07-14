/**
 * Bot Builder Panel — CSS
 *
 * Scoped styles for the bot-builder panel.
 */

export function botBuilderStyles() {
  return `<style>
  /* Tab navigation */
  .btb-tabs{display:flex;gap:.35rem;flex-wrap:wrap;margin:10px 0 16px}
  .btb-tab{display:inline-block;padding:.4rem .75rem;border-radius:var(--crow-radius-pill);text-decoration:none;font-size:.85rem;font-weight:500;background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border);transition:background .12s,color .12s,border-color .12s}
  .btb-tab:hover{background:var(--crow-bg-surface);color:var(--crow-text-primary);border-color:var(--crow-accent)}
  .btb-tab-active{background:var(--crow-accent);color:#fff;border-color:var(--crow-accent)}
  .btb-tab-active:hover{background:var(--crow-accent);color:#fff}

  /* Form layout */
  .btb-form{padding:0}
  .btb-group{margin-bottom:1rem}
  .btb-group>label{display:block;font-size:.8rem;color:var(--crow-text-muted);margin-bottom:.35rem;text-transform:uppercase;letter-spacing:.05em}

  /* Form fields */
  .btb-select,.btb-input,.btb-textarea{width:100%;max-width:480px;padding:.45rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:6px;color:var(--crow-text-primary);font:inherit}
  .btb-textarea{font-family:'JetBrains Mono',monospace;font-size:.82rem;min-height:80px}
  .btb-textarea-wide{max-width:100%}

  /* Hints & warnings */
  .btb-hint{font-size:.9em;color:var(--crow-text-muted);margin:.35rem 0 .75rem}
  .btb-warn{font-size:.9em;color:var(--crow-text-secondary);margin:.35rem 0 .75rem;font-style:italic}

  /* Notices */
  .btb-notice-ok{color:var(--crow-success)}
  .btb-notice-err{color:var(--crow-error)}
  .btb-notice-warn{color:var(--crow-text-secondary);font-style:italic}

  /* Divider */
  .btb-divider{margin:1rem 0;border:none;border-top:1px solid var(--crow-border)}

  /* Checkboxes */
  .btb-checkbox-group{display:flex;flex-wrap:wrap;gap:.25rem .75rem;margin:.5rem 0}
  .btb-checkbox{display:inline-flex;align-items:center;gap:.3rem;font-size:.88rem;cursor:pointer;padding:.2rem 0}
  .btb-checkbox input[type="checkbox"]{margin:0}

  /* MCP tool grid */
  .btb-mcp-section{margin:.75rem 0 .5rem}
  .btb-mcp-section b{font-size:.9rem}
  .btb-mcp-count{font-size:.8rem;color:var(--crow-text-muted)}
  /* Mobile-first: ONE tool per full-width row. Each row is a plain block (NOT
     flex) so the name uses the full width and sits on one line — long names
     have no spaces (crow_browser_capture_har_image), and in a flex row they'd
     shrink to a 1-char-wide item and wrap vertically. The checkbox is inline.
     2 columns only on wider screens. overflow-wrap:break-word breaks a name
     ONLY if it would actually overflow (rare at full width), never per-char. */
  .btb-mcp-grid{display:grid;grid-template-columns:1fr;gap:0 1.25rem}
  .btb-mcp-tool{display:block;font-size:.85rem;padding:.32rem 0;line-height:1.3;overflow-wrap:break-word}
  .btb-mcp-tool input[type="checkbox"]{margin:0 .5rem 0 0;vertical-align:middle;flex:none}
  .btb-mcp-regex{color:var(--crow-text-secondary);font-size:.78rem;white-space:nowrap}
  @media(min-width:620px){.btb-mcp-grid{grid-template-columns:1fr 1fr}}

  /* Tables */
  .btb-table{width:100%;border-collapse:collapse;font-size:.85rem}
  .btb-table thead tr{border-bottom:1px solid var(--crow-border)}
  .btb-table th{padding:.35rem .5rem;text-align:left;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);font-weight:600}
  .btb-table td{padding:.35rem .5rem}
  .btb-table tbody tr{border-bottom:1px solid var(--crow-border)}
  .btb-table tbody tr:last-child{border-bottom:none}
  .btb-table input,.btb-table select{padding:.25rem .35rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary);font:inherit;font-size:.85rem}

  /* Monitor table */
  .btb-monitor{width:100%;border-collapse:collapse;font-size:.85rem}
  .btb-monitor thead tr{text-align:left;border-bottom:1px solid var(--crow-border)}
  .btb-monitor th{padding:.35rem .5rem;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--crow-text-muted);font-weight:600}
  .btb-monitor td{padding:.35rem .5rem}
  .btb-monitor tbody tr{border-bottom:1px solid var(--crow-border)}
  .btb-monitor tbody tr:last-child{border-bottom:none}
  .btb-monitor .btb-mono{font-family:'JetBrains Mono',monospace;font-size:.8rem}

  /* Status colors */
  .btb-ok{color:var(--crow-success);font-weight:600}
  .btb-err{color:var(--crow-error);font-weight:600}
  .btb-status-warn{color:var(--crow-text-secondary);font-weight:600}
  .btb-muted{color:var(--crow-text-muted)}

  /* Snapshot card */
  .btb-snapshot{margin:.75rem 0;padding:.75rem;background:var(--crow-bg-elevated);color:var(--crow-text-primary);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card);font-size:.9em}
  .btb-snapshot a{color:var(--crow-accent);font-weight:600}

  /* Send panel (sessions tab) */
  .btb-send-panel{display:none;margin:1rem 0;padding:.75rem;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:var(--crow-radius-card)}
  .btb-send-panel label{font-size:.8rem}
  .btb-send-panel textarea{width:100%;margin:.4rem 0}
  .btb-send-panel .btb-send-status{margin-left:.5rem;font-size:.8rem}

  /* Review tab */
  .btb-review-table{border-collapse:collapse;font-size:.92em}
  .btb-review-table td{padding:.2rem .75rem .2rem 0}
  .btb-review-table td:first-child{color:var(--crow-text-muted)}
  .btb-review-table code{font-family:'JetBrains Mono',monospace;font-size:.88em}
  .btb-review-source{font-size:.85em;color:var(--crow-text-muted)}
  .btb-review-fallback{color:var(--crow-text-secondary)}

  .btb-pre{background:var(--crow-bg-elevated);color:var(--crow-text-primary);border:1px solid var(--crow-border);padding:.75rem;border-radius:var(--crow-radius-card);overflow:auto;max-height:420px;white-space:pre-wrap;word-break:break-word;font-family:'JetBrains Mono',monospace;font-size:.82rem}

  /* Tracker def editor */
  .btb-tdef-msg{font-size:.82rem;min-height:1.1em;margin:.25rem 0}

  /* Buttons (reuse bb-btn/bb-sec from bot-board where available) */
  .btb-btn{padding:.45rem .9rem;background:var(--crow-accent);border:none;border-radius:var(--crow-radius-pill);color:#fff;cursor:pointer;font:inherit}
  .btb-btn-sec{background:var(--crow-bg-elevated);color:var(--crow-text-secondary);border:1px solid var(--crow-border)}
  .btb-btn-sm{font-size:.78rem;padding:.2rem .5rem}
  .btb-btn-inline{display:inline}

  /* Session action buttons */
  .btb-sess-btn{font-size:.75rem;padding:.15rem .4rem;cursor:pointer;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-radius:4px;color:var(--crow-text-primary)}
  .btb-sess-link{font-size:.75rem;color:var(--crow-accent)}

  /* Remote capabilities group */
  .btb-remote-caps{margin:.75rem 0;padding:.5rem .75rem;border:1px solid var(--crow-border);border-radius:6px}
  .btb-remote-caps summary{cursor:pointer;font-size:.88rem;font-weight:500}
  .btb-remote-caps ul{margin:.35rem 0 0 1rem;padding:0;font-size:.85rem}
  .btb-remote-caps .btb-muted{opacity:.7}

  /* Guided-creation wizard (Item 5 PR1) */
  .btb-wiz-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:.75rem;margin:.75rem 0}
  .btb-wiz-card{display:flex;flex-direction:column;gap:.3rem;border:1px solid var(--crow-border);border-radius:8px;padding:.75rem;cursor:pointer;background:var(--crow-bg-elevated)}
  .btb-wiz-card:hover{border-color:var(--crow-accent)}
  .btb-wiz-card-sel{border-color:var(--crow-accent);box-shadow:0 0 0 1px var(--crow-accent)}
  .btb-wiz-card input[type=radio]{margin:0 0 .2rem}
  .btb-wiz-card-title{font-weight:600}
  .btb-wiz-card-desc{font-size:.85rem;color:var(--crow-text-secondary)}
  .btb-wiz-card-needs{font-size:.78rem;color:var(--crow-text-muted)}
  .btb-quick-create summary{cursor:pointer;font-size:.9rem;color:var(--crow-text-secondary)}
</style>`;
}
