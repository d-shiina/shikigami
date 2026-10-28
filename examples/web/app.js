// Shared state for the demo site (kept per browser tab session).
const ORDERS = [
  { no: "A-1001", customer: "青葉商店", item: "和紙ノート", amount: 12000, status: "未処理" },
  { no: "A-1002", customer: "稲荷堂", item: "筆ペン", amount: 4800, status: "出荷済み" },
  { no: "A-1003", customer: "月見屋", item: "朱肉セット", amount: 23500, status: "未処理" },
  { no: "A-1004", customer: "白狐書房", item: "御朱印帳", amount: 9600, status: "未処理" },
  { no: "A-1005", customer: "青葉商店", item: "和紙封筒", amount: 3200, status: "出荷済み" },
];
const STOCK = [
  { code: "P-01", name: "和紙ノート", qty: 42 },
  { code: "P-02", name: "筆ペン", qty: 0 },
  { code: "P-03", name: "朱肉セット", qty: 7 },
  { code: "P-04", name: "御朱印帳", qty: 3 },
  { code: "P-05", name: "和紙封筒", qty: 120 },
];

function loadOrders() {
  const saved = sessionStorage.getItem("orders");
  return saved ? JSON.parse(saved) : ORDERS.map((o) => ({ ...o }));
}

function saveOrders(orders) {
  sessionStorage.setItem("orders", JSON.stringify(orders));
}

function requireLogin() {
  const user = sessionStorage.getItem("user");
  if (!user) {
    location.href = "index.html";
    return null;
  }
  return user;
}

function yen(n) {
  return n.toLocaleString("ja-JP");
}
