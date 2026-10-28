/**
 * crow_browser_wait_for_user's result: the bot parks and asks the operator to
 * step in. The operator does that from the chat (the browser tile's Take over
 * sheet), not from a VNC URL the operator's device usually cannot open.
 */
export function waitingForUserResult(message) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "waiting_for_user",
        message,
        instruction: "Tell the operator what they need to do and ask them to tap Take over in the chat, " +
          "complete it in the browser, then hand the browser back. Then call crow_browser_wait_for_user " +
          "with resume=true to continue.",
      }, null, 2),
    }],
  };
}
