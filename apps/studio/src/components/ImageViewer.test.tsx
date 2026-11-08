// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setPreviewReader } from "../lib/preview";
import { closeImage, ImageViewerHost, openImage, openImageValue } from "./ImageViewer";

afterEach(() => {
  act(() => closeImage());
  cleanup();
});

const PNG = `data:image/png;base64,${"iVBORw0KGgo".padEnd(80, "A")}`;

describe("ImageViewer", () => {
  it("opens over the app and closes on Esc", () => {
    render(<ImageViewerHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => openImage({ src: PNG, title: "screen.png", width: 1920, height: 1080, bytes: 2048 }));
    expect(screen.getByRole("dialog", { name: "screen.png" })).toBeTruthy();
    expect(screen.getByText("1920 × 1080 · 2.0 KB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "画面に合わせる" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "等倍" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the picture a value names: its data, or a path to an image", async () => {
    render(<ImageViewerHost />);
    expect(openImageValue("合計 1,200", undefined)).toBe(false);
    expect(openImageValue("output/report.xlsx", undefined)).toBe(false);

    act(() => void openImageValue(PNG, undefined));
    expect(screen.getByRole("dialog", { name: "画像のデータ" })).toBeTruthy();
    act(() => closeImage());

    const asked: string[] = [];
    setPreviewReader(async (_id, path) => {
      asked.push(path);
      return { kind: "image", mime: "image/png", data: "AAAA", bytes: 3 };
    });
    await act(async () => void openImageValue("output/shot.png", "flow-1"));
    expect(screen.getByRole("dialog", { name: "shot.png" })).toBeTruthy();
    expect(asked).toEqual(["output/shot.png"]);
    // Hidden until it has loaded and been fitted.
    expect(document.querySelector('img[alt="shot.png"]')?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("keeps keys from the editor under it while open", () => {
    const seen: string[] = [];
    const editor = (e: KeyboardEvent) => seen.push(e.key);
    window.addEventListener("keydown", editor);
    render(<ImageViewerHost />);
    act(() => openImage({ src: PNG, title: "screen.png" }));
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "x", ctrlKey: true });
    expect(seen).toEqual([]);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(seen).toEqual(["Delete"]);
    window.removeEventListener("keydown", editor);
  });

  it("ignores zooming before the picture has loaded, so it still opens fitted", () => {
    render(<ImageViewerHost />);
    act(() => openImage({ src: "", title: "shot.png", load: () => new Promise(() => {}) }));
    fireEvent.click(screen.getByRole("button", { name: "拡大（+）" }));
    expect(screen.getByRole("button", { name: "画面に合わせる" }).className).toContain("bg-sheet");
  });
});
