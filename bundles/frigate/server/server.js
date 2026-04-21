/**
 * Frigate MCP Server
 *
 * Tools (Milestone B):
 * - crow_frigate_list_cameras     — cameras + detect/record state
 * - crow_frigate_list_events      — detection events, filter by camera/label/time
 * - crow_frigate_latest_by_label  — most recent event for a label across all cameras
 * - crow_frigate_snapshot         — event snapshot or camera-latest URL
 * - crow_frigate_clip_url         — MP4 clip URL for an event
 * - crow_frigate_set_detect       — enable/disable detect per camera (destructive)
 * - crow_frigate_stats            — system stats (CPU, detector inference)
 *
 * URLs in responses are authenticated Frigate endpoints — usable from the
 * Crow gateway (which has the JWT) and inside the Nest panel iframe (which
 * has Frigate's own session cookie). Do NOT share them off-tailnet.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { frigateFetch, frigateBaseUrl, clearCache } from "./frigate-api.js";

function isoToEpochSeconds(iso) {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (isNaN(t)) return undefined;
  return Math.floor(t / 1000);
}

function epochToIso(secs) {
  if (!secs) return null;
  return new Date(secs * 1000).toISOString();
}

function summarizeEvent(e) {
  return {
    id: e.id,
    camera: e.camera,
    label: e.label,
    sub_label: e.sub_label || null,
    score: e.top_score ?? e.score ?? null,
    start: epochToIso(e.start_time),
    end: e.end_time ? epochToIso(e.end_time) : null,
    has_snapshot: !!e.has_snapshot,
    has_clip: !!e.has_clip,
    zones: e.zones || [],
  };
}

export function createFrigateServer(options = {}) {
  const server = new McpServer(
    { name: "crow-frigate", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- crow_frigate_list_cameras ---
  server.tool(
    "crow_frigate_list_cameras",
    "List all configured Frigate cameras with detect/record state, resolution, and tracked objects. Reads /api/config.",
    {},
    async () => {
      try {
        const config = await frigateFetch("/api/config");
        const cameras = Object.entries(config.cameras || {}).map(([name, cam]) => ({
          name,
          enabled: cam.enabled !== false,
          detect: {
            enabled: cam.detect?.enabled !== false,
            width: cam.detect?.width || null,
            height: cam.detect?.height || null,
            fps: cam.detect?.fps || null,
          },
          record: {
            enabled: cam.record?.enabled !== false,
            retain_days: cam.record?.retain?.days || null,
          },
          tracked_objects: cam.objects?.track || [],
        }));
        return {
          content: [{
            type: "text",
            text: cameras.length > 0
              ? `${cameras.length} camera(s) configured:\n${JSON.stringify(cameras, null, 2)}`
              : "No cameras configured in Frigate. Edit config.yml to add RTSP/ONVIF sources.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- crow_frigate_list_events ---
  server.tool(
    "crow_frigate_list_events",
    "List Frigate detection events with optional filters. Cached for 30s at the HTTP layer so chatty polling does not drive Frigate to 100% CPU.",
    {
      camera: z.string().max(100).optional().describe("Filter to one camera name"),
      label: z.string().max(50).optional().describe("Filter to one label (e.g. 'person', 'car')"),
      after: z.string().max(40).optional().describe("ISO timestamp — events after this time"),
      before: z.string().max(40).optional().describe("ISO timestamp — events before this time"),
      has_clip: z.boolean().optional().describe("Only events with a recorded clip"),
      limit: z.number().int().min(1).max(200).optional().default(20).describe("Max results (default 20, hard ceiling 200)"),
    },
    async ({ camera, label, after, before, has_clip, limit }) => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (camera) params.set("cameras", camera);
        if (label) params.set("labels", label);
        const afterSec = isoToEpochSeconds(after);
        const beforeSec = isoToEpochSeconds(before);
        if (afterSec) params.set("after", String(afterSec));
        if (beforeSec) params.set("before", String(beforeSec));
        if (has_clip) params.set("has_clip", "1");

        const events = await frigateFetch(`/api/events?${params}`);
        const summaries = (Array.isArray(events) ? events : []).map(summarizeEvent);
        return {
          content: [{
            type: "text",
            text: summaries.length > 0
              ? `${summaries.length} event(s):\n${JSON.stringify(summaries, null, 2)}`
              : "No events match.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- crow_frigate_latest_by_label ---
  server.tool(
    "crow_frigate_latest_by_label",
    "Most recent Frigate event for a label, across all cameras (unless a camera is given).",
    {
      label: z.string().max(50).describe("Label name (e.g. 'person', 'car', 'dog')"),
      camera: z.string().max(100).optional().describe("Optional: restrict to one camera"),
    },
    async ({ label, camera }) => {
      try {
        const params = new URLSearchParams({ limit: "1", labels: label });
        if (camera) params.set("cameras", camera);
        const events = await frigateFetch(`/api/events?${params}`);
        const first = Array.isArray(events) ? events[0] : null;
        if (!first) {
          return {
            content: [{
              type: "text",
              text: `No ${label} events${camera ? ` on ${camera}` : ""} found.`,
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify(summarizeEvent(first), null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- crow_frigate_snapshot ---
  server.tool(
    "crow_frigate_snapshot",
    "Get a snapshot URL. Either `event_id` for that event's snapshot, or `camera` for the camera's latest frame.",
    {
      event_id: z.string().max(100).optional().describe("Frigate event ID"),
      camera: z.string().max(100).optional().describe("Camera name (latest.jpg)"),
    },
    async ({ event_id, camera }) => {
      if (!event_id && !camera) {
        return { content: [{ type: "text", text: "Provide event_id OR camera." }] };
      }
      const base = frigateBaseUrl();
      const url = event_id
        ? `${base}/api/events/${encodeURIComponent(event_id)}/snapshot.jpg`
        : `${base}/api/${encodeURIComponent(camera)}/latest.jpg`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            source: event_id ? "event" : "camera-latest",
            url,
            note: "Authenticated Frigate URL — usable from the Crow gateway or Nest panel iframe. Do NOT share off-tailnet; upload via crow_upload_file first if you need a public link.",
          }, null, 2),
        }],
      };
    },
  );

  // --- crow_frigate_clip_url ---
  server.tool(
    "crow_frigate_clip_url",
    "MP4 clip URL for a Frigate event. Event must have has_clip=true (check via list_events).",
    {
      event_id: z.string().max(100).describe("Frigate event ID"),
    },
    async ({ event_id }) => {
      const base = frigateBaseUrl();
      const url = `${base}/api/events/${encodeURIComponent(event_id)}/clip.mp4`;
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url,
            note: "Authenticated Frigate URL — usable from the Crow gateway. Do NOT share off-tailnet.",
          }, null, 2),
        }],
      };
    },
  );

  // --- crow_frigate_set_detect (destructive) ---
  server.tool(
    "crow_frigate_set_detect",
    "Enable/disable motion detection for a camera. DESTRUCTIVE: disabling detect also stops motion-triggered recording on that camera. Use sparingly.",
    {
      camera: z.string().max(100).describe("Camera name"),
      enabled: z.boolean().describe("true to enable, false to disable"),
      confirm: z.boolean().describe("Must pass true to actually apply (safety guardrail). Without this the call is a dry run."),
    },
    async ({ camera, enabled, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: "text",
            text: `DRY RUN — would set ${camera}.detect.enabled=${enabled}. Re-run with confirm=true to apply. Disabling detect also stops motion-triggered recording.`,
          }],
        };
      }
      try {
        // Frigate's runtime-config endpoint. `save=true` persists to disk.
        const params = new URLSearchParams({
          [`cameras.${camera}.detect.enabled`]: String(enabled),
          save: "true",
        });
        const result = await frigateFetch(`/api/config/set?${params}`, { method: "PUT", nocache: true });
        // drop cached responses so list_cameras shows the new state
        clearCache();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              camera,
              detect_enabled: enabled,
              frigate_response: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- crow_frigate_stats ---
  server.tool(
    "crow_frigate_stats",
    "Frigate system stats: version, detector inference time, CPU usage per process. Cached for 30s.",
    {},
    async () => {
      try {
        const stats = await frigateFetch("/api/stats");
        const summary = {
          version: stats.service?.version || "unknown",
          uptime_seconds: stats.service?.uptime || null,
          detectors: Object.entries(stats.detectors || {}).map(([name, d]) => ({
            name,
            inference_speed_ms: d.inference_speed ?? null,
            pid: d.pid || null,
          })),
          gpu_usages: stats.gpu_usages || null,
          process_count: Object.keys(stats.cpu_usages || {}).length,
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
