# Phase 11 — Admin：完整 DEV 实施计划（范围纠正）

2026-10-07。基线 `209b8d36e4a9337ee6c9975878f6031e52a62ace`。本计划取代同日早期 Sol 方案；该方案把 maintenance/read-only 缩为只读展示并再次要求用户选择是否实施，属于未经批准的范围缩减，父线程已否决。**不再按“家庭级只读工作台”作为本期终点。**

权威实施设计：[PHASE-11-ADMIN-IMPLEMENTATION-GUARDRAILS.md](PHASE-11-ADMIN-IMPLEMENTATION-GUARDRAILS.md)。本次仅写这两份设计/计划文档，没有产品、migration、运行模式、真实授权或系统配置变化。全部无关未跟踪残留保留，不 stage/commit/push。

## 原方案范围完整保留

ROADMAP Phase 11 的十项全部进入本批：member management、storage usage、media counts、worker status、backups、integrity status、trash、audit、maintenance、read-only。PROJECT §19 的成员上传量、DB/系统健康一并覆盖；ARCHITECTURE §28 的 storage health 失败自动全局只读必须真正生效。

本批交付可用的管理 UI、真实受限统计和运行观测、成员/邀请及 Trash 既有动作、通用管理/控制原子审计、可操作且持久的维护/只读控制、跨进程停止准入与安全排空、健康故障锁存及有条件人工恢复。禁用按钮、单个内存变量或只挡上传 route 都不能冒充完成。

Backup/restore engine 属 Phase 13，周期完整性 engine 属 Phase 15；本期接口与 UI 如实呈现 NOT_CONFIGURED/NEVER_RUN/UNKNOWN 和已有启动检查的真实范围，不造成功时间，不提前另建后续引擎。通知/FCM 用户已延期，后台健康告警和故障只读保护不随之延期。

Phase 10 DEV 接受仍有效，正式签包、phone HTTPS/家人真机和外网部署延期不阻止本地 Admin 开发；不把 Phase 10 写成全面完成，也不在本批自动进入 Production 或后续 Phase。

## 采用的设计

- 家庭 ADMIN/SUPER_ADMIN 严格复用既有成员权限和媒体 ACL。统计先授权再聚合，去重 media/storage 与 placement/receipt 分开；不可见媒体不存在计数旁路。
- 独立 system grant 才能操作跨家庭部署模式或看系统资源总账；任何家庭 SUPER_ADMIN 不自动获得全局控制权。迁移不给真实账号自动授权；实施期仅显式 synthetic DEV fixture 绑定。
- 系统控制持久状态、operation 幂等/CAS、runtime freshness、通用审计用 additive 0010；旧 Trash/purge audit 和旧迁移保留。
- 稳定内部 control namespace 的 native S/X OperationGate 覆盖 API、metadata、derived、purge、reconciliation、cleanup 和模式相关业务写入。原 CapacityGate、content L/R、actor/业务锁、lease/generation fencing、唯一 writer 与 unknown COMMIT 规则不变。
- 限制模式先短事务持久化停止准入，再排空已获准的安全单元；202 不伪装已静止。恢复需要合法 owner、fresh health、recent-auth、当前 grant、revision/healthGeneration CAS 和审计；marker/DB未知保留受保护，不提供 force。
- 所有状态给出来源/观测时间/UNKNOWN；API health 不能冒充 DB/磁盘/worker 全健康。未配置后续引擎是明确状态，不是省略本期健康保护。

## 一批 Sol 实施顺序

1. 父核对 guardrails 后，由 Sol 连续实现 0010/Drizzle/contracts、system grant 与现有成员/邀请审计原子集成。
2. 实现 OperationGate/故障 marker/控制状态机、所有 writer/runtime 入口的准入与启动接线，保留原事务协议和唯一 owner。不得只保护 HTTP。
3. 完成家庭/系统概览、媒体ACL统计、runtime freshness、审计分页、成员邀请、Trash复用以及实际可操作的 mode UI。遵循既有暖白/绿和桌面/H5布局。
4. targeted unit/API、真实 DEV MySQL/native跨进程race与fault、严格 Admin E2E；闭环完整范围后运行一次完整 Quality Gate，集中独立复核，写 PHASE-11-SUMMARY 和 fingerprint/handoff。原 FAIL/SKIP/UNKNOWN 如实记录，真实 DB 不 silently skip。

权限、容量、模式动作矩阵、在途上传/publish/purge/restore/child drain、故障与重启、unknown COMMIT、人工恢复竞态及测试 cleanup 的具体接受条件以 guardrails §11 为准。完成所有原路线项目才提出 Phase 11 milestone 接受；不会把开发一个子集的 checkpoint 改名为完成。

## 授权与必要决定

目前没有阻塞设计或合成 DEV 实施的产品选择；采用完整维护/只读和显式系统授权，不再询问用户要不要完成原路线功能。若未来要让某个真实 DEV 账号操作整个部署，才需用户明确指定现有 SUPER_ADMIN账号/家庭并确认跨家庭影响；不自动给任何真实账号授予、不自动切实际服务状态。

此阶段不需要域名、VPS、第三方 AI、外网账号或密钥；不使用 Bridge，不修改 home ACL、系统服务、网络/信任或 Production。合成 mode 切换测试须串行并证明无其他实际服务竞争；出现未决故障保留保护而非清理时强行 NORMAL。需要改变原安全不变量时带具体调用链回设计；常规实现选择自主完成，不逐卡要求确认。
