/** Latency arithmetic (spec §9, ruling R8). Input-side mic latency is NOT included (stated bias). */
export function playStartPerfTime({ nowPerf, ctxCurrentTime, startWhen, outputLatency = 0 }) {
  return Math.round(nowPerf + (startWhen - ctxCurrentTime) * 1000 + outputLatency * 1000);
}
export function e2eMs({ speechEndAt, playAt }) {
  if (speechEndAt == null || playAt == null) return null;
  return Math.round(playAt - speechEndAt);
}
