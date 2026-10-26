# 本轮实际命令、环境与退出码

所有命令通过外部 `/usr/bin/time -l` 测量，完整 argv 和环境覆盖值见 commands.json。
下文 cwd、临时副本和 DerivedData 绝对路径是 2026-10-26 执行环境的只读记录，归档后不可直接复用；
复现应从仓库根目录使用相同命令并映射到新的隔离临时目录。

## typecheck

cwd: `/Users/ta/running`；exit 0；26.144 s

```sh
 npm run typecheck
```

## node-l4

cwd: `/Users/ta/running`；exit 0；1346.007 s

```sh
RAI_TEST_CONCURRENCY=2 npm test
```

## docs

cwd: `/Users/ta/running`；exit 0；1.688 s

```sh
 npm run check:docs
```

## doc-refs

cwd: `/Users/ta/running`；exit 0；1.524 s

```sh
 npm run check:doc-refs
```

## acceptance

cwd: `/Users/ta/running`；exit 0；4.705 s

```sh
 npm run check:acceptance-matrix
```

## scripts

cwd: `/Users/ta/running`；exit 0；1.370 s

```sh
 npm run check:scripts
```

## boundaries

cwd: `/Users/ta/running`；exit 0；1.182 s

```sh
 npm run check:package-boundaries
```

## boundaries-self

cwd: `/Users/ta/running`；exit 0；0.925 s

```sh
 npm run check:package-boundaries -- --self-test
```

## single-writer

cwd: `/Users/ta/running`；exit 0；2.921 s

```sh
 npm run check:training-plan-single-writer
```

## blob

cwd: `/Users/ta/running`；exit 0；2.910 s

```sh
 node scripts/check-blob-size.mjs
```

## model-boundaries

cwd: `/Users/ta/running`；exit 0；24.521 s

```sh
 npm run review:model-boundaries
```

## smoke

cwd: `/Users/ta/running`；exit 0；3.185 s

```sh
 npm run smoke:api
```

## ml-check

cwd: `/Users/ta/running`；exit 0；7.914 s

```sh
PYTHONDONTWRITEBYTECODE=1 npm run ml:check
```

## ml-test

cwd: `/Users/ta/running`；exit 0；15.881 s

```sh
PYTHONDONTWRITEBYTECODE=1 'PYTEST_ADDOPTS=-o cache_dir=/tmp/rai-v2-l4-20261026-vczzvoi8/pytest-cache' npm run ml:test
```

## rust-verify

cwd: `/Users/ta/running`；exit 0；100.388 s

```sh
CARGO_TARGET_DIR=/tmp/rai-v2-l4-20261026-vczzvoi8/rust-target RAI_RUST_BINARY=/tmp/rai-v2-l4-20261026-vczzvoi8/rust-target/release/rai-data-worker npm run rust:verify
```

## ios-gates

cwd: `/Users/ta/running`；exit 0；3.111 s

```sh
PYTHONDONTWRITEBYTECODE=1 npm run check:ios-gates
```

## ios

cwd: `/Users/ta/running`；exit 0；971.324 s

```sh
PYTHONDONTWRITEBYTECODE=1 npm run test:ios
```

## xcode-list

cwd: `/Users/ta/running`；exit 0；8.391 s

```sh
 xcodebuild -workspace /tmp/rai-v2-l4-20261026-vczzvoi8/ios-source/RAI.xcworkspace -list -json
```

## xcode-settings

cwd: `/Users/ta/running`；exit 0；4.068 s

```sh
 python3 /tmp/rai-v2-l4-20261026-vczzvoi8/xcode-settings.py
```

## app-simulator

cwd: `/Users/ta/running`；exit 0；165.136 s

```sh
 xcodebuild -workspace /tmp/rai-v2-l4-20261026-vczzvoi8/ios-source/RAI.xcworkspace -scheme RAI -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/rai-v2-l4-20261026-vczzvoi8/app-simulator CODE_SIGNING_ALLOWED=NO build
```

## app-device

cwd: `/Users/ta/running`；exit 0；167.952 s

```sh
 xcodebuild -workspace /tmp/rai-v2-l4-20261026-vczzvoi8/ios-source/RAI.xcworkspace -scheme RAI -sdk iphoneos -destination generic/platform=iOS -derivedDataPath /tmp/rai-v2-l4-20261026-vczzvoi8/app-device CODE_SIGNING_ALLOWED=NO build
```

## visual-compile

cwd: `/Users/ta/running`；exit 0；34.750 s

```sh
 xcodebuild -project /tmp/rai-v2-l4-20261026-vczzvoi8/ios-source/tests/VisualAcceptance.xcodeproj -scheme VisualAcceptance -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/rai-v2-l4-20261026-vczzvoi8/visual-acceptance CODE_SIGNING_ALLOWED=NO build-for-testing
```

## production-install

cwd: `/tmp/rai-v2-l4-20261026-vczzvoi8/production-source`；exit 0；22.441 s

```sh
ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev
```

## production-assert

cwd: `/tmp/rai-v2-l4-20261026-vczzvoi8/production-source`；exit 0；0.333 s

```sh
 python3 /tmp/rai-v2-l4-20261026-vczzvoi8/production-assert.py
```

## production-smoke

cwd: `/tmp/rai-v2-l4-20261026-vczzvoi8/production-source`；exit 0；6.839 s

```sh
 npm run smoke:api
```
