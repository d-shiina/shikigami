import { describe, expect, it } from "vitest";
import { glideStep, makeGlider, type Glide, type View } from "./glide";

const still = (view: View): Glide => ({ view, speed: { x: 0, y: 0, zoom: 0 } });

/** Runs a glider on a fake clock of 60 frames a second. */
function rig(start: View) {
  let view = start;
  let queued: ((t: number) => void) | null = null;
  let time = 0;
  const glider = makeGlider(
    () => view,
    (next) => (view = next),
    (fn) => ((queued = fn), 1),
    () => (queued = null),
  );
  const frames = (n: number) => {
    const seen: View[] = [];
    for (let i = 0; i < n && queued; i++) {
      const fn = queued;
      queued = null;
      time += 1000 / 60;
      fn(performance.now() + time);
      seen.push(view);
    }
    return seen;
  };
  return { glider, frames, view: () => view, setView: (v: View) => (view = v), running: () => queued !== null };
}

describe("glideStep", () => {
  it("arrives without overshooting, at a straight pan with the zoom kept", () => {
    const to = { x: -800, y: -400, zoom: 1 };
    let glide = still({ x: 0, y: 0, zoom: 1 });
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) {
      const next = glideStep(glide, to, 1 / 60);
      glide = next.glide;
      xs.push(glide.view.x);
      // A pan stays at its zoom: no zooming out and back in on the way.
      expect(glide.view.zoom).toBe(1);
      // Along the line from the start to the end.
      expect(glide.view.y / glide.view.x).toBeCloseTo(0.5, 5);
      if (next.done) break;
    }
    expect(glide.view).toEqual(to);
    // Monotonic: never past the target and back.
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeLessThanOrEqual(xs[i - 1]!);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-800);
  });

  it("does not jump on a long frame", () => {
    const { glide } = glideStep(still({ x: 0, y: 0, zoom: 1 }), { x: -1000, y: 0, zoom: 1 }, 5);
    expect(glide.view.x).toBeGreaterThan(-1000);
  });
});

describe("makeGlider", () => {
  it("keeps its speed when a new place comes on the way", () => {
    const r = rig({ x: 0, y: 0, zoom: 1 });
    r.glider.to({ x: -600, y: 0, zoom: 1 });
    const before = r.frames(6);
    const speed = before.at(-1)!.x - before.at(-2)!.x;
    r.glider.to({ x: -1200, y: 0, zoom: 1 });
    const after = r.frames(2);
    // No stop to restart from rest: the next frame moves at least as fast.
    expect(after[0]!.x - before.at(-1)!.x).toBeLessThanOrEqual(speed);
    r.frames(200);
    expect(r.view().x).toBe(-1200);
    expect(r.running()).toBe(false);
  });

  it("gives way when the person moves the view", () => {
    const r = rig({ x: 0, y: 0, zoom: 1 });
    r.glider.to({ x: -600, y: 0, zoom: 1 });
    r.frames(3);
    r.setView({ x: 50, y: 50, zoom: 1 });
    r.frames(1);
    expect(r.view()).toEqual({ x: 50, y: 50, zoom: 1 });
    expect(r.running()).toBe(false);
    expect(r.glider.target()).toBeNull();
  });
});
