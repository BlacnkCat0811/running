#!/usr/bin/env node
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.RAI_ALLOW_LAN_DEV = "1";

const lanAddresses = [];
for (const [iface, addrs] of Object.entries(networkInterfaces())) {
  for (const addr of addrs ?? []) {
    const ipv4 = addr.family === "IPv4" || addr.family === 4;
    if (!ipv4 || addr.internal) continue;
    lanAddresses.push({ iface, address: addr.address });
  }
}

console.log("RAI iPhone 调试服务器");
console.log("");
if (lanAddresses.length === 0) {
  console.log("没有发现局域网 IPv4，检查 VMware 网卡。");
} else {
  console.log("在 iPhone 12 Pro Max 的 RAI App 里填写：");
  for (const item of lanAddresses) {
    console.log(`  http://${item.address}:5173    [${item.iface}]`);
  }
}
console.log("");
console.log("如果手机打不开这个地址：把 VMware 网卡改成 Bridged（桥接），");
console.log("让 iPhone 和虚拟机在同一 Wi-Fi 网段。NAT（现在常见是 192.168.126.x）");
console.log("下手机通常访问不到虚拟机。");
console.log("");

const child = spawn(
  "npm",
  [
    "exec",
    "--",
    "concurrently",
    "-n",
    "api,web",
    "-c",
    "green,cyan",
    "npm run dev -w @rai/api",
    "npm run dev:lan -w @rai/web"
  ],
  {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit"
  }
);

child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
