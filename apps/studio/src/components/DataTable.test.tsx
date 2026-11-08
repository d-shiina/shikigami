// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { type Column, DataTable, useTableView, ViewMenu } from "./DataTable";

type Row = { id: string; name: string; n: number };
const ROWS: Row[] = [
  { id: "a", name: "いちご", n: 3 },
  { id: "b", name: "あんず", n: 1 },
  { id: "c", name: "うめ", n: 2 },
  { id: "d", name: "えだまめ", n: 4 },
];
const COLUMNS: Column<Row>[] = [
  { id: "name", header: "名前", sortValue: (r) => r.name, cell: (r) => r.name },
  { id: "n", header: "数", width: "w-[80px]", sortValue: (r) => r.n, group: (r) => ({ key: r.n % 2 ? "odd" : "even", label: r.n % 2 ? "奇数" : "偶数" }), cell: (r) => r.n },
];

function Harness({ onPicked }: { onPicked?: (s: Set<string>) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const view = useTableView(COLUMNS, { initialSort: { column: "n", descending: false } });
  return (
    <>
      <ViewMenu view={view} />
      <DataTable
        columns={COLUMNS}
        view={view}
        rows={ROWS}
        total={10}
        rowKey={(r) => r.id}
        selected={picked}
        onSelect={(s) => {
          setPicked(s);
          onPicked?.(s);
        }}
      />
    </>
  );
}

const names = () => screen.getAllByRole("row").slice(1).map((r) => within(r).queryAllByRole("cell")[1]?.textContent);

describe("DataTable", () => {
  afterEach(cleanup);
  it("sorts by the column header, both ways", () => {
    render(<Harness />);
    expect(names()).toEqual(["あんず", "うめ", "いちご", "えだまめ"]);
    fireEvent.click(screen.getByRole("button", { name: "名前" }));
    expect(names()).toEqual(["あんず", "いちご", "うめ", "えだまめ"]);
    fireEvent.click(screen.getByRole("button", { name: "名前" }));
    expect(names()).toEqual(["えだまめ", "うめ", "いちご", "あんず"]);
  });

  it("picks a range with Shift", () => {
    let last = new Set<string>();
    render(<Harness onPicked={(s) => (last = s)} />);
    const boxes = screen.getAllByRole("checkbox", { name: "選択" });
    fireEvent.click(boxes[0]!);
    fireEvent.click(boxes[2]!, { shiftKey: true });
    expect([...last].sort()).toEqual(["a", "b", "c"]);
    expect(screen.getByText("3 件を選択中")).toBeTruthy();
  });

  it("says how many of all are shown", () => {
    render(<Harness />);
    expect(screen.getByText("10 件中 4 件")).toBeTruthy();
  });

  it("hides a column and groups from the view menu", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "表示" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "表示" })).getByRole("button", { name: "数" }));
    expect(screen.getByRole("button", { name: /奇数/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "数" }));
    expect(screen.queryByRole("columnheader", { name: /数/ })).toBeNull();
  });
});
