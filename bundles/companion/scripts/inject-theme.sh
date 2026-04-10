#!/bin/bash
# Inject Crow Dark Editorial theme into the companion frontend.
# Uses sed to insert a <style> block into <head> so CSS is parsed
# before the React bundle renders (no FOUC).

FRONTEND_HTML="/app/frontend/index.html"

if grep -q "crow-theme-override" "$FRONTEND_HTML" 2>/dev/null; then
    echo "Theme already injected."
    exit 0
fi

# Build the style block in a temp file (avoids sed escaping issues with multi-line CSS)
TMPSTYLE=$(mktemp)
cat > "$TMPSTYLE" << 'CSSEOF'
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&display=swap">
<style id="crow-theme-override">
/* Crow Dark Editorial — companion theme override */
body, html {
  background: #0f0f17 !important;
}
#root, #root * {
  font-family: 'DM Sans', system-ui, sans-serif;
}
/* Main container */
#root .cs-main-container {
  background: #0f0f17;
  color: #fafaf9;
  border-color: rgba(61,61,77,0.5);
}
/* Left sidebar */
#root .cs-sidebar--left {
  background: rgba(15,15,23,0.92);
  backdrop-filter: blur(12px);
  border-color: rgba(61,61,77,0.5);
}
/* Conversation list */
#root .cs-conversation-list {
  background: rgba(15,15,23,0.88);
  border-color: rgba(61,61,77,0.3);
  box-shadow: 2px 0 5px -2px rgba(0,0,0,0.4);
}
/* Conversation items */
#root .cs-conversation {
  background: transparent;
  color: #a8a29e;
}
#root .cs-conversation--active {
  background: rgba(99,102,241,0.15);
  color: #fafaf9;
}
#root .cs-conversation__name {
  color: #e7e5e4;
}
#root .cs-conversation__info-content,
#root .cs-conversation__last-activity-time {
  color: #78716c;
}
/* Chat container */
#root .cs-chat-container {
  background: transparent;
}
/* Conversation header */
#root .cs-conversation-header {
  background: rgba(15,15,23,0.85);
  border-color: rgba(61,61,77,0.3);
  color: #fafaf9;
}
#root .cs-conversation-header__user-name {
  color: #fafaf9;
}
#root .cs-conversation-header__info {
  color: #a8a29e;
}
/* Message input */
#root .cs-message-input {
  background: #1a1a2e;
  border-color: rgba(61,61,77,0.3);
}
#root .cs-message-input__content-editor-wrapper,
#root .cs-message-input__content-editor-container,
#root .cs-message-input__content-editor {
  background: rgba(61,61,77,0.3);
  color: #fafaf9;
}
#root .cs-message-input__content-editor[data-placeholder]:empty:before {
  color: #78716c;
}
/* Buttons */
#root .cs-button {
  color: #a8a29e;
}
#root .cs-button:hover {
  color: #818cf8;
}
#root .cs-message-input__tools .cs-button {
  color: #a8a29e;
}
#root .cs-message-input__tools .cs-button:hover {
  color: #818cf8;
}
/* Messages */
#root .cs-message--outgoing .cs-message__content {
  background: #2d2854;
  color: #fafaf9;
}
#root .cs-message--incoming .cs-message__content {
  background: #1a1a2e;
  color: #fafaf9;
  border: 1px solid rgba(61,61,77,0.3);
}
#root .cs-message__sender-name {
  color: #818cf8;
}
#root .cs-message__sent-time {
  color: #78716c;
}
/* Message list */
#root .cs-message-list {
  background: transparent;
}
/* Expansion panels */
#root .cs-expansion-panel {
  background: transparent;
  border-color: rgba(61,61,77,0.3);
  color: #a8a29e;
}
#root .cs-expansion-panel__header {
  color: #a8a29e;
}
#root .cs-expansion-panel__title {
  color: #e7e5e4;
}
/* Search */
#root .cs-search__input {
  background: rgba(61,61,77,0.3);
  color: #fafaf9;
  border-color: rgba(61,61,77,0.5);
}
#root .cs-search__search-icon,
#root .cs-search__clear-icon {
  color: #78716c;
}
/* Scrollbars */
#root .ps__thumb-y {
  background: rgba(99,102,241,0.3);
}
#root .ps__rail-y {
  background: transparent;
}
/* Status indicators */
#root .cs-status__name {
  color: #a8a29e;
}
#root .cs-status__bullet {
  background: #22c55e;
}
/* Typing indicator */
#root .cs-typing-indicator__text {
  color: #a8a29e;
}
/* Separator */
#root .cs-message-separator {
  color: #78716c;
  background: transparent;
}
#root .cs-message-separator::before,
#root .cs-message-separator::after {
  background: rgba(61,61,77,0.4);
}
/* Mobile */
@media (max-width: 768px) {
  #root .cs-message-input__content-editor-wrapper {
    padding: 0.4em 0.7em;
  }
}
</style>
CSSEOF

# Insert the style block before </head> using sed with r (read file)
sed -i "/<\/head>/r $TMPSTYLE" "$FRONTEND_HTML"
# Move the inserted content before </head> (r inserts after the match line)
# Actually, sed 'r' inserts AFTER the match, so we need a different approach.
# Use sed to replace </head> with (style block + </head>)
STYLE_CONTENT=$(cat "$TMPSTYLE")
# Use awk instead of sed for multi-line insertion (more reliable)
awk -v style="$STYLE_CONTENT" '{
  if (/<\/head>/) {
    print style
  }
  print
}' "$FRONTEND_HTML" > "${FRONTEND_HTML}.tmp" && mv "${FRONTEND_HTML}.tmp" "$FRONTEND_HTML"

rm -f "$TMPSTYLE"
echo "Injected Crow Dark Editorial theme"
