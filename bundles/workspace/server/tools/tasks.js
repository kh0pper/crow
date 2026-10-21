import { z } from "zod";
import { WsError } from "../result.js";
import { defineTools } from "./define.js";
import * as C from "../pim/caldav.js";

const ref = (list, uid) => `cal:${list.id}/${uid}`;

export const taskDefs = [
  { name: "ws_tasks_list_lists", description: "Task lists (Nextcloud Tasks) shared with Crow bot: id, name, writable.", schema: {},
    run: async (_a, c) => ({ lists: (await C.listTaskLists(c.getConfig())).map(({ id, name, writable }) => ({ id, name, writable })) }) },
  { name: "ws_task_create", description: "Add a task to a task list. due: YYYY-MM-DD, or a date-time with an offset (e.g. 2026-10-22T18:00:00-05:00); optional. Undoable.",
    schema: { list: z.string().min(1).max(200), summary: z.string().min(1).max(500), due: z.string().max(40).optional(), description: z.string().max(20000).optional() },
    run: async (a, c) => {
      const cfg = c.getConfig();
      const list = await C.resolveCollection(cfg, "cal", a.list, { component: "VTODO" });
      if (!list.writable) throw new WsError("read_only", `Crow bot can read "${list.name}" but not change it. Ask the owner to share it with edit rights.`);
      const { uid, ics } = C.buildTodo(a);
      const href = C.newObjectHref(cfg, list, uid, "ics");
      const version_id = await C.journaledWrite(cfg, { kind: "cal", ref: ref(list, uid), href, op: "create", before_text: null }, () => C.putChecked(cfg, href, ics, { ifNoneMatch: "*" }, "add the task"));
      return { uid, ref: ref(list, uid), list: list.name, version_id };
    } },
];
export const registerTasks = (server, ctx) => defineTools(server, ctx, taskDefs);
