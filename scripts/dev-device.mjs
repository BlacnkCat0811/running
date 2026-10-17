#!/usr/bin/env node
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.RAI_API_PORT ?? "8787";
// 原生客户端不发 Origin；未设 RAI_API_TOKEN 时 API 只信任 loopback Host
// （local-request-security.ts:145-152）⇒ 真机直连局域网必须带令牌，否则一律 403。
const devToken = process.env.RAI_API_TOKEN?.trim() || "rai-local-dev";

const lanAddresses = [];
for (const [iface, addrs] of Object.entries(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    const ipv4 = addr.family === "IPv4" || addr.family === 4;
    if (!ipv4 || addr.internal) continue;
    lanAddresses.push({ iface, address: addr.address });
  }
}

function isNatAddress(address) {
  return address.startsWith("192.168.126.");
}

function ifaceRank(item) {
  if (isNatAddress(item.address)) return 100;
  const iface = item.iface.toLowerCase();
  if (iface === "en0") return 0;
  if (iface.includes("wi-fi") || iface.includes("wifi")) return 1;
  if (/^en\d+$/.test(iface)) return 2;
  return 10;
}

lanAddresses.sort((left, right) => ifaceRank(left) - ifaceRank(right) || left.address.localeCompare(right.address));

console.log("RAI iPhone 直连调试（只启动 API）");
console.log("");
if (lanAddresses.length === 0) {
  console.log("没有发现局域网 IPv4，检查网络连接。");
} else {
  const preferred = lanAddresses[0];
  console.log(`在 App 里填写  http://${preferred.address}:${apiPort}`);
  if (isNatAddress(preferred.address)) {
    console.log("警告：这是 VMware NAT（192.168.126.x），手机通常访问不到。请改成 Bridged（桥接）。");
  }
  const extras = lanAddresses.slice(1);
  if (extras.length) {
    console.log("其他地址：");
    for (const item of extras) {
      const natNote = isNatAddress(item.address) ? "  NAT，手机通常不可达" : "";
      console.log(`  http://${item.address}:${apiPort}    [${item.iface}]${natNote}`);
    }
  }
}
console.log(`访问令牌（API Token）填：${devToken}`);
console.log("");
console.log("如果手机打不开这个地址：把 VMware 网卡改成 Bridged（桥接），");
console.log("让 iPhone 和虚拟机在同一 Wi-Fi 网段。NAT（现在常见是 192.168.126.x）");
console.log("下手机通常访问不到虚拟机。");
console.log("");

let advertiser = null;
if (process.platform === "darwin" && lanAddresses.length > 0) {
  advertiser = spawn("dns-sd", ["-R", "RAI", "_rai._tcp", "local.", apiPort], {
    stdio: "ignore"
  });
  advertiser.on("error", () => {});
}

// 只起 API：Web SPA 已退役，vite 代理（5173）不再存在。
const child = spawn("npm", ["run", "dev:api"], {
  cwd: projectRoot,
  env: { ...process.env, RAI_API_HOST: "0.0.0.0", RAI_API_TOKEN: devToken },
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (advertiser && !advertiser.killed) advertiser.kill();
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
