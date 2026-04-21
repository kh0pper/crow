/**
 * Crow Campaigns — Reddit Client
 *
 * Thin wrapper around snoowrap for Reddit API operations.
 * Handles auth, post submission, subreddit info, and credential testing.
 *
 * snoowrap manages token refresh and rate limiting internally.
 */

import Snoowrap from "snoowrap";

const USER_AGENT = "crow-campaigns/1.0.0 (personal post scheduler)";

/**
 * Create an authenticated snoowrap client from decrypted credentials.
 * @param {{ username: string, clientId: string, clientSecret: string, password: string }} creds
 * @returns {Snoowrap}
 */
export function createRedditClient(creds) {
  return new Snoowrap({
    userAgent: USER_AGENT,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    username: creds.username,
    password: creds.password,
  });
}

/**
 * Verify credentials by fetching the authenticated user's identity.
 * @returns {{ name: string, created_utc: number, link_karma: number, comment_karma: number }}
 */
export async function testAuth(client) {
  const me = await client.getMe();
  return {
    name: me.name,
    created_utc: me.created_utc,
    link_karma: me.link_karma,
    comment_karma: me.comment_karma,
  };
}

/**
 * Get subreddit info: rules, link flairs, sidebar, subscribers.
 * @param {Snoowrap} client
 * @param {string} name - Subreddit name (no r/ prefix)
 */
export async function getSubredditInfo(client, name) {
  const sub = client.getSubreddit(name);

  const [about, rules, flairs] = await Promise.all([
    sub.fetch(),
    sub.getRules(),
    sub.getLinkFlairTemplates().catch(() => []),
  ]);

  return {
    name: about.display_name,
    title: about.title,
    subscribers: about.subscribers,
    description: about.public_description,
    sidebar: about.description,
    rules: rules.rules.map(r => ({
      title: r.short_name,
      description: r.description,
    })),
    flairs: flairs.map(f => ({
      id: f.flair_template_id,
      text: f.flair_text,
      editable: f.flair_text_editable,
    })),
    over18: about.over18,
    post_types: {
      allow_self: about.submission_type === "self" || about.submission_type === "any",
      allow_link: about.submission_type === "link" || about.submission_type === "any",
    },
  };
}

/**
 * Submit a text (self) post.
 * @returns {{ id: string, name: string, url: string }}
 */
export async function submitTextPost(client, { subreddit, title, body, flairId, flairText }) {
  const opts = {
    subredditName: subreddit,
    title,
    text: body,
    sendReplies: true,
  };
  if (flairId) opts.flairId = flairId;
  if (flairText) opts.flairText = flairText;

  const submission = await client.submitSelfpost(opts);
  return {
    id: submission.name,
    url: `https://www.reddit.com${submission.permalink}`,
  };
}

/**
 * Submit a link post.
 * @returns {{ id: string, name: string, url: string }}
 */
export async function submitLinkPost(client, { subreddit, title, url, flairId, flairText }) {
  const opts = {
    subredditName: subreddit,
    title,
    url,
    resubmit: true,
    sendReplies: true,
  };
  if (flairId) opts.flairId = flairId;
  if (flairText) opts.flairText = flairText;

  const submission = await client.submitLink(opts);
  return {
    id: submission.name,
    url: `https://www.reddit.com${submission.permalink}`,
  };
}

/**
 * Post a comment on a submission.
 * @param {Snoowrap} client
 * @param {string} postId - Reddit post fullname (t3_xxx)
 * @param {string} body - Markdown comment body
 */
export async function postComment(client, postId, body) {
  const submission = client.getSubmission(postId.replace(/^t3_/, ""));
  const comment = await submission.reply(body);
  return {
    id: comment.name,
    url: `https://www.reddit.com${comment.permalink}`,
  };
}
