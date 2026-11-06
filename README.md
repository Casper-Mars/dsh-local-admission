# dsh-connection-anonymous（PoC）

验证一个假设：**不改官方包、不 fork、不用 patch-package**，只靠一个 Cordis 插件，在运行时替换 `connection.admit`，让 loopback 上的内部 API 在**没有 token / cookie** 时也被接纳为一个 owner Peer。

结论：可行。对照组 `anon-off` 稳定 401，实验组 `anon` 在 HTTP 与 WebSocket 两条传输上都通过鉴权。

## 实测结果

| profile | `trustLoopback` | `GET /api/__probe__` | `GET /api/remote.mux`（WS upgrade） |
| --- | --- | --- | --- |
| `anon-off` | `false` | **401** | **401** |
| `anon` | `true` | **404**（已过 admit，只是没有该端点） | **101**（握手成功） |

```
=== summary ===
  anon-off probe=401  upgrade=401
  anon     probe=404  upgrade=101
```

## 运行

前置：`dsh` 0.2.1-rc.2 在 PATH，Node ≥ 20，pnpm 11。

```bash
pnpm install
pnpm build
pnpm setup     # 创建隔离的 ./.dsh-home，不写 ~/.dsh
pnpm verify    # 真启动两次 dsh，断言状态码
```

`pnpm setup` 做的事：

1. 把 `~/.dsh/profiles/web` 复制到 `./.dsh-home/profiles/anon`（只读源 profile，不修改它）；
2. `DSH_HOME=./.dsh-home dsh plugin --profile anon add <本仓库>`，把本包 link 进 profile；
3. 在 `anon/cordis.patch.yml` 末尾追加一条 `insert` 配置（`trustLoopback: true`）；
4. 再复制一份为 `anon-off`，把 `trustLoopback` 改成 `false` 作为对照组。

`pnpm verify` 会在 18085 端口依次启动两个 profile，用无 cookie 请求打 `/api/__probe__` 与 `/api/remote.mux`，记录真实状态码，结束后 SIGTERM 清理进程。

## 为什么这样实现

1. **不 import `HostConnectionService` 类。** 插件通过 link 进入 profile，模块实例很可能和 dsh 启动时加载的不是同一个，prototype patch 会静默失效。直接操作 `ctx.get('connection')` 返回的服务实例。
2. **实例属性覆盖 prototype。** `requestRejection`、`admitConnection`、`/api` 路由、WebSocket upgrade 全部走 `this.admit(...)`，所以 `conn.admit = fn` 能覆盖所有入口。
3. **匿名 Peer 必须是 `interactions: 'answer'`。** 用 `conn.publishPeer('answer')` 注册进 `conn.peers`，`{ peer: record.peer }` 才能被 `admitConnection` 接管（它要按 id 查 `peers` 才能建立 socket 所有权）。`browserPeer` 没有 answer，`$events` 会被 `gateway/interactions-forbidden` 拒绝。
4. **Host/Origin 围栏保留。** 先执行 `conn.isTrusted(request)`，不可信一律 `{ rejection: 403 }`，不会因为开了匿名就把 CSRF/DNS-rebinding 防护一起关掉。
5. **只在 loopback 生效（fail-closed）。** `apply` 读取 `webServer.host`；非 loopback 且 `trustLoopback: true` 时插件**拒绝激活**并把错误记进日志：

   ```
   [dsh-connection-anonymous] refusing to activate: trustLoopback requires a loopback listener (got <host>)
   ```

   Cordis loader 会记录 `1 entry did not activate`，**dsh 继续运行**，该实例仍以官方 token 鉴权提供服务——不会产生匿名入口，也不会匿名暴露到网络。
6. **卸载可逆。** 安装时记录 `hadOwn = Object.hasOwn(conn, 'admit')` 和 `originalOwn = conn.admit`（不做 `bind` 副本），wrapper 里用 `originalOwn.call(conn, request)`。`ctx.effect` 的清理逻辑：`hadOwn` 为真时把 `originalOwn` 原样写回（`conn.admit === originalOwn`），否则 `delete conn.admit`，恢复原型方法。
7. **HMR / 重复 apply 幂等。** 用 `Symbol.for(...)` 在实例上打标记 + 引用计数，重复安装只加计数，不会套娃。
8. **Peer 生命周期。** WebSocket 关闭时 `admitConnection` 会 `peers.delete` 并 dispose 该 Peer；下一次请求发现记录不存在就重新 `publishPeer('answer')`，避免第二次升级拿到旧 id 变回 401。

## 验证了什么 / 没验证什么

已验证：

- `/api` 前缀的 HTTP 准入（`connection.admit`）；
- `/api/remote.mux` 的 WebSocket upgrade 准入（`connection.admitConnection` → `this.admit`）；
- 对照组在两条传输上都是 401；
- 插件日志、进程退出与端口释放、`~/.dsh` 未被修改；
- 非 loopback（LAN IP）启动：日志出现 `refusing to activate`，dsh 照常运行，无 token 请求仍为 401。

未验证：

- 没有做 `session/list` 之类的 RPC 业务级调用，只到传输层；
- 没有验证匿名 Peer 在 gateway waterfall（`interactions: answer`）里的实际应答行为，只验证了 101 握手与 404 放行；
- 没有做并发/压力、TLS、反向代理场景；
- **这不是生产方案**，只是一个可行性验证。

## 安全边界

- 仅 loopback：`webServer.host` 非 loopback 时插件拒绝激活（日志报错），dsh 以原有 token 鉴权继续运行，不会有匿名入口。
- 匿名 Peer 的 principal 是 `{ kind: 'owner' }`，**等于本机全权**：任何能访问该 loopback 端口的本机进程，都可以读写全部会话、调用全部 RPC。
- 只应在一次性验证环境或完全可信的单机开发环境使用。

## 升级风险

插件依赖 `HostConnectionService` 的三个**内部符号**：

- `admit`（实例方法，被覆盖的入口）
- `publishPeer(interactions)`（私有方法，用来注册匿名 Peer）
- `peers`（私有 Map，`admitConnection` 靠它查 Peer）

dsh 升级后如果重命名、改成 `#private` 字段或改变 `admit` 的调用方式，插件会：

- `publishPeer`/`peers` 缺失 → 打 warn 并退化为原始 401（fail closed）；
- `admit` 缺失或签名变化 → 插件拒绝激活并记录错误，dsh 继续以原有 token 鉴权运行。

两种情况都不会静默放开鉴权（fail-closed）。

## 文件

```
package.json            # dsh-connection-anonymous，type: module
tsconfig.json           # 构建配置（src -> dist）
tsconfig.test.json      # 测试/typecheck 配置（含 tests）
src/index.ts            # name / inject / Config / apply
src/admit.ts            # installAnonymousAdmit(conn, opts)
src/guard.ts            # isLoopbackHost
tests/guard.spec.ts     # loopback 判定表驱动测试
tests/admit.spec.ts     # 准入、幂等、卸载、apply 守卫
scripts/setup-profile.mjs
scripts/verify.mjs
```

`dist/`、`node_modules/`、`.dsh-home/` 均已 gitignore。
