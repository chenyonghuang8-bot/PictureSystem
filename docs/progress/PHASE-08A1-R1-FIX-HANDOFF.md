# Phase 8A1 — R1 Web URL 日志修复定点交接

2026-10-02 UTC；基线 HEAD `03f6491b8a66d03633dfd42b5ca6026cf8d8e8dd`，未提交/推送。独立复核 `PHASE-08A1-INDEPENDENT-REVIEW.md` 发现唯一当前阻塞 R1/P2：Next DEV原始访问日志带搜索筛选URL。无P0/P1；本次只落实已批准隐私guardrail，**FIXED_PENDING_ORIGINAL_REVIEWER_CLOSURE**，不自行签核CLOSED。

```text
ROUTING DECISION
Profile: PRO_STABLE
Risk: R3-IMPLEMENT
Current Model: unknown
Recommended Model: Sol Medium / Fast（用户指定）
Test Scope: targeted-R1
Action: continue
Reason: 落实已批准的不记录搜索query/cursor隐私合同，不改变安全设计
```

## 最小变化

1. `apps/web/next.config.ts`：`logging: { incomingRequests: false }`。按安装版本Next16.3.3本地logging文档/实现，关闭的是DEV incoming request原始URL日志；没有全局logging=false、吞异常、删除URL恢复、改变API权限或配置任意忽略规则。错误、编译、警告日志仍走原Next流程。该选项不改变production logging，不把DEV验证冒称Production已审。
2. `tests/e2e-web/start-web-https.mjs`：在**已有certificate/run root/nonce ownership完整校验之后**，仅为专属配置run写 `web-observation.log`（wx/0600）；Next stdout/stderr同时原样pipe到观察文件和原console，无过滤/截断/错误吞掉。无配置owned root时仍inherit。退出先flush观察流；原root校验、临时证书隔离、进程信号/清理策略不变。是日志验收的观察增量，不撤销已审启动器隔离补丁。
3. `tests/e2e-web/authenticated-gallery.spec.ts`：在既有真实8A1 HTTPS纵切中读取上述实际日志；不是mock logger。请求涵盖首页首次加载、带日期/相册/收藏URL的SSR刷新、BFF search下一页cursor、非法query标记。确认日志非空且包含Ready与真实stderr self-signed warning，然后检查 fromDate/toDate/albumId/favoritesOnly/cursor keys、实际cursor及非法marker均不存在。保存合成原始观察日志及布尔回执到ignored R1证据目录。

没有修改schema、Auth、锁顺序、storage/native、现有root或媒体；没有扩展PERF-E1待办。Web AGENTS/CLAUDE保持原hash。原独立review文件不修改，原验收证据不重新伪造为本次运行。

## Fresh targeted结果与证据

`.cache/phase8a1-r1/`：

- `https-final.log`：真实HTTPS现有8A1纵切 **1 PASS / skip0 / retries0**，含R1实际日志断言。这是复跑，不加到原110测试总数。
- `web-observation.log`：实际Next stdout/stderr合成日志；`web-log-regression.json`：启动、stderr警告确实捕获，SSR刷新/代理分页/非法请求均执行且敏感query不存在。
- `lint.log` / `format-check.log`：只检查3个R1源码文件；`typecheck.log` / `build.log`：Web typecheck及build PASS。未重复Phase7/Phase8全门禁。
- `cleanup.json` / `cleanup-checks.json`：最终DEV non-root MySQL9.7.2、8migration、23业务表0；本次owned root不存在，3443/4400/3544无监听，生成next-env恢复。原8A1 https-run回执恢复保留原证据身份。
- `checkpoint-manifest.json` / `final-evidence.json`：R1最终源码/文档hash、定向执行退出码与证据hash；此前安全设计文件hash保持不变。

最小复核请求：原reviewer检查上述配置确实仅关闭URL访问日志、观察器不隐藏日志且ownership守卫保留、实际SSR/代理日志回归与清理证据，然后定点判定R1 CLOSED或具体剩余问题。不重审整套Auth或扩大性能待办。PERF-E1/P3日期deep命中证据保持非阻塞backlog。

```text
R1_IMPLEMENTATION: FIXED
R1_TARGETED_REGRESSION: PASS
R1_INDEPENDENT_CLOSURE: PENDING
NEW_SCOPE_OR_SECURITY_MODEL: NO
COMMIT_PUSH: NO
PHASE_8_COMPLETE: NO
PRODUCTION_READY: NO
```
