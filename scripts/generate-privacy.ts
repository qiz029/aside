import { writeFile } from "node:fs/promises";
import { privacyCopy } from "../mobile/src/privacy-policy.js";
const escape = (text: string) =>
  text.replace(
    /[&<>\"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const body = Object.entries(privacyCopy)
  .map(
    ([language, sections]) =>
      `<section lang="${language === "zh" ? "zh-CN" : "en"}">${sections.map(([title, text], i) => `<${i ? "h2" : "h1"}>${escape(title)}</${i ? "h2" : "h1"}><p>${escape(text)}</p>`).join("\n")}</section>`,
  )
  .join("<hr>");
await writeFile(
  "frontend/public/privacy.html",
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aside — Privacy</title><style>body{max-width:760px;margin:40px auto;padding:0 24px;font:17px/1.7 system-ui;background:#f6f1e8;color:#2b2520}h1{font-size:30px}h2{font-size:22px;margin-top:28px}a{color:#334d3d}hr{margin:48px 0;border:0;border-top:1px solid #d9d0c4}</style></head><body><a href="/">Aside</a>${body}<p><a href="https://github.com/qiz029/aside/issues">Support / 支持</a></p></body></html>\n`,
);
