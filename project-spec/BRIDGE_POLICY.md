# BRIDGE_POLICY — codex-bridge-chatgpt 使用与安全策略

本项目只允许使用包内附带的 hardened Skill。

## 1. 固定版本

Bundled archive:
`vendor/codex-bridge-chatgpt-hardened-skill.zip`

Archive SHA-256:
`6dde3d2fc21a4958546af248cfa7003d18b2dcf5db8f5dabd56910a2125e4266`

Hardened security-relevant Skill fingerprint:
`ac0ab9cde3d90cd612a448dd352a64b4dc50f98287f7cede7313da80eeb9db49`

基于 upstream 0.2.0 的加固版本。

禁止为了“更新”而自动执行指向 upstream `main` 的安装命令。

更新 Skill 必须重新安全审计。

## 2. 安装

项目内已带：
`skills/codex-bridge-chatgpt/`

推荐安装：

```bash
bash scripts/install-codex-bridge-skill.sh
```

脚本：
- 不覆盖旧 Skill 而不备份
- 复制 bundled hardened Skill
- 执行 Doctor
- 验证 `READY`
- 验证 security fingerprint

安装后新开 Codex 任务，让 Skill 列表重新加载。

第一次 Browser Automation 调用仍需要用户确认 hardened Consent V2。

## 3. 允许的 Bridge 内容

允许：
- 脱敏后的架构
- 相关函数/接口
- migration 草案
- 错误日志（脱敏）
- synthetic test data
- permission matrix
- deployment design
- 最小必要 diff

## 4. 禁止发送

绝对禁止发送：
- `.env*`
- 数据库密码
- API keys
- session tokens
- invitation tokens
- signing keys
- private keys / PEM
- production cookies
- FCM/APNs secrets
- 真实家庭照片/视频
- 真实私人 EXIF/GPS
- iCloud credential
- MySQL root credential
- SSH credential

## 5. production

Bridge 不得直接获得 production 媒体目录访问权。

如果问题来自 production：
1. Codex 在本地提炼结构化现象。
2. 删除用户名、路径秘密、Token、照片、GPS 等私人内容。
3. 构造最小 Context Packet。
4. 再调用 Bridge。

## 6. 调用触发

参见 `MODEL_ROUTING.md` R4。

典型：
- 安全 review
- 权限 review
- migration review
- backup/restore review
- release review
- 高风险复杂 bug

## 7. 结果处理

Bridge 输出永远视为“建议”，不是事实。

Codex 必须：
- 对照 repo 验证
- 对照当前 tests 验证
- 对照官方文档（需要时）验证
- 不直接复制破坏性 shell 命令
- 不直接执行未经验证的 migration

原则：

> ChatGPT proposes.
> Codex verifies.
> Tests prove.

## 8. Fail closed

hardened Skill 要求：
- Browser transport 异常时停止
- response validation 失败时停止
- 不自动进行第二轮 repair/resubmit
- consent 缺失、过期、fingerprint 不一致时停止
- receipt/path containment 校验失败时停止

不要为了“完成任务”绕过这些保护。

## 9. 账号风险

Browser automation 本身仍存在第三方服务/账号风控风险。
因此：
- Bridge 是专家 review 工具，不是高频代理。
- 不用它绕额度。
- 不做循环调用。
- 不进行大规模 Web 自动化。
