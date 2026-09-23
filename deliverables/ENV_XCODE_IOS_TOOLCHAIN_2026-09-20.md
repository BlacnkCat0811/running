# 本机 Xcode / Simulator 工具链体检与修复

日期：2026-09-20
范围：`/Users/tp/running` 的 iOS 本机开发环境（非产品代码变更）
结论：Xcode 与模拟器**确实都已安装且可用**；真正的问题不是"没装"，而是
**Xcode 装错了位置（`~/Downloads`），导致工具链指向断链**，并把两个潜伏的 shell 缺陷暴露出来。

---

## 一、体检结果（修复前）

| 层次 | 实测 | 判定 |
| --- | --- | --- |
| Xcode | 26.6 (Build 17F113)，位于 `~/Downloads/Xcode.app`（4.8 GB） | 已安装，**位置不对** |
| 活动工具链 | `xcode-select -p` → `/Library/Developer/CommandLineTools` | **断链** |
| CoreSimulator | `/Library/Developer/PrivateFrameworks/CoreSimulator.framework`（含 `simctl`） | 就绪 |
| 模拟器运行时 | iOS 26.5 (26.5 - 23F77)，已挂载于 `/Library/Developer/CoreSimulator/Volumes/iOS_23F77` | 就绪 |
| 模拟器设备 | 12 台（iPhone 17 全系 + iPad 全系 + `RAI iPhone 12 Pro Max`），全部 Shutdown | 缺少验收设备 |
| SDK | `iPhoneOS26.5.sdk` / iPhoneOS.platform 齐备；Swift 6.3.3 | 就绪 |

主机环境：macOS 26.7 (Build 25G229)，Intel Core i7-12700H，x86_64，VMware 虚拟机。
Xcode 签名为 `com.apple.dt.Xcode` / Apple Software Signing，`spctl` 判定 `accepted`，
无 `com.apple.quarantine` 隔离属性；universal 二进制（x86_64 + arm64），宿主原生跑 x86_64 切片。

**断链的直接后果**：裸 `xcodebuild` / `xcrun simctl` 失败（`exit 72`，
`unable to find utility "simctl"`）。设置
`DEVELOPER_DIR=~/Downloads/Xcode.app/Contents/Developer` 后两者均立即正常——
说明 Xcode 本身完好，纯粹是"指向"问题。

---

## 二、同时发现的两个既有缺陷

### P1-1 `apps/ios/tests/run-ios-gates.sh:42` —— 全角括号吞掉变量名

```bash
echo "⚠️  跳过 iOS 门禁：找不到 Xcode（$developer_dir）。"
```

`$developer_dir` 后面紧跟**全角右括号** `）`，macOS 自带的 bash 3.2.57 在 UTF-8 locale 下
把该多字节字符当作变量名的一部分，于是查的是 `developer_dir）` 而不是 `developer_dir`；
脚本开头是 `set -uo pipefail`，因此报错退出：

```
apps/ios/tests/run-ios-gates.sh: line 42: developer_dir）: unbound variable
```

最小复现（与沙箱无关，PATH 上的 bash 与 `/bin/bash` 表现一致）：

```bash
bash -c 'set -u; v=/some/path; echo "找不到 Xcode（$v）。"'   # → bash: v）: unbound variable
bash -c 'set -u; v=/some/path; echo "找不到 Xcode（${v}）。"'  # → 正常输出
```

**影响**：该分支只在 `/Applications/Xcode.app/Contents/Developer` 不存在时才进入。
Xcode 一直待在 `~/Downloads`，而这个路径恰好不存在 → `npm run test:ios` 在本机
**不是**按设计"显式跳过并 exit 0"，而是**直接报错退出**；同时由于这是门禁脚本，
它自己注释里最担心的"静默/异常通过"以另一种形式成立了：iOS 门禁在本机从未真正跑过。

### P1-2 `deploy/upgrade.sh:88` —— 同型缺陷，且更危险

```bash
echo "错误：备份失败（HTTP $backup_code），中止发布" >&2
```

同样在 `$backup_code` 后紧跟 `）`，而该脚本开头是 `set -euo pipefail`。
一旦备份接口返回非 200/201 走进这个分支，脚本会崩在**错误信息自身**上，
真实的 HTTP 状态码不会被打出来——正是最需要诊断信息的那一刻丢掉了诊断信息。

---

## 三、已执行的修复

| # | 动作 | 说明 |
| --- | --- | --- |
| 1 | `mv ~/Downloads/Xcode.app /Applications/Xcode.app` | 同为 `/System/Volumes/Data`，`/Applications` 组可写（用户属 `admin`），无需 sudo，原子重命名 |
| 2 | `run-ios-gates.sh:42` → `${developer_dir}` | 修 P1-1 |
| 3 | `deploy/upgrade.sh:88` → `${backup_code}` | 修 P1-2 |
| 4 | 创建验收模拟器 `RAI Technology Acceptance` | `iPhone-12-Pro-Max` + `iOS-26-5`，UDID `A2320B93-3FFE-4AF9-A480-616511395C53` |
| 5 | 对齐 `apps/ios/README.md` | 修掉三处已失效的环境描述（见下） |

