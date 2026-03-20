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
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
    "Start or restart the browser container and connect via CDP. Returns VNC URL.",
    {
      restart: z.boolean().optional().describe("Force restart the container"),
    },
    async ({ restart }) => {
      try {
        if (restart) {
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
    "Extract clean article text from the current page using Mozilla Readability. Strips ads, nav, and boilerplate.",
    {
      include_metadata: z.boolean().optional().describe("Include title, byline, excerpt (default: true)"),
    },
    async ({ include_metadata }) => {
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

        const meta = include_metadata !== false ? {
          title: article.title,
          byline: article.byline,
          excerpt: article.excerpt,
          siteName: article.siteName,
          url,
        } : null;

        const result = meta
          ? `Title: ${article.title}\nByline: ${article.byline || "Unknown"}\nURL: ${url}\n\n${article.textContent}`
          : article.textContent;

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
