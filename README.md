# dsh-bypass-web-token（PoC）

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
5. **只在 loopback 生效（fail-closed）。** `apply` 读取 `webServer.host`；非 loopback 且 `trustLoopback: true` 时插件**跳过激活**，只打印一行 console 错误：

   ```
   [dsh-bypass-web-token] activation skipped: webServer.host — trustLoopback requires a loopback listener (got <host>) (plugin inactive; dsh keeps stock auth)
   ```

   插件安静返回，loader 不会记录失败条目，**dsh 完全不受影响**，仍以官方 token 鉴权提供服务——不会产生匿名入口，也不会匿名暴露到网络。
6. **卸载可逆。** 安装时记录 `hadOwn = Object.hasOwn(conn, 'admit')` 和 `originalOwn = conn.admit`（不做 `bind` 副本），wrapper 里用 `originalOwn.call(conn, request)`。`ctx.effect` 的清理逻辑：`hadOwn` 为真时把 `originalOwn` 原样写回（`conn.admit === originalOwn`），否则 `delete conn.admit`，恢复原型方法。
7. **HMR / 重复 apply 幂等。** 用 `Symbol.for(...)` 在实例上打标记 + 引用计数，重复安装只加计数，不会套娃。
8. **Peer 生命周期。** WebSocket 关闭时 `admitConnection` 会 `peers.delete` 并 dispose 该 Peer；下一次请求发现记录不存在就重新 `publishPeer('answer')`，避免第二次升级拿到旧 id 变回 401。

## 验证了什么 / 没验证什么

已验证：

- `/api` 前缀的 HTTP 准入（`connection.admit`）；
- `/api/remote.mux` 的 WebSocket upgrade 准入（`connection.admitConnection` → `this.admit`）；
- 对照组在两条传输上都是 401；
- 插件日志、进程退出与端口释放、`~/.dsh` 未被修改；
- 非 loopback（LAN IP）启动：日志出现 `activation skipped: webServer.host`，dsh 照常运行，无 token 请求仍为 401。

未验证：

- 没有做 `session/list` 之类的 RPC 业务级调用，只到传输层；
- 没有验证匿名 Peer 在 gateway waterfall（`interactions: answer`）里的实际应答行为，只验证了 101 握手与 404 放行；
- 没有做并发/压力、TLS、反向代理场景；
- **这不是生产方案**，只是一个可行性验证。

## 安全边界

- 仅 loopback：`webServer.host` 非 loopback 时插件跳过激活并打印 console 错误，dsh 以原有 token 鉴权继续运行，不会有匿名入口。
- 匿名 Peer 的 principal 是 `{ kind: 'owner' }`，**等于本机全权**：任何能访问该 loopback 端口的本机进程，都可以读写全部会话、调用全部 RPC。
- 只应在一次性验证环境或完全可信的单机开发环境使用。

## 升级风险

插件依赖 `HostConnectionService` 的四个内部符号：`admit`、`isTrusted`、`publishPeer(interactions)`、`peers`。

**启动期：任何一项缺失或类型不符，插件都不激活、不抛错，只打印一行 `activation skipped` 日志，dsh 继续以原有 token 鉴权运行。**

| 场景 | 日志关键字 | 行为 |
| --- | --- | --- |
| `trustLoopback: false` | 无 | 静默，不安装 |
| `ctx.get('webServer')` 抛错 | `activation skipped: ctx.get('webServer')` | 插件不生效 |
| `webServer` 服务缺失 | `activation skipped: webServer` | 插件不生效 |
| `webServer.host` 缺失/非字符串 | `activation skipped: webServer.host`（带实际类型与值） | 插件不生效 |
| `webServer.host` 非 loopback | `activation skipped: webServer.host`（带 host） | 插件不生效，保持官方鉴权 |
| `ctx.get('connection')` 抛错 | `activation skipped: ctx.get('connection')` | 插件不生效 |
| `connection` 服务缺失 | `activation skipped: connection` | 插件不生效 |
| `connection.admit` 缺失/非函数 | `activation skipped: connection.admit` | 插件不生效 |
| `connection.isTrusted` 缺失/非函数 | `activation skipped: connection.isTrusted` | 插件不生效 |
| `connection.publishPeer` 缺失/非函数 | `activation skipped: connection.publishPeer` | 插件不生效 |
| `connection.peers` 非 `Map` | `activation skipped: connection.peers` | 插件不生效 |
| `ctx.effect` 缺失/抛错 | `activation skipped: ctx.effect` | 插件不生效；已安装的补丁会回滚 |
| `connection` 实例 frozen/只读，写入 `admit` 失败 | `activation skipped: install` | 回滚，插件不生效 |

所有跳过日志都以 `(plugin inactive; dsh keeps stock auth)` 结尾，统一前缀 `[dsh-bypass-web-token]`。成功日志只在补丁**真正落地**后打印（`installAnonymousAdmitResult(...).installed === true`）：安装被 skip 时只有那一行 skip，不会出现「skip + success」矛盾；被拒绝的安装也不会向 fiber 注册 disposer。日志写入统一经过 try/catch 包装，`console` sink 自身抛错既不影响 `apply`，也不影响请求路径。

**运行期：wrapper 自身也绝不抛错。** 原 `admit`、`isTrusted`、`publishPeer`、`peers.get`、peer record 结构任一异常都会被吞掉，返回 `{ rejection: 401 }`（fail-closed），同一错误签名只打印一次：

```
[dsh-bypass-web-token] request path degraded: <stage> — <error message> (returning 401)
```

请求不会变成 500，dsh 主进程不受影响。仅在 `admit` 的签名/调用方式变化且不抛错时无法自动识别（JavaScript 无运行期类型信息），此时需要人工排查升级兼容性；即便如此也不会放开鉴权。

> Cordis 4.0.5 的 `inject` 只支持必选服务列表（没有 `required`/`optional` 分离），因此 `webServer` 仍声明为必选。若整个 `webServer` 服务消失，fiber 不会激活（dsh 不受影响），但不会产生上面的跳过日志——这是 Cordis 依赖注入机制决定的，不是插件遗漏。

## 文件

```
package.json            # dsh-bypass-web-token，type: module
tsconfig.json           # 构建配置（src -> dist）
tsconfig.test.json      # 测试/typecheck 配置（含 tests）
src/index.ts            # name / inject / Config / apply
src/admit.ts            # installAnonymousAdmitResult(conn, opts) -> { dispose, installed, stage? }（installAnonymousAdmit 为兼容包装）
src/guard.ts            # isLoopbackHost
tests/guard.spec.ts     # loopback 判定表驱动测试
tests/admit.spec.ts     # 准入、幂等、卸载、apply 守卫、失败隔离
scripts/setup-profile.mjs
scripts/verify.mjs
```

`dist/`、`node_modules/`、`.dsh-home/` 均已 gitignore。
