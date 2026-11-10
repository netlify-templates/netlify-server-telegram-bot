import type { RunEvent } from "./queue.ts";

// Progress of the runs executing on this instance, kept in memory for the
// console's stream. Another instance's stream doesn't see these; it polls the
// database and shows the finished answer instead.

export interface StampedEvent {
  id: string;
  event: RunEvent;
}

type Listener = (e: StampedEvent) => void;

interface Buffer {
  attempt: number;
  next: number;
  events: StampedEvent[];
  listeners: Set<Listener>;
  at: number;
}

const MAX_EVENTS = 500;
const buffers = new Map<number, Buffer>();

export function publish(runId: number, attempt: number, event: RunEvent): void {
  let b = buffers.get(runId);
  if (!b || b.attempt !== attempt) {
    b = { attempt, next: 1, events: [], listeners: b?.listeners ?? new Set(), at: Date.now() };
    buffers.set(runId, b);
  }
  b.at = Date.now();
  const stamped = { id: `${attempt}.${b.next++}`, event };
  b.events.push(stamped);
  if (b.events.length > MAX_EVENTS) b.events.shift();
  for (const l of b.listeners) l(stamped);
}

// Runs that went quiet with nobody watching are forgotten after 10 minutes.
setInterval(() => {
  for (const [runId, b] of buffers) if (b.listeners.size === 0 && Date.now() - b.at > 10 * 60_000) buffers.delete(runId);
}, 60_000).unref();

/** Replays what this instance has after `lastId`, then follows new events. */
export function subscribe(runId: number, lastId: string | undefined, listener: Listener): () => void {
  let b = buffers.get(runId);
  if (!b) {
    b = { attempt: 0, next: 1, events: [], listeners: new Set(), at: Date.now() };
    buffers.set(runId, b);
  }
  const start = lastId ? b.events.findIndex((e) => e.id === lastId) + 1 : 0;
  for (const e of b.events.slice(start)) listener(e);
  b.listeners.add(listener);
  const mine = b;
  return () => mine.listeners.delete(listener);
}
