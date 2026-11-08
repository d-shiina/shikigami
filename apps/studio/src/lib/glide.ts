/**
 * The chart's view gliding to where the run is.
 *
 * Following a run used to start a fresh 250 ms transition for every step:
 * each one began from a standstill and, by d3's default, zoomed out and back
 * in on the way, and a run whose steps came faster than that broke each glide
 * off and started the next from rest, so the view jerked along. Here the view
 * is a critically damped spring: a new place only moves its target, the view
 * keeps the speed it has and eases in without overshooting, and the motion is
 * a straight pan, at the zoom it ends at.
 */

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Glide {
  view: View;
  speed: View;
}

/** About how long (s) the view takes to get most of the way; it settles in roughly three times this. */
export const GLIDE_TIME = 0.16;
/** Closer than this (screen px, and as much zoom) and nearly still, the view is there. */
const SETTLE = 0.5;

/** One step of a critically damped spring towards `to` (Game Programming Gems 4, 1.10). */
function damp(from: number, to: number, speed: number, dt: number): [number, number] {
  const omega = 2 / GLIDE_TIME;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = from - to;
  const temp = (speed + omega * change) * dt;
  return [to + (change + temp) * decay, (speed - omega * temp) * decay];
}

/** Where the view is `dt` seconds on, and whether it has arrived. */
export function glideStep(glide: Glide, to: View, dt: number): { glide: Glide; done: boolean } {
  // A long frame (the window hidden, a busy moment) must not throw the spring.
  const step = Math.min(Math.max(dt, 0), 0.1);
  const [x, vx] = damp(glide.view.x, to.x, glide.speed.x, step);
  const [y, vy] = damp(glide.view.y, to.y, glide.speed.y, step);
  const [zoom, vz] = damp(glide.view.zoom, to.zoom, glide.speed.zoom, step);
  const done =
    Math.abs(x - to.x) < SETTLE &&
    Math.abs(y - to.y) < SETTLE &&
    Math.abs(zoom - to.zoom) < SETTLE / 1000 &&
    Math.abs(vx) < SETTLE * 10 &&
    Math.abs(vy) < SETTLE * 10;
  if (done) return { glide: { view: to, speed: { x: 0, y: 0, zoom: 0 } }, done };
  return { glide: { view: { x, y, zoom }, speed: { x: vx, y: vy, zoom: vz } }, done };
}

/** Whether the view was moved by something else than the glide (a drag, the wheel, a fit). */
export function movedAway(now: View, set: View): boolean {
  return Math.abs(now.x - set.x) > 1 || Math.abs(now.y - set.y) > 1 || Math.abs(now.zoom - set.zoom) > 1e-4;
}

export interface Glider {
  /** Glide to `to`, from where the view is now, keeping the speed of a glide on the way. */
  to(to: View): void;
  /** Where the view is going, while it glides. */
  target(): View | null;
  stop(): void;
}

/** Drives the view of one chart: `get`/`set` read and place it, once a frame. */
export function makeGlider(get: () => View, set: (view: View) => void, frame = requestAnimationFrame, cancel = cancelAnimationFrame): Glider {
  let glide: Glide | null = null;
  let goal: View | null = null;
  let last = 0;
  let handle = 0;
  const stop = () => {
    if (handle) cancel(handle);
    handle = 0;
    glide = null;
    goal = null;
  };
  const tick = (time: number) => {
    handle = 0;
    if (!glide || !goal) return;
    // Someone took the view: the glide gives way.
    if (movedAway(get(), glide.view)) return stop();
    const next = glideStep(glide, goal, (time - last) / 1000);
    last = time;
    glide = next.glide;
    set(glide.view);
    if (next.done) return stop();
    handle = frame(tick);
  };
  return {
    to(to) {
      const now = get();
      // A glide still on its way keeps its speed; one that was stopped or overtaken starts still.
      glide = glide && !movedAway(now, glide.view) ? glide : { view: now, speed: { x: 0, y: 0, zoom: 0 } };
      goal = to;
      if (!handle) {
        last = performance.now();
        handle = frame(tick);
      }
    },
    target: () => goal,
    stop,
  };
}
