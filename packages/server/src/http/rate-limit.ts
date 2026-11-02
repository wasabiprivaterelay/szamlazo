/**
 * How often one client may do something, counted in memory. Right for one
 * server process: a restart forgets the counts, which only ever lets someone
 * through, never locks anyone out.
 */
const MAX_CLIENTS = 10_000;

export type Limit = { max: number; perMs: number };

export function rateLimiter(limit: Limit, now: () => number = Date.now) {
  const seen = new Map<string, number[]>();

  return (client: string): boolean => {
    const at = now();
    const times = (seen.get(client) ?? []).filter((time) => time > at - limit.perMs);
    if (times.length >= limit.max) {
      seen.set(client, times);
      return false;
    }
    times.push(at);
    seen.set(client, times);
    // Clients who have gone quiet are forgotten, so the map cannot grow without end.
    if (seen.size > MAX_CLIENTS) {
      for (const [key, list] of seen) if (list.every((time) => time <= at - limit.perMs)) seen.delete(key);
      // Still too many (many addresses at once): the oldest are dropped, so
      // memory and the cost of this sweep stay bounded whatever arrives.
      for (const key of seen.keys()) {
        if (seen.size <= MAX_CLIENTS / 2) break;
        seen.delete(key);
      }
    }
    return true;
  };
}
