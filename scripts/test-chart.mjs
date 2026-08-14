if (!process.env.VELTR_TELEGRAM_BOT_TOKEN) throw new Error("VELTR_TELEGRAM_BOT_TOKEN is not set — run with: node --env-file=.env.local " + import.meta.filename);
// End-to-end check: correct pool -> candles -> QuickChart PNG -> Telegram.
const GT = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const TG = process.env.VELTR_TELEGRAM_BOT_TOKEN;
const CHAT = process.env.VELTR_TEST_CHAT_ID;

const pools = await (await fetch(`${GT}/tokens/${NVDA}/pools`)).json();
const target = NVDA.toLowerCase();

const oriented = (pools.data ?? []).filter((p) =>
  (p.relationships?.base_token?.data?.id ?? "").toLowerCase().endsWith(target)
);
oriented.sort(
  (a, b) => Number(b.attributes?.reserve_in_usd ?? 0) - Number(a.attributes?.reserve_in_usd ?? 0)
);

const pool = oriented[0];
console.log("chosen pool :", pool?.attributes?.name, "| base price $" + pool?.attributes?.base_token_price_usd);
console.log("address     :", pool?.attributes?.address);

const ohlcv = await (
  await fetch(`${GT}/pools/${pool.attributes.address}/ohlcv/hour?aggregate=1&limit=72`)
).json();
const list = (ohlcv?.data?.attributes?.ohlcv_list ?? []).sort((a, b) => a[0] - b[0]);
console.log("candles     :", list.length);
console.log("price range : $" + Math.min(...list.map((c) => c[3])).toFixed(2) + " – $" + Math.max(...list.map((c) => c[2])).toFixed(2));

const config = {
  type: "line",
  data: {
    datasets: [
      {
        label: "NVDA / USD",
        data: list.map((c) => ({ x: new Date(c[0] * 1000).toISOString(), y: Number(c[4].toFixed(6)) })),
        borderColor: "#1f1a14",
        backgroundColor: "rgba(31,26,20,0.08)",
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.15,
      },
    ],
  },
  options: {
    plugins: { legend: { display: false } },
    scales: {
      xAxes: [{ type: "time", time: { unit: "hour" }, gridLines: { display: false }, ticks: { fontColor: "#8b7c68", maxTicksLimit: 6 } }],
      yAxes: [{ gridLines: { color: "#e3d7c1" }, ticks: { fontColor: "#8b7c68" } }],
    },
  },
};

const url = `https://quickchart.io/chart?${new URLSearchParams({
  c: JSON.stringify(config),
  w: "800",
  h: "400",
  bkg: "#fdfbf5",
  devicePixelRatio: "2",
}).toString()}`;

console.log("chart url   :", url.length, "chars");

const probe = await fetch(url);
console.log("quickchart  :", probe.status, probe.headers.get("content-type"));

const last = list[list.length - 1][4];
const first = list[0][4];
const caption = `NVDA · last ${list.length}h\nlast $${last.toFixed(2)}  ${last >= first ? "+" : ""}${(((last / first) - 1) * 100).toFixed(2)}%`;

const send = await (
  await fetch(`https://api.telegram.org/bot${TG}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: CHAT, photo: url, caption }),
  })
).json();

console.log("telegram    :", send.ok ? `sent, message_id ${send.result.message_id}` : send.description);