Xcode 搬家后，`xcode-select -p` **自动**解析为 `/Applications/Xcode.app/Contents/Developer`
（`/var/db/xcode_select_link` 不存在时 xcode-select 会回落到 `/Applications` 下搜索 Xcode），
裸 `xcrun` / `xcodebuild` 从此可直接使用，无需再手工 `export DEVELOPER_DIR`，也不需要 sudo。

### 新设备为什么必须叫这个名字

`apps/ios/tests/run-visual-tests.sh:11` 按**字面名**查找模拟器：

```bash
... next((d["udid"] for a in ... if d["name"] == "RAI Technology Acceptance"), "")
```

找不到就走到 `:13` 的 `exit 1`。仓库里 `apps/ios/README.md`、
`design/acceptance/2026-09-17-field-coverage/screenshot-manifest.json`（24 处）也都以
这个名字记录历史验收。本机原有的是自建的 `RAI iPhone 12 Pro Max`，名字对不上，**未被删除**，
保留原样（它是文件，删除需另行确认）。

### 文档对齐（`apps/ios/README.md`）

| 位置 | 原描述 | 改后 |
| --- | --- | --- |
| L40 | "这台虚拟机的 Xcode 还缺 iOS 平台组件" | 标注已装并保留补装命令 |
| L84 后 | （无） | 补上验收模拟器的 `simctl create` 命令，`run-visual-tests.sh:13` 只说要建、没给怎么建 |
| L98 | "Xcode 26.5 的 SDK 是 iOS 26.5" | 改为 Xcode 26.6 (17F113) |
| L99 | "需要先下载 iOS 26.5 平台（约 10.6 GB）" | 标注已下载、运行时已挂载，并记录 Xcode 实际位置 |

---

## 四、验收证据

```
$ unset DEVELOPER_DIR; xcode-select -p
/Applications/Xcode.app/Contents/Developer

$ xcodebuild -version
Xcode 26.6
Build version 17F113

$ xcrun simctl list runtimes
== Runtimes ==
iOS 26.5 (26.5 - 23F77) - com.apple.CoreSimulator.SimRuntime.iOS-26-5

$ xcrun simctl boot A2320B93-… && xcrun simctl bootstatus A2320B93-… -b
… Status=4294967295, isTerminal=YES, Elapsed=03:36.  Finished
# 最终状态：RAI Technology Acceptance (A2320B93-…) (Booted)   ← 运行时可实际启动

$ DEVELOPER_DIR=/tmp/nonexistent bash apps/ios/tests/run-ios-gates.sh
⚠️  跳过 iOS 门禁：找不到 Xcode（/tmp/nonexistent）。   ← 缺失分支修复后按设计显式跳过
    本次没有检查任何 iOS 源码。
退出码: 0

$ npm run test:ios
… 35 store regression checks passed
  Technology presentation: 45 checks passed
  Technology color tokens: 24 foreground/background pairs meet the 4.5:1 project target
  Field coverage: 23/27 MobileTodayResponse fields have a Technology display slot …
  iOS 门禁通过（类型检查 + 纯逻辑回归）
==pipestatus=0 0==
```

`bash -n` 对两个改动脚本均通过。全仓 `*.sh` 再无 `$变量` 紧跟非 ASCII 字符的写法
（修复前 2 处，修复后 0 处）。

---

## 五、回滚方案

| 变更 | 回滚 |
| --- | --- |
| Xcode 位置 | `mv /Applications/Xcode.app ~/Downloads/Xcode.app`（同卷重命名，瞬时） |
| 两个 shell 文件 | `git checkout -- apps/ios/tests/run-ios-gates.sh deploy/upgrade.sh` |
| README | `git checkout -- apps/ios/README.md` |
| 验收模拟器 | `xcrun simctl delete A2320B93-3FFE-4AF9-A480-616511395C53` |

系统级无写操作：模拟器运行时挂载、CoreSimulator 框架、pkg 收据均未改动。

---

## 六、遗留与后续建议

1. **`run-ios-gates.sh:47` 的注释已过时**：它写"`xcode-select -p` 在本机指向
   CommandLineTools（黑苹果上的既有配置）"。搬家后不再成立。代码里显式钉 `DEVELOPER_DIR`
   这一防御性做法**应当保留**（CI / 其他机器仍可能需要），但注释理由需要重写。
   本次未改，避免与上面的修复混在一个提交里。
2. **门禁的"跳过即通过"语义**：`run-ios-gates.sh` 找不到 Xcode 时 `exit 0`，
   `npm run test:all` 会因此整体变绿而实际未检查任何 iOS 源码。脚本自己的注释把
   这种情形称为"比没有门禁更危险"。建议改成非零退出或至少让 `test:all` 显式感知
   （需你决定是否纳入范围）。
3. **重复设备**：`RAI iPhone 12 Pro Max` 与新建的验收设备同为 iPhone 12 Pro Max 设备类型，
   是否删除请确认。
4. **验收链路的下一步**：`run-visual-tests.sh` 还依赖 `var/rai.sqlite` 与
   `apps/ios/Pods`（高德 SDK）。模拟器本身已验证可启动，但完整视觉验收尚未跑过，
   需要真库副本与 `pod install` 就位。
5. **未提交改动**：工作区里 `apps/ios/Podfile.lock`、`apps/ios/RAI.xcodeproj/project.pbxproj`、
   `package-lock.json` 的改动在本轮之前就已存在，本次未触碰。
