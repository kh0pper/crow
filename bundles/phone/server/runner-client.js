export function createRunnerClient({ baseUrl = "http://127.0.0.1:3065", secret, fetchImpl = fetch } = {}) {
  const h = { "Content-Type": "application/json", Authorization: `Bearer ${secret}` };
  async function req(method, path, body) {
    const r = await fetchImpl(baseUrl + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.detail || j.error || `runner ${r.status}`); e.status = r.status; throw e; }
    return j;
  }
  return {
    start: (call, token, model, ownerName, line) => req("POST", `/calls/${call.id}/start`, {
      call_id: call.id, token, owner_name: ownerName, line,
      plan: { business_name: call.business_name, number_e164: call.number_e164, goal: call.goal, limits: call.limits,
              shareable: call.shareable, language: call.language, notes: call.notes },
      model }),
    stop: (id) => req("POST", `/calls/${id}/stop`),
    farend: (id, text) => req("POST", `/calls/${id}/farend`, { text }),
    events: (id, since) => req("GET", `/calls/${id}/events?since=${since}`),
  };
}
