/**
 * Messages Panel — CSS
 *
 * Three-panel messaging hub: avatar strip + chat area + info sidebar.
 * Uses design tokens from design-tokens.js (no new CSS variables).
 */

export function messagesCSS() {
  return `<style>
  /* === Hub Layout === */
  .msg-hub {
    display: flex;
    height: calc(100vh - 140px);
    min-height: 480px;
    max-width: 100%;
    border: 1px solid var(--crow-border);
    border-radius: 10px;
    overflow: hidden;
    background: var(--crow-bg-surface, #1a1a2e);
    box-sizing: border-box;
  }

  /* === Avatar Strip (left) === */
  .msg-strip {
    width: 56px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    background: var(--crow-bg-deep, #0f0f17);
    border-right: 1px solid var(--crow-border);
    padding: 8px 0;
    gap: 4px;
  }

  .msg-strip-new {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    border: 1.5px dashed var(--crow-border);
    background: transparent;
    color: var(--crow-text-muted);
    font-size: 1.2rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    margin-bottom: 4px;
    flex-shrink: 0;
  }
  .msg-strip-new:hover {
    border-color: var(--crow-accent);
    color: var(--crow-accent);
    background: color-mix(in srgb, var(--crow-accent) 8%, transparent);
  }

  .msg-strip-list {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 0 4px;
    scrollbar-width: thin;
    scrollbar-color: var(--crow-border) transparent;
  }

  .msg-avatar-item {
    position: relative;
    width: 40px;
    height: 40px;
    flex-shrink: 0;
    cursor: pointer;
    border-radius: 12px;
    transition: all 0.15s;
  }
  .msg-avatar-item:hover {
    transform: scale(1.08);
  }
  .msg-avatar-item.active {
    box-shadow: 0 0 0 2px var(--crow-accent);
  }

  .msg-avatar {
    width: 40px;
    height: 40px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    font-weight: 600;
    color: #fff;
    user-select: none;
    overflow: hidden;
  }

  /* AI avatar gradient */
  .msg-avatar-ai {
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
  }

  /* Peer avatar solid colors (generated via data attr) */
  .msg-avatar-peer {
    background: var(--peer-color, #6366f1);
  }

  .msg-unread-badge {
    position: absolute;
    top: -2px;
    right: -2px;
    min-width: 16px;
    height: 16px;
    line-height: 16px;
    text-align: center;
    font-size: 0.6rem;
    font-weight: 700;
    border-radius: 8px;
    background: var(--crow-brand-gold, #fbbf24);
    color: #000;
    padding: 0 3px;
    display: none;
  }
  .msg-unread-badge.visible { display: block; }

  .msg-strip-footer {
    padding-top: 4px;
    border-top: 1px solid var(--crow-border);
    margin-top: auto;
    flex-shrink: 0;
  }

  /* === Chat Area (center) === */
  .msg-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    background: var(--crow-bg-surface, #1a1a2e);
  }

  .msg-chat-header {
    padding: 0.6rem 1rem;
    border-bottom: 1px solid var(--crow-border);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 48px;
    flex-shrink: 0;
  }
  .msg-chat-header-name {
    font-size: 0.95rem;
    font-weight: 600;
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .msg-chat-header-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--crow-text-muted);
  }
  .msg-chat-header-status {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .msg-chat-header-status.online { background: var(--crow-success, #22c55e); }
  .msg-chat-header-status.offline { background: var(--crow-text-muted); }

  .msg-info-toggle {
    background: none;
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    color: var(--crow-text-muted);
    cursor: pointer;
    padding: 4px 8px;
    font-size: 0.75rem;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .msg-info-toggle:hover {
    color: var(--crow-text-primary);
    border-color: var(--crow-accent);
  }

  /* Messages viewport */
  .msg-chat-viewport {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    scrollbar-width: thin;
    scrollbar-color: var(--crow-border) transparent;
  }

  /* Message bubbles */
  .msg-bubble {
    max-width: 75%;
    padding: 0.6rem 0.9rem;
    border-radius: 14px;
    font-size: 0.9rem;
    overflow-wrap: break-word;
    word-break: break-word;
    line-height: 1.5;
    word-wrap: break-word;
    white-space: pre-wrap;
    animation: msgFadeIn 0.2s ease-out;
  }
  @keyframes msgFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .msg-bubble.sent {
    align-self: flex-end;
    background: var(--crow-accent);
    color: #fff;
    border-bottom-right-radius: 4px;
  }
  .msg-bubble.received {
    align-self: flex-start;
    background: var(--crow-bg-elevated, #2d2d3d);
    border-bottom-left-radius: 4px;
  }
  .msg-bubble.tool {
    align-self: flex-start;
    background: color-mix(in srgb, var(--crow-accent) 10%, var(--crow-bg-deep, #0f0f17));
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    max-width: 90%;
  }
  .msg-bubble.tool summary {
    cursor: pointer;
    color: var(--crow-accent);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  .msg-bubble.tool pre {
    margin: 0.5rem 0 0;
    white-space: pre-wrap;
    font-size: 0.75rem;
    color: var(--crow-text-muted);
    max-height: 200px;
    overflow-y: auto;
  }

  .msg-bubble-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    color: var(--crow-text-muted);
    margin-top: 4px;
    opacity: 0.7;
  }
  .msg-bubble.sent .msg-bubble-meta { text-align: right; }

  /* Reply preview inside bubble */
  .msg-bubble-reply-preview {
    border-left: 3px solid var(--crow-accent);
    padding: 2px 8px;
    margin-bottom: 6px;
    font-size: 0.78rem;
    color: var(--crow-text-muted);
    background: color-mix(in srgb, var(--crow-accent) 6%, transparent);
    border-radius: 0 4px 4px 0;
    cursor: pointer;
  }
  .msg-bubble-reply-preview strong {
    color: var(--crow-accent);
    font-size: 0.72rem;
  }

  /* Attachment cards */
  .msg-attachment {
    margin-top: 6px;
    border-radius: 8px;
    overflow: hidden;
  }
  .msg-attachment img {
    max-width: 280px;
    max-height: 200px;
    border-radius: 8px;
    cursor: pointer;
  }
  .msg-attachment-card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--crow-border) 30%, transparent);
    border-radius: 8px;
    font-size: 0.8rem;
  }
  .msg-attachment-card a {
    color: var(--crow-accent);
    text-decoration: none;
  }
  .msg-attachment-card a:hover { text-decoration: underline; }
  .msg-attachment-size {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--crow-text-muted);
  }

  /* Reply bar above input */
  .msg-reply-bar {
    display: none;
    padding: 6px 12px;
    border-top: 1px solid var(--crow-border);
    background: color-mix(in srgb, var(--crow-accent) 5%, var(--crow-bg-surface));
    font-size: 0.8rem;
    color: var(--crow-text-muted);
    align-items: center;
    gap: 8px;
  }
  .msg-reply-bar.visible { display: flex; }
  .msg-reply-bar-text {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .msg-reply-bar-cancel {
    background: none;
    border: none;
    color: var(--crow-text-muted);
    cursor: pointer;
    font-size: 1rem;
    padding: 0 4px;
  }
  .msg-reply-bar-cancel:hover { color: var(--crow-error, #ef4444); }

  /* Input area */
  .msg-chat-input {
    padding: 0.6rem 0.75rem;
    border-top: 1px solid var(--crow-border);
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    flex-shrink: 0;
  }

  .msg-attach-btn {
    background: none;
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    color: var(--crow-text-muted);
    cursor: pointer;
    padding: 6px 8px;
    font-size: 1rem;
    transition: all 0.15s;
    flex-shrink: 0;
  }
  .msg-attach-btn:hover {
    color: var(--crow-accent);
    border-color: var(--crow-accent);
  }

  .msg-textarea {
    flex: 1;
    resize: none;
    border: 1px solid var(--crow-border);
    border-radius: 8px;
    padding: 0.6rem 0.75rem;
    background: var(--crow-bg-deep, #0f0f17);
    color: var(--crow-text-primary);
    font-size: 0.9rem;
    font-family: 'DM Sans', system-ui, sans-serif;
    min-height: 40px;
    max-height: 120px;
    line-height: 1.4;
  }
  .msg-textarea:focus {
    outline: none;
    border-color: var(--crow-accent);
  }

  .msg-send-btn {
    padding: 0.6rem 1rem;
    background: var(--crow-accent);
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 600;
    transition: opacity 0.15s;
    flex-shrink: 0;
  }
  .msg-send-btn:hover { opacity: 0.85; }
  .msg-send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .msg-typing {
    font-size: 0.8rem;
    color: var(--crow-accent);
    padding: 0.25rem 0;
    font-style: italic;
    align-self: flex-start;
  }
  .msg-cancel-btn {
    font-size: 0.75rem;
    background: none;
    border: 1px solid var(--crow-border);
    border-radius: 4px;
    color: var(--crow-text-muted);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
  }

  /* === Info Sidebar (right) === */
  .msg-info {
    width: 240px;
    flex-shrink: 0;
    border-left: 1px solid var(--crow-border);
    background: var(--crow-bg-deep, #0f0f17);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    transition: width 0.2s, opacity 0.2s;
  }
  .msg-info.hidden {
    width: 0;
    overflow: hidden;
    border-left: none;
    opacity: 0;
  }

  .msg-info-profile {
    padding: 1.25rem;
    text-align: center;
    border-bottom: 1px solid var(--crow-border);
  }
  .msg-info-avatar {
    width: 60px;
    height: 60px;
    border-radius: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1.4rem;
    font-weight: 600;
    color: #fff;
    margin-bottom: 0.5rem;
  }
  .msg-info-name {
    font-size: 1rem;
    font-weight: 600;
    margin-bottom: 4px;
  }
  .msg-info-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--crow-text-muted);
    word-break: break-all;
    cursor: pointer;
  }
  .msg-info-id:hover { color: var(--crow-accent); }

  .msg-info-section {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--crow-border);
  }
  .msg-info-section-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--crow-text-muted);
    margin-bottom: 0.5rem;
    font-weight: 600;
  }
  .msg-info-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    margin-bottom: 4px;
  }

  .msg-info-actions {
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: auto;
  }
  .msg-info-action-btn {
    width: 100%;
    padding: 6px 12px;
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    background: transparent;
    color: var(--crow-text-secondary);
    font-size: 0.8rem;
    cursor: pointer;
    text-align: center;
    transition: all 0.15s;
  }
  .msg-info-action-btn:hover {
    border-color: var(--crow-accent);
    color: var(--crow-accent);
  }
  .msg-info-action-btn.danger:hover {
    border-color: var(--crow-error, #ef4444);
    color: var(--crow-error, #ef4444);
  }

  /* === Empty States === */
  .msg-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    color: var(--crow-text-muted);
    padding: 2rem;
  }
  .msg-empty h3 {
    margin: 0.5rem 0;
    color: var(--crow-text-primary);
    font-family: 'Fraunces', serif;
    font-weight: 600;
  }
  .msg-empty p { font-size: 0.85rem; }

  /* === New Contact Popover === */
  .msg-popover {
    display: none;
    position: absolute;
    top: 48px;
    left: 4px;
    width: 220px;
    background: var(--crow-bg-elevated, #2d2d3d);
    border: 1px solid var(--crow-border);
    border-radius: 10px;
    padding: 8px;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }
  .msg-popover.visible { display: block; }
  .msg-popover-item {
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.82rem;
    transition: background 0.1s;
  }
  .msg-popover-item:hover { background: color-mix(in srgb, var(--crow-accent) 12%, transparent); }
  .msg-popover-item-title { font-weight: 500; }
  .msg-popover-item-desc { font-size: 0.72rem; color: var(--crow-text-muted); margin-top: 2px; }
  .msg-popover-divider { height: 1px; background: var(--crow-border); margin: 4px 0; }

  /* Invite dialog within popover */
  .msg-invite-dialog {
    display: none;
    padding: 8px;
  }
  .msg-invite-dialog.visible { display: block; }
  .msg-invite-dialog textarea {
    width: 100%;
    resize: none;
    border: 1px solid var(--crow-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--crow-bg-deep, #0f0f17);
    color: var(--crow-text-primary);
    font-size: 0.8rem;
    font-family: 'JetBrains Mono', monospace;
    margin-bottom: 6px;
  }

  /* === Responsive === */
  @media (max-width: 900px) {
    .msg-info:not(.hidden) { width: 200px; }
  }
  @media (max-width: 768px) {
    .msg-info { display: none !important; }
    .msg-bubble { max-width: 85%; }
  }
  @media (max-width: 600px) {
    .msg-strip { width: 48px; }
    .msg-strip-new,
    .msg-avatar-item,
    .msg-avatar { width: 36px; height: 36px; }
    .msg-avatar { font-size: 0.65rem; border-radius: 10px; }
    .msg-avatar-item { border-radius: 10px; }
    .msg-strip-new { border-radius: 10px; }
    .msg-bubble { max-width: 92%; font-size: 0.85rem; }
  }
</style>`;
}
