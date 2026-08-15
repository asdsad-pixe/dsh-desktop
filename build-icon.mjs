// build-icon.mjs — 用官方 DeepSeek 鲸鱼 favicon 合成白底蓝鲸应用图标并栅格化
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(fileURLToPath(import.meta.url));
const favicon = readFileSync(path.join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "favicon.svg"), "utf8");

// 提取 <path ... d="..."/> 的 d 属性
const m = favicon.match(/<path[^>]*\bd="([^"]+)"/);
if (!m) throw new Error("favicon path not found");
const whalePath = m[1];

// DeepSeek 品牌蓝
const BLUE = "#4D6BFE";
const SIZE = 512;
const pad = 56;            // 四周留白
const scale = (SIZE - pad * 2) / 50; // 50 -> 400

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="115" fill="#ffffff"/>
  <g transform="translate(${pad},${pad}) scale(${scale})">
    <path d="${whalePath}" fill="${BLUE}"/>
  </g>
</svg>`;

writeFileSync(path.join(root, "assets", "icon-source.svg"), svg);
console.log("composed svg written");

// 用 sharp 栅格化（sharp 是 dsh 依赖，已随项目安装）
const sharp = require("sharp");
const input = Buffer.from(svg);
const out512 = path.join(root, "assets", "icon.png");
await sharp(input).png().resize(512, 512).toFile(out512);
await sharp(input).png().resize(256, 256).toFile(path.join(root, "assets", "icon-256.png"));
console.log("png written:", out512);

// 校验：背景应是白色、中心应是蓝色
const { data, info } = await sharp(out512).raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => {
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
};
console.log("corner px (should be white):", px(2, 2));
console.log("center px (should be blue):", px(256, 256));
