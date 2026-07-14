/**
 * Crow Browser MCP Server — Phase 1a MVP
 *
 * 11 tools for browser automation via Chrome DevTools Protocol:
 *   launch, status, navigate, screenshot, fill_form, click,
 *   evaluate, wait_for_user, save_session, load_session, discover_selectors
 *
 * Follows the Crow MCP factory pattern (see crow-media for reference).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium } from "playwright";
import { buildStealthScript, getContextOptions, humanType, humanClick, delay } from "./stealth.js";
import { getRandomProfile } from "./profiles.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Create and configure the crow-browser MCP server.
 *
 * @param {object} [options]
 * @param {string} [options.cdpUrl]       - CDP endpoint (default: http://127.0.0.1:9222)
 * @param {string} [options.sessionDir]   - Directory for saved sessions
 * @param {string} [options.instructions] - MCP server instructions
 * @returns {McpServer}
 */
export function createBrowserServer(options = {}) {
  const cdpUrl = options.cdpUrl || process.env.CROW_BROWSER_CDP_URL || "http://127.0.0.1:9222";
  const sessionDir = options.sessionDir || join(homedir(), ".crow", "browser-sessions");
  const vncPort = process.env.CROW_BROWSER_VNC_PORT || "6080";

  const server = new McpServer(
    { name: "crow-browser", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // --- Shared state ---
  let browser = null;     // Playwright Browser instance (connected via CDP)
  let context = null;     // BrowserContext
  let page = null;        // Active Page
  let cdpSession = null;  // CDP session for low-level control

  // Pending user signal for wait_for_user
  let userWaitResolve = null;

  // Stage B network state
  let respCapture = null;  // { buffer, onResp, onFinish }
  let blockState = null;   // { onPaused }

  // Ensure session directory exists
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  /**
   * Connect to running Chrome instance via CDP.
   */
  async function ensureConnected() {
    if (browser && browser.isConnected()) return;
    browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = browser.contexts();
    context = contexts[0] || await browser.newContext(getContextOptions());
    const pages = context.pages();
    page = pages[0] || await context.newPage();
    cdpSession = await page.context().newCDPSession(page);

    // Inject stealth script on every new document
    await cdpSession.send("Page.addScriptToEvaluateOnNewDocument", {
      source: buildStealthScript(),
    });

    // Proxy auth (opt-in via env): answer 407 challenges with stored creds.
    // Only enabled when CROW_BROWSER_PROXY_USER is set — otherwise Fetch stays
    // untouched so crow_browser_block_requests can own it. (The two are
    // mutually exclusive: don't use an authed proxy and block_requests together.)
    if (process.env.CROW_BROWSER_PROXY_USER) {
      try {
        await cdpSession.send("Fetch.enable", { handleAuthRequests: true, patterns: [{ urlPattern: "*" }] });
        cdpSession.on("Fetch.authRequired", async (e) => {
          await cdpSession.send("Fetch.continueWithAuth", {
            requestId: e.requestId,
            authChallengeResponse: { response: "ProvideCredentials", username: process.env.CROW_BROWSER_PROXY_USER, password: process.env.CROW_BROWSER_PROXY_PASS || "" },
          }).catch(() => {});
        });
        cdpSession.on("Fetch.requestPaused", async (e) => {
          await cdpSession.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => {});
        });
      } catch { /* proxy auth best-effort */ }
    }
  }

  /**
   * Get current page, connecting if needed.
   */
  async function getPage() {
    await ensureConnected();
    return page;
  }

  // ==========================================
  // Tool: crow_browser_launch
  // ==========================================
  server.tool(
    "crow_browser_launch",
    "Start/restart the browser and connect via CDP. Returns the VNC URL. Pass proxy_url to route through a proxy (recreates the container — set BEFORE navigating; save sessions first).",
    {
      restart: z.boolean().optional().describe("Force restart the container"),
      proxy_url: z.string().optional().describe("Proxy to route through, e.g. http://host:port or socks5://host:port. Empty string clears it. Recreates the container (loses the current page/session — save_session first)."),
    },
    async ({ restart, proxy_url }) => {
      try {
        const changingProxy = typeof proxy_url === "string";

        if (changingProxy) {
          // Proxy is a container-launch flag, so a new proxy needs a recreate (not just restart).
          if (browser) { await browser.close().catch(() => {}); browser = null; context = null; page = null; cdpSession = null; }
          let vncpw = "", composeFile = "";
          try {
            const env = execFileSync("docker", ["inspect", "crow-browser", "--format", "{{range .Config.Env}}{{println .}}{{end}}"], { timeout: 10000 }).toString();
            vncpw = (env.split("\n").find((l) => l.startsWith("VNC_PASSWORD=")) || "").slice("VNC_PASSWORD=".length);
            composeFile = execFileSync("docker", ["inspect", "crow-browser", "--format", '{{index .Config.Labels "com.docker.compose.project.config_files"}}'], { timeout: 10000 }).toString().trim();
          } catch { /* fall through to error */ }
          if (!vncpw) return { content: [{ type: "text", text: "Could not read VNC password from the running container — set CROW_BROWSER_PROXY in the environment and recreate the container manually." }], isError: true };
          // Fallback: this bundle's own compose file, derived from our location
          // (never an assumed checkout path).
          if (!composeFile) composeFile = fileURLToPath(new URL("../docker-compose.yml", import.meta.url));
          try {
            execFileSync("docker", ["compose", "-f", composeFile, "up", "-d", "--force-recreate"], {
              timeout: 90000,
              env: { ...process.env, CROW_BROWSER_VNC_PASSWORD: vncpw, CROW_BROWSER_PROXY: proxy_url },
            });
          } catch (e) {
            return { content: [{ type: "text", text: `Failed to recreate container with proxy: ${e.message}` }], isError: true };
          }
          // Poll CDP readiness
          for (let i = 0; i < 30; i++) {
            try { const r = await fetch(`${cdpUrl}/json/version`); if (r.ok) break; } catch {}
            await new Promise((r) => setTimeout(r, 1000));
          }
        } else if (restart) {
          if (browser) {
            await browser.close().catch(() => {});
            browser = null;
            context = null;
            page = null;
            cdpSession = null;
          }
          try {
            execFileSync("docker", ["restart", "crow-browser"], { timeout: 30000 });
            // Wait for Chrome to be ready
            await new Promise((r) => setTimeout(r, 5000));
          } catch {
            return {
              content: [{ type: "text", text: "Warning: Could not restart Docker container. Is it running? Try: docker compose up -d" }],
            };
          }
        }

        await ensureConnected();
        const profile = getRandomProfile();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "connected",
              vnc_url: `http://localhost:${vncPort}/vnc.html`,
              cdp_url: cdpUrl,
              user_agent: profile.ua,
              page_url: page.url(),
              ...(changingProxy ? { proxy: proxy_url || "(cleared)" } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to connect: ${err.message}\n\nIs the container running? Try: docker compose -f ~/crow-browser/docker-compose.yml up -d` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_status
  // ==========================================
  server.tool(
    "crow_browser_status",
    "Check browser container and CDP connection health.",
    {},
    async () => {
      const containerRunning = (() => {
        try {
          const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", "crow-browser"], { encoding: "utf-8", timeout: 5000 }).trim();
          return out === "true";
        } catch {
          return false;
        }
      })();

      const cdpConnected = browser?.isConnected() || false;
      const currentUrl = page?.url() || null;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            container_running: containerRunning,
            cdp_connected: cdpConnected,
            current_url: currentUrl,
            vnc_url: containerRunning ? `http://localhost:${vncPort}/vnc.html` : null,
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================
  // Tool: crow_browser_navigate
  // ==========================================
  server.tool(
    "crow_browser_navigate",
    "Navigate to a URL. Waits for page load. Injects stealth scripts.",
    {
      url: z.string().url().describe("URL to navigate to"),
      wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).optional()
        .describe("When to consider navigation complete (default: domcontentloaded)"),
    },
    async ({ url, wait_until }) => {
      try {
        const p = await getPage();
        const response = await p.goto(url, {
          waitUntil: wait_until || "domcontentloaded",
          timeout: 30000,
        });
        await delay(500, 1500); // Human-like pause after navigation

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              url: p.url(),
              title: await p.title(),
              status: response?.status() || null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Navigation failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_screenshot
  // ==========================================
  server.tool(
    "crow_browser_screenshot",
    "Take a screenshot of the current page or a specific element.",
    {
      selector: z.string().optional().describe("CSS selector to screenshot (omit for full page)"),
      full_page: z.boolean().optional().describe("Capture full scrollable page (default: false)"),
    },
    async ({ selector, full_page }) => {
      try {
        const p = await getPage();
        let buffer;

        if (selector) {
          const el = await p.$(selector);
          if (!el) {
            return { content: [{ type: "text", text: `Element not found: ${selector}` }], isError: true };
          }
          buffer = await el.screenshot({ type: "png" });
        } else {
          buffer = await p.screenshot({ type: "png", fullPage: full_page || false });
        }

        return {
          content: [{
            type: "image",
            data: buffer.toString("base64"),
            mimeType: "image/png",
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Screenshot failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_fill_form
  // ==========================================
  server.tool(
    "crow_browser_fill_form",
    "Fill form fields with human-like typing. Accepts a map of selector -> value pairs.",
    {
      fields: z.record(z.string(), z.string())
        .describe("Map of CSS selector -> value to fill"),
      clear_first: z.boolean().optional().describe("Clear fields before filling (default: true)"),
    },
    async ({ fields, clear_first }) => {
      try {
        const p = await getPage();
        const results = {};

        for (const [selector, value] of Object.entries(fields)) {
          try {
            const el = await p.$(selector);
            if (!el) {
              results[selector] = { error: "Element not found" };
              continue;
            }

            await el.scrollIntoViewIfNeeded();
            await delay(200, 500);

            if (clear_first !== false) {
              await el.fill("");
              await delay(100, 200);
            }

            // Use human-like typing via CDP for better stealth
            await el.click();
            await delay(100, 300);
            if (cdpSession) {
              await humanType(cdpSession, value);
            } else {
              await el.type(value, { delay: 60 });
            }

            results[selector] = { filled: true, value };
          } catch (fieldErr) {
            results[selector] = { error: fieldErr.message };
          }
          await delay(300, 700); // Pause between fields
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Fill form failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_click
  // ==========================================
  server.tool(
    "crow_browser_click",
    "Click an element with position randomization for stealth.",
    {
      selector: z.string().describe("CSS selector of element to click"),
      wait_after: z.number().optional().describe("Extra wait time in ms after click"),
    },
    async ({ selector, wait_after }) => {
      try {
        const p = await getPage();
        const el = await p.$(selector);
        if (!el) {
          return { content: [{ type: "text", text: `Element not found: ${selector}` }], isError: true };
        }

        await el.scrollIntoViewIfNeeded();
        const box = await el.boundingBox();

        if (box && cdpSession) {
          await humanClick(cdpSession, box);
        } else {
          await el.click();
        }

        if (wait_after) {
          await new Promise((r) => setTimeout(r, wait_after));
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ clicked: selector, position: box ? { x: box.x, y: box.y } : null }) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Click failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_evaluate
  // ==========================================
  server.tool(
    "crow_browser_evaluate",
    "Execute JavaScript in the page context and return the result.",
    {
      expression: z.string().describe("JavaScript expression to evaluate"),
    },
    async ({ expression }) => {
      try {
        const p = await getPage();
        const result = await p.evaluate(expression);

        return {
          content: [{
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Evaluate failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_wait_for_user
  // ==========================================
  server.tool(
    "crow_browser_wait_for_user",
    "Pause automation and display a message. Waits until the user signals to continue (call again with resume=true).",
    {
      message: z.string().describe("Message to display to the user"),
      resume: z.boolean().optional().describe("Set to true to resume from a previous wait"),
    },
    async ({ message, resume }) => {
      if (resume && userWaitResolve) {
        userWaitResolve();
        userWaitResolve = null;
        return {
          content: [{ type: "text", text: "Resumed — automation continuing." }],
        };
      }

      if (resume) {
        return {
          content: [{ type: "text", text: "No pending wait to resume." }],
        };
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "waiting_for_user",
            message,
            vnc_url: `http://localhost:${vncPort}/vnc.html`,
            instruction: "Complete the required action in the VNC viewer, then call crow_browser_wait_for_user with resume=true to continue.",
          }, null, 2),
        }],
      };
    }
  );

  // ==========================================
  // Tool: crow_browser_save_session
  // ==========================================
  server.tool(
    "crow_browser_save_session",
    "Save cookies and local storage to a file for later restoration.",
    {
      name: z.string().describe("Session name (used as filename)"),
    },
    async ({ name }) => {
      try {
        const p = await getPage();
        const cookies = await context.cookies();
        const localStorage = await p.evaluate(() => {
          const data = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            data[key] = window.localStorage.getItem(key);
          }
          return data;
        });
        const sessionStorage = await p.evaluate(() => {
          const data = {};
          for (let i = 0; i < window.sessionStorage.length; i++) {
            const key = window.sessionStorage.key(i);
            data[key] = window.sessionStorage.getItem(key);
          }
          return data;
        });

        const sessionData = {
          name,
          url: p.url(),
          saved_at: new Date().toISOString(),
          cookies,
          localStorage,
          sessionStorage,
        };

        const filePath = join(sessionDir, `${name}.json`);
        writeFileSync(filePath, JSON.stringify(sessionData, null, 2));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              saved: true,
              path: filePath,
              cookies_count: cookies.length,
              localStorage_keys: Object.keys(localStorage).length,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Save session failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_load_session
  // ==========================================
  server.tool(
    "crow_browser_load_session",
    "Restore a previously saved session (cookies and storage).",
    {
      name: z.string().describe("Session name to restore"),
    },
    async ({ name }) => {
      try {
        const filePath = join(sessionDir, `${name}.json`);
        if (!existsSync(filePath)) {
          return {
            content: [{ type: "text", text: `Session not found: ${name}` }],
            isError: true,
          };
        }

        const sessionData = JSON.parse(readFileSync(filePath, "utf-8"));
        const p = await getPage();

        // Restore cookies
        if (sessionData.cookies?.length) {
          await context.addCookies(sessionData.cookies);
        }

        // Navigate to saved URL first (needed for storage access)
        if (sessionData.url && sessionData.url !== "about:blank") {
          await p.goto(sessionData.url, { waitUntil: "domcontentloaded" });
        }

        // Restore localStorage
        if (sessionData.localStorage && Object.keys(sessionData.localStorage).length) {
          await p.evaluate((data) => {
            for (const [key, value] of Object.entries(data)) {
              window.localStorage.setItem(key, value);
            }
          }, sessionData.localStorage);
        }

        // Restore sessionStorage
        if (sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length) {
          await p.evaluate((data) => {
            for (const [key, value] of Object.entries(data)) {
              window.sessionStorage.setItem(key, value);
            }
          }, sessionData.sessionStorage);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              restored: true,
              name: sessionData.name,
              url: sessionData.url,
              saved_at: sessionData.saved_at,
              cookies_count: sessionData.cookies?.length || 0,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Load session failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Tool: crow_browser_discover_selectors
  // ==========================================
  server.tool(
    "crow_browser_discover_selectors",
    "Dump all interactive elements on the page (inputs, buttons, links, selects) with their attributes.",
    {
      filter: z.enum(["all", "inputs", "buttons", "links", "selects"]).optional()
        .describe("Filter element types (default: all)"),
      frame_selector: z.string().optional()
        .describe("CSS selector of an iframe to inspect (omit for main frame)"),
    },
    async ({ filter, frame_selector }) => {
      try {
        const p = await getPage();
        let targetFrame = p;

        if (frame_selector) {
          const frameEl = await p.$(frame_selector);
          if (!frameEl) {
            return { content: [{ type: "text", text: `Frame not found: ${frame_selector}` }], isError: true };
          }
          targetFrame = await frameEl.contentFrame();
          if (!targetFrame) {
            return { content: [{ type: "text", text: `Could not access frame content: ${frame_selector}` }], isError: true };
          }
        }

        const elements = await targetFrame.evaluate((filterType) => {
          const selectors = {
            all: "input, button, a, select, textarea, [role='button'], [role='link'], [role='checkbox'], [role='radio']",
            inputs: "input, textarea, select",
            buttons: "button, [role='button'], input[type='submit'], input[type='button']",
            links: "a, [role='link']",
            selects: "select",
          };

          const query = selectors[filterType || "all"];
          const els = document.querySelectorAll(query);
          const results = [];

          for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;

            results.push({
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              id: el.id || null,
              name: el.name || null,
              class: el.className || null,
              aria_label: el.getAttribute("aria-label") || null,
              placeholder: el.placeholder || null,
              value: el.value || null,
              text: el.textContent?.trim()?.substring(0, 100) || null,
              href: el.href || null,
              role: el.getAttribute("role") || null,
              disabled: el.disabled || false,
              visible: rect.width > 0 && rect.height > 0,
              position: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            });
          }

          return results;
        }, filter);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              count: elements.length,
              filter: filter || "all",
              frame: frame_selector || "main",
              elements,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Discover selectors failed: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  // ==========================================
  // Phase 1b: Content Extraction & Scraping
  // ==========================================

  // Tool: crow_browser_extract_text
  server.tool(
    "crow_browser_extract_text",
    "Extract clean article text from the current page using Mozilla Readability. Strips ads, nav, and boilerplate. Set format='markdown' for structured Markdown.",
    {
      include_metadata: z.boolean().optional().describe("Include title, byline, excerpt (default: true)"),
      format: z.enum(["text", "markdown"]).optional().describe("Output format (default: text)"),
    },
    async ({ include_metadata, format }) => {
      try {
        const p = await getPage();
        const html = await p.content();
        const url = p.url();

        const { parseHTML } = await import("linkedom");
        const { Readability } = await import("@mozilla/readability");

        const { document } = parseHTML(html);
        const reader = new Readability(document);
        const article = reader.parse();

        if (!article) {
          return { content: [{ type: "text", text: "Could not extract article content from this page." }] };
        }

        let body = article.textContent;
        if (format === "markdown" && article.content) {
          try {
            const Turndown = (await import("turndown")).default;
            body = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(article.content);
          } catch { body = article.textContent; }
        }

        const meta = include_metadata !== false ? {
          title: article.title,
          byline: article.byline,
          excerpt: article.excerpt,
          siteName: article.siteName,
          url,
        } : null;

        const result = meta
          ? `Title: ${article.title}\nByline: ${article.byline || "Unknown"}\nURL: ${url}\n\n${body}`
          : body;

        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Extract text failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_extract_tables
  server.tool(
    "crow_browser_extract_tables",
    "Extract HTML tables from the current page as structured JSON data.",
    {
      selector: z.string().optional().describe("CSS selector for specific table (omit for all tables)"),
      format: z.enum(["json", "csv"]).optional().describe("Output format (default: json)"),
    },
    async ({ selector, format }) => {
      try {
        const p = await getPage();
        const tables = await p.evaluate((sel) => {
          const tableEls = sel
            ? [document.querySelector(sel)].filter(Boolean)
            : Array.from(document.querySelectorAll("table"));

          return tableEls.map((table, idx) => {
            const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th")).map(
              (th) => th.textContent.trim()
            );
            const rows = Array.from(table.querySelectorAll("tbody tr, tr")).slice(headers.length ? 0 : 1).map((tr) =>
              Array.from(tr.querySelectorAll("td, th")).map((td) => td.textContent.trim())
            );
            // If no thead, use first row as headers
            const finalHeaders = headers.length ? headers : (rows.length ? rows.shift() : []);
            return {
              index: idx,
              headers: finalHeaders,
              rows: rows.map((row) => {
                const obj = {};
                finalHeaders.forEach((h, i) => { obj[h || `col${i}`] = row[i] || ""; });
                return obj;
              }),
              rowCount: rows.length,
            };
          });
        }, selector);

        if (tables.length === 0) {
          return { content: [{ type: "text", text: "No tables found on this page." }] };
        }

        if (format === "csv") {
          const { stringify } = await import("csv-stringify/sync");
          const csvParts = tables.map((t) => {
            const data = [t.headers, ...t.rows.map((r) => t.headers.map((h) => r[h] || ""))];
            return `Table ${t.index} (${t.rowCount} rows):\n` + stringify(data);
          });
          return { content: [{ type: "text", text: csvParts.join("\n\n") }] };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ tables_found: tables.length, tables }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Extract tables failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_extract_links
  server.tool(
    "crow_browser_extract_links",
    "Extract all links from the current page with their text and URLs.",
    {
      filter: z.string().optional().describe("Text or URL pattern to filter links (regex)"),
      limit: z.number().optional().describe("Maximum links to return (default: 100)"),
    },
    async ({ filter, limit }) => {
      try {
        const p = await getPage();
        let links = await p.evaluate(() => {
          return Array.from(document.querySelectorAll("a[href]")).map((a) => ({
            text: a.textContent.trim().substring(0, 200),
            href: a.href,
            title: a.title || null,
          })).filter((l) => l.href && !l.href.startsWith("javascript:"));
        });

        if (filter) {
          const re = new RegExp(filter, "i");
          links = links.filter((l) => re.test(l.text) || re.test(l.href));
        }

        links = links.slice(0, limit || 100);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ count: links.length, links }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Extract links failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_scrape
  server.tool(
    "crow_browser_scrape",
    "Extract structured data from the page using CSS selectors. Define a schema of selector → field name mappings.",
    {
      selectors: z.record(z.string(), z.string())
        .describe("Map of field name → CSS selector (e.g. {\"title\": \"h1\", \"price\": \".price\"})"),
      multiple: z.boolean().optional()
        .describe("If true, return array of matches for repeating items (default: false)"),
      container: z.string().optional()
        .describe("CSS selector for repeating container element (required if multiple=true)"),
    },
    async ({ selectors, multiple, container }) => {
      try {
        const p = await getPage();
        const result = await p.evaluate(({ selectors, multiple, container }) => {
          if (multiple && container) {
            const containers = document.querySelectorAll(container);
            return Array.from(containers).map((c) => {
              const item = {};
              for (const [name, sel] of Object.entries(selectors)) {
                const el = c.querySelector(sel);
                item[name] = el ? el.textContent.trim() : null;
              }
              return item;
            });
          }
          const item = {};
          for (const [name, sel] of Object.entries(selectors)) {
            const el = document.querySelector(sel);
            item[name] = el ? el.textContent.trim() : null;
          }
          return item;
        }, { selectors, multiple, container });

        return {
          content: [{
            type: "text",
            text: JSON.stringify(multiple ? { count: result.length, items: result } : result, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Scrape failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_paginate
  server.tool(
    "crow_browser_paginate",
    "Follow pagination links and collect content from multiple pages. Returns combined results.",
    {
      next_selector: z.string().describe("CSS selector for the 'next page' link/button"),
      extract_selector: z.string().describe("CSS selector for content to extract from each page"),
      max_pages: z.number().optional().describe("Maximum pages to follow (default: 5)"),
    },
    async ({ next_selector, extract_selector, max_pages }) => {
      try {
        const p = await getPage();
        const pages = [];
        const maxP = max_pages || 5;

        for (let i = 0; i < maxP; i++) {
          const content = await p.evaluate((sel) => {
            const els = document.querySelectorAll(sel);
            return Array.from(els).map((e) => e.textContent.trim());
          }, extract_selector);

          pages.push({ page: i + 1, url: p.url(), items: content });

          // Try to click next
          const nextEl = await p.$(next_selector);
          if (!nextEl) break;

          await nextEl.click();
          await delay(1000, 2000);
          await p.waitForLoadState("domcontentloaded").catch(() => {});
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              pages_scraped: pages.length,
              total_items: pages.reduce((s, pg) => s + pg.items.length, 0),
              pages,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Paginate failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_export
  server.tool(
    "crow_browser_export",
    "Export previously scraped data as CSV or JSON file.",
    {
      data: z.array(z.record(z.string(), z.any())).describe("Array of data objects to export"),
      format: z.enum(["csv", "json"]).describe("Export format"),
      filename: z.string().optional().describe("Output filename (saved to ~/.crow/browser-exports/)"),
    },
    async ({ data, format, filename }) => {
      try {
        const exportDir = join(homedir(), ".crow", "browser-exports");
        if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

        const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
        const fname = filename || `export-${ts}`;
        const fullPath = join(exportDir, `${fname}.${format}`);

        if (format === "csv") {
          const { stringify } = await import("csv-stringify/sync");
          const headers = Object.keys(data[0] || {});
          const rows = [headers, ...data.map((row) => headers.map((h) => String(row[h] ?? "")))];
          writeFileSync(fullPath, stringify(rows));
        } else {
          writeFileSync(fullPath, JSON.stringify(data, null, 2));
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ exported: true, path: fullPath, rows: data.length, format }),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Export failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_capture_har
  server.tool(
    "crow_browser_capture_har",
    "Start or stop HAR (HTTP Archive) recording to capture all network requests. Useful for API discovery.",
    {
      action: z.enum(["start", "stop"]).describe("Start or stop HAR recording"),
    },
    async ({ action }) => {
      try {
        const p = await getPage();

        if (action === "start") {
          // Use CDP to enable network tracking
          if (!cdpSession) {
            return { content: [{ type: "text", text: "CDP session not available" }], isError: true };
          }
          await cdpSession.send("Network.enable");
          // Store requests in a simple array on the page context
          await p.evaluate(() => { window.__crow_har_requests = []; });
          await cdpSession.on("Network.responseReceived", (params) => {
            p.evaluate((entry) => {
              window.__crow_har_requests = window.__crow_har_requests || [];
              window.__crow_har_requests.push(entry);
            }, {
              url: params.response.url,
              status: params.response.status,
              mimeType: params.response.mimeType,
              method: params.type,
            }).catch(() => {});
          });

          return { content: [{ type: "text", text: "HAR recording started. Navigate the site, then call with action='stop' to get results." }] };
        }

        // Stop: collect recorded requests
        const requests = await p.evaluate(() => window.__crow_har_requests || []);
        await p.evaluate(() => { delete window.__crow_har_requests; });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              requests_captured: requests.length,
              requests: requests.slice(0, 200),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `HAR capture failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ==========================================
  // Phase 2 — Stage A: waits, scroll, session, paywall, pdf
  // ==========================================

  // Tool: crow_browser_wait_for
  server.tool(
    "crow_browser_wait_for",
    "Wait for an element to reach a state (appear, hide, attach, detach). Robust alternative to fixed sleeps for flaky/dynamic pages.",
    {
      selector: z.string().describe("CSS selector to wait on"),
      timeout_ms: z.number().optional().describe("Max wait in ms (default: 10000)"),
      state: z.enum(["visible", "hidden", "attached", "detached"]).optional().describe("Target state (default: visible)"),
    },
    async ({ selector, timeout_ms, state }) => {
      try {
        const p = await getPage();
        await p.waitForSelector(selector, { timeout: timeout_ms || 10000, state: state || "visible" });
        return { content: [{ type: "text", text: `Element '${selector}' reached state '${state || "visible"}'.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `wait_for failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_scroll_extract
  server.tool(
    "crow_browser_scroll_extract",
    "Auto-scroll an infinite-scroll / lazy-load page, collecting items each pass. Stops when no new items load or max_scrolls is hit.",
    {
      extract_selector: z.string().describe("CSS selector for the repeating items to collect (textContent)"),
      scroll_pause_ms: z.number().optional().describe("Pause between scrolls in ms (default: 1200)"),
      max_scrolls: z.number().optional().describe("Max scroll iterations (default: 20)"),
      container_selector: z.string().optional().describe("Scrollable container selector (default: window)"),
    },
    async ({ extract_selector, scroll_pause_ms, max_scrolls, container_selector }) => {
      try {
        const p = await getPage();
        const pause = scroll_pause_ms || 1200;
        const maxS = max_scrolls || 20;
        const seen = new Set();
        const items = [];
        let stagnant = 0;

        for (let i = 0; i < maxS; i++) {
          const batch = await p.evaluate((sel) => {
            return Array.from(document.querySelectorAll(sel)).map((e) => e.textContent.trim());
          }, extract_selector);

          let added = 0;
          for (const t of batch) {
            if (t && !seen.has(t)) { seen.add(t); items.push(t); added++; }
          }

          if (added === 0) { stagnant++; if (stagnant >= 2) break; } else { stagnant = 0; }

          await p.evaluate((cSel) => {
            const el = cSel ? document.querySelector(cSel) : null;
            if (el) el.scrollTo(0, el.scrollHeight);
            else window.scrollTo(0, document.body.scrollHeight);
          }, container_selector || null);
          await delay(pause, pause + 400);
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ items_collected: items.length, items }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `scroll_extract failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_set_headers
  server.tool(
    "crow_browser_set_headers",
    "Set extra HTTP headers (e.g. User-Agent, Referer) for all subsequent requests in this context. Apply BEFORE navigating.",
    {
      headers: z.record(z.string(), z.string()).describe("Header name → value map"),
    },
    async ({ headers }) => {
      try {
        await getPage();
        await context.setExtraHTTPHeaders(headers);
        return { content: [{ type: "text", text: `Set ${Object.keys(headers).length} extra header(s). They apply to subsequent navigations.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `set_headers failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_add_cookies
  server.tool(
    "crow_browser_add_cookies",
    "Inject cookies into the current context (e.g. a copied session). Each cookie needs name, value, and either url or domain+path.",
    {
      cookies: z.array(z.record(z.string(), z.any())).describe("Array of Playwright cookie objects"),
    },
    async ({ cookies }) => {
      try {
        await getPage();
        await context.addCookies(cookies);
        return { content: [{ type: "text", text: `Added ${cookies.length} cookie(s) to the context.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `add_cookies failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_extract_article
  server.tool(
    "crow_browser_extract_article",
    "Extract a (possibly paywalled) article by trying a fallback ladder: live page → archive.today → Wayback → 12ft.io. Each candidate is loaded IN the stealth browser and parsed with Readability, then quality-gated. Returns the first clean result, tagged with the method that won.",
    {
      url: z.string().describe("Article URL to extract"),
      methods: z.array(z.enum(["live", "archive", "wayback", "12ft"])).optional().describe("Ordered methods to try (default: all)"),
      format: z.enum(["text", "markdown"]).optional().describe("Output format (default: markdown)"),
      min_words: z.number().optional().describe("Min word count to accept a candidate (default: 120)"),
    },
    async ({ url, methods, format, min_words }) => {
      const order = methods || ["live", "archive", "wayback", "12ft"];
      const minW = min_words || 120;
      const PAYWALL = [
        "subscribe to continue", "subscription required", "free articles remaining",
        "you've reached your limit", "create a free account", "sign in to read",
        "this content is for subscribers", "become a member", "log in to continue",
      ];
      const candidateUrl = (m) => {
        if (m === "live") return url;
        if (m === "archive") return `https://archive.ph/newest/${url}`;
        if (m === "wayback") return `https://web.archive.org/web/2/${encodeURI(url)}`;
        if (m === "12ft") return `https://12ft.io/${url}`;
        return url;
      };
      try {
        const p = await getPage();
        const { parseHTML } = await import("linkedom");
        const { Readability } = await import("@mozilla/readability");
        const attempts = [];

        for (const m of order) {
          try {
            await p.goto(candidateUrl(m), { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(800, 1600);
            const html = await p.content();
            const { document } = parseHTML(html);
            const article = new Readability(document).parse();
            if (!article || !article.textContent) { attempts.push(`${m}: no article`); continue; }

            const text = article.textContent.trim();
            const words = text.split(/\s+/).length;
            const low = text.toLowerCase();
            const paywalled = PAYWALL.some((ph) => low.includes(ph));

            if (words < minW) { attempts.push(`${m}: too short (${words}w)`); continue; }
            if (paywalled) { attempts.push(`${m}: paywall phrase`); continue; }

            let body = text;
            if ((format || "markdown") === "markdown" && article.content) {
              try {
                const Turndown = (await import("turndown")).default;
                body = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" }).turndown(article.content);
              } catch { body = text; }
            }

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  ok: true, method: m, words, title: article.title,
                  byline: article.byline, url, format: format || "markdown",
                }, null, 2) + "\n\n---\n\n" + body,
              }],
            };
          } catch (e) {
            attempts.push(`${m}: ${e.message}`);
          }
        }

        return {
          content: [{ type: "text", text: `All methods failed for ${url}:\n- ${attempts.join("\n- ")}` }],
          isError: true,
        };
      } catch (err) {
        return { content: [{ type: "text", text: `extract_article failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_extract_pdf
  server.tool(
    "crow_browser_extract_pdf",
    "Extract text (or metadata) from a PDF by URL or local path, using pdfjs-dist. Good for gov reports, papers, invoices.",
    {
      url_or_path: z.string().describe("PDF URL (http/https) or absolute local file path"),
      type: z.enum(["text", "metadata"]).optional().describe("What to extract (default: text)"),
      max_pages: z.number().optional().describe("Max pages to read (default: 100)"),
    },
    async ({ url_or_path, type, max_pages }) => {
      try {
        let data;
        if (/^https?:\/\//i.test(url_or_path)) {
          const res = await fetch(url_or_path);
          if (!res.ok) return { content: [{ type: "text", text: `Fetch failed: HTTP ${res.status}` }], isError: true };
          data = new Uint8Array(await res.arrayBuffer());
        } else {
          data = new Uint8Array(readFileSync(url_or_path));
        }

        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const doc = await pdfjs.getDocument({ data, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;

        if (type === "metadata") {
          const md = await doc.getMetadata().catch(() => ({ info: {} }));
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ pages: doc.numPages, info: md.info || {} }, null, 2),
            }],
          };
        }

        const limit = Math.min(doc.numPages, max_pages || 100);
        const parts = [];
        for (let i = 1; i <= limit; i++) {
          const page = await doc.getPage(i);
          const tc = await page.getTextContent();
          const txt = tc.items.map((it) => (it.str || "")).join(" ").replace(/\s+/g, " ").trim();
          parts.push(`[page ${i}]\n${txt}`);
        }

        return {
          content: [{
            type: "text",
            text: `PDF: ${doc.numPages} pages (read ${limit})\n\n` + parts.join("\n\n"),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `extract_pdf failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ==========================================
  // Phase 2 — Stage B: network capture, blocking, downloads
  // ==========================================

  // Tool: crow_browser_capture_responses
  server.tool(
    "crow_browser_capture_responses",
    "Capture network responses (incl. JSON bodies) via raw CDP — the fastest way to find a site's hidden JSON API. start, then navigate/interact, then stop to get results.",
    {
      action: z.enum(["start", "stop"]).describe("Start or stop capturing"),
      filter_url_pattern: z.string().optional().describe("Regex; only capture responses whose URL matches"),
      include_response_body: z.boolean().optional().describe("Fetch response bodies (default: false — metadata only)"),
    },
    async ({ action, filter_url_pattern, include_response_body }) => {
      try {
        await getPage();
        if (!cdpSession) return { content: [{ type: "text", text: "CDP session not available" }], isError: true };

        if (action === "start") {
          if (respCapture) {
            cdpSession.off("Network.responseReceived", respCapture.onResp);
            cdpSession.off("Network.loadingFinished", respCapture.onFinish);
          }
          let re = null;
          if (filter_url_pattern) {
            try { re = new RegExp(filter_url_pattern); } catch (e) { return { content: [{ type: "text", text: `Bad regex: ${e.message}` }], isError: true }; }
          }
          const buffer = [];
          const meta = {};
          const onResp = (p) => {
            if (!re || re.test(p.response.url)) {
              meta[p.requestId] = { url: p.response.url, status: p.response.status, mimeType: p.response.mimeType };
            }
          };
          const onFinish = async (p) => {
            const entry = meta[p.requestId];
            if (!entry) return;
            if (include_response_body) {
              try {
                const b = await cdpSession.send("Network.getResponseBody", { requestId: p.requestId });
                entry.body = b.base64Encoded ? `(base64, ${(b.body || "").length} chars)` : (b.body || "").slice(0, 20000);
              } catch (e) { entry.bodyError = e.message; }
            }
            buffer.push(entry);
            delete meta[p.requestId];
          };
          await cdpSession.send("Network.enable");
          cdpSession.on("Network.responseReceived", onResp);
          cdpSession.on("Network.loadingFinished", onFinish);
          respCapture = { buffer, onResp, onFinish };
          return { content: [{ type: "text", text: `Response capture started${filter_url_pattern ? ` (filter: ${filter_url_pattern})` : ""}${include_response_body ? " with bodies" : ""}. Navigate/interact, then call with action='stop'.` }] };
        }

        // stop
        if (!respCapture) return { content: [{ type: "text", text: "No capture in progress." }] };
        cdpSession.off("Network.responseReceived", respCapture.onResp);
        cdpSession.off("Network.loadingFinished", respCapture.onFinish);
        const results = respCapture.buffer;
        respCapture = null;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ responses_captured: results.length, responses: results.slice(0, 100) }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `capture_responses failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_block_requests
  server.tool(
    "crow_browser_block_requests",
    "Block requests whose URL contains any of the given substrings (ads/trackers/images) via raw CDP Fetch. Speeds pages up and lowers detection surface. Call with action='stop' to clear.",
    {
      action: z.enum(["start", "stop"]).describe("Start or stop blocking"),
      patterns: z.array(z.string()).optional().describe("URL substrings to block (e.g. ['doubleclick','google-analytics','.jpg'])"),
    },
    async ({ action, patterns }) => {
      try {
        await getPage();
        if (!cdpSession) return { content: [{ type: "text", text: "CDP session not available" }], isError: true };

        if (action === "stop") {
          if (blockState) {
            cdpSession.off("Fetch.requestPaused", blockState.onPaused);
            await cdpSession.send("Fetch.disable").catch(() => {});
            blockState = null;
          }
          return { content: [{ type: "text", text: "Request blocking stopped." }] };
        }

        const pats = patterns || [];
        if (blockState) cdpSession.off("Fetch.requestPaused", blockState.onPaused);
        const onPaused = async (p) => {
          try {
            if (pats.some((x) => p.request.url.includes(x))) {
              await cdpSession.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" });
            } else {
              await cdpSession.send("Fetch.continueRequest", { requestId: p.requestId });
            }
          } catch { /* request may already be gone */ }
        };
        await cdpSession.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        cdpSession.on("Fetch.requestPaused", onPaused);
        blockState = { onPaused };
        return { content: [{ type: "text", text: `Blocking ${pats.length} pattern(s): ${pats.join(", ") || "(none — all requests pass)"}. Call action='stop' to clear.` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `block_requests failed: ${err.message}` }], isError: true };
      }
    }
  );

  // Tool: crow_browser_download
  server.tool(
    "crow_browser_download",
    "Trigger a file download by clicking an element, and save it to the host at ~/.crow/browser-downloads/. Uses a container bind mount + CDP download behavior.",
    {
      selector: z.string().describe("CSS selector of the link/button that starts the download"),
      timeout_ms: z.number().optional().describe("Max wait for the file to finish (default: 30000)"),
    },
    async ({ selector, timeout_ms }) => {
      try {
        const p = await getPage();
        const hostDir = join(homedir(), ".crow", "browser-downloads");
        if (!existsSync(hostDir)) mkdirSync(hostDir, { recursive: true });

        // Container writes to /downloads, bind-mounted to hostDir.
        await cdpSession.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/downloads" });

        const before = new Set(existsSync(hostDir) ? readdirSync(hostDir) : []);
        const el = await p.$(selector);
        if (!el) return { content: [{ type: "text", text: `Selector not found: ${selector}` }], isError: true };
        await el.click().catch(() => {});

        const deadline = Date.now() + (timeout_ms || 30000);
        let found = null;
        while (Date.now() < deadline) {
          const now = readdirSync(hostDir).filter((f) => !before.has(f) && !f.endsWith(".crdownload") && !f.endsWith(".part") && !f.endsWith(".tmp"));
          if (now.length) {
            const newest = now.map((f) => ({ f, m: statSync(join(hostDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
            found = newest.f;
            break;
          }
          await delay(500, 700);
        }
        if (!found) return { content: [{ type: "text", text: "Download triggered but no completed file appeared (timeout). Check the bind mount and that the click started a download." }], isError: true };

        const full = join(hostDir, found);
        return { content: [{ type: "text", text: JSON.stringify({ downloaded: true, file: found, path: full, bytes: statSync(full).size }) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `download failed: ${err.message}` }], isError: true };
      }
    }
  );

  // ==========================================
  // Prompt: crow_browser_guide
  // ==========================================
  server.prompt(
    "crow_browser_guide",
    "How to use Crow Browser for automation tasks",
    async () => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `# Crow Browser — Quick Guide

## Core Tools (Phase 1a)
- \`crow_browser_launch\` / \`crow_browser_status\` — connect to browser
- \`crow_browser_navigate\` — go to URL
- \`crow_browser_discover_selectors\` — find interactive elements
- \`crow_browser_fill_form\` — fill inputs with human-like typing
- \`crow_browser_click\` — click with position randomization
- \`crow_browser_screenshot\` — capture current state
- \`crow_browser_evaluate\` — run JS in page context
- \`crow_browser_wait_for_user\` — pause for CAPTCHA, 2FA
- \`crow_browser_save_session\` / \`crow_browser_load_session\` — persist cookies

## Content Extraction (Phase 1b)
- \`crow_browser_extract_text\` — clean article text via Readability
- \`crow_browser_extract_tables\` — HTML tables → JSON/CSV
- \`crow_browser_extract_links\` — all links with text/URLs
- \`crow_browser_scrape\` — structured data via CSS selectors
- \`crow_browser_paginate\` — follow pagination, collect multi-page results
- \`crow_browser_export\` — save data as CSV or JSON file
- \`crow_browser_capture_har\` — record network requests (API discovery)

## Workflow
1. \`launch\` → \`navigate\` → \`discover_selectors\` → \`fill_form\`/\`click\`
2. For scraping: \`navigate\` → \`extract_text\` or \`scrape\` → \`export\`
3. For multi-page: \`navigate\` → \`paginate\` → \`export\`
4. Save sessions before long operations`,
        },
      }],
    })
  );

  return server;
}
