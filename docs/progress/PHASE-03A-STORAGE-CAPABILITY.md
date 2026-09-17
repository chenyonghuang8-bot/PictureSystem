# Phase 3A — Native Storage Capability Gate

状态：**PASS**  
范围：仅 macOS filesystem/native capability layer；未接入数据库、HTTP、tus 或完整上传流程。

## Runtime evidence

- OS：macOS 26.6.2 (25G83)，Apple Silicon arm64
- Node.js：22.23.2，N-API 10
- Compiler：Apple clang 21.0.0，target `arm64-apple-darwin25.6.0`
- Filesystem：workspace、系统 synthetic temp fixture 与当前 DEV media root 均位于 device `16777234`；挂载类型为本地、journaled APFS。
- 当前配置预期的 DEV media root 仅做 `stat` 检查：存在、为 directory、mode `0700`。本阶段没有读取其中内容、初始化 marker、创建文件或执行清理。
- 所有写入型验证均使用 `realpath(tmpdir())` 下唯一 `family-album-phase3a-*` synthetic namespace；cleanup 前再次验证 namespace 相对路径。

## Implemented capability layer

- Darwin N-API adapter 由项目内脚本使用当前 Node headers 与 clang 构建；没有 shell path 拼接或额外运行服务。
- `MEDIA_ROOT` 必须是非 `/` 的绝对 canonical path；拒绝 NUL、dot segment、重复 separator、尾随 separator 与相对路径。
- native 端从 `/` 开始逐分量 `openat`，固定 directory fd；目录使用 `O_DIRECTORY | O_NOFOLLOW`，文件使用 `O_EXCL | O_NOFOLLOW`，内部 basename 仅允许服务端 canonical 小写字母、数字、点、下划线和连字符。
- root 必须由当前 effective UID 拥有且无 group/other 权限；目录、marker、writer lock、staging 与 final 文件拒绝 extended ACL。受控目录为 `0700`，staging 为 `0600`，final 发布前变为 `0400`。
- `.storage-root` 是版本化、随机 128-bit lowercase-hex root identity；期望 marker 不匹配时 fail closed。
- `.writer.lock` 使用稳定 inode 与生命周期 `flock(LOCK_EX | LOCK_NB)`；同进程第二 handle 和独立 Node 进程均已验证被拒绝。
- 路径仅由 canonical family ID、128-bit lowercase-hex upload ID、SHA-256 lowercase hex 和 canonical byte-size string 生成。客户端 filename 只接受为 metadata，永不参与 filesystem path。

## Native filesystem results

| Capability           | Result | Runtime evidence                                                                                                                                                                                                              |
| -------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root containment     | PASS   | traversal、absolute injection、dot/repeated separators、NUL 与非法 internal identifier 均拒绝；不使用 `startsWith` 授权。                                                                                                     |
| Symlink / TOCTOU     | PASS   | staging parent、destination parent、payload symlink 均 fail closed；验证后 parent 名称交换仍使用固定 fd，未写入替换后的外部目录。                                                                                             |
| Special entries      | PASS   | source hard link (`nlink != 1`) 被拒绝；pre-existing FIFO destination 返回 already-exists 且保持不变。                                                                                                                        |
| Exclusive create     | PASS   | `openat(... O_CREAT                                                                                                                                                                                                           | O_EXCL ...)`；既有文件不 truncate。两个 native pthread writer 通过 barrier 同时竞争，结果严格为 1 success / 1 EEXIST。 |
| No-overwrite publish | PASS   | 使用 `renameatx_np(..., RENAME_EXCL                                                                                                                                                                                           | RENAME_NOFOLLOW_ANY                                                                                                    | RENAME_RESOLVE_BENEATH)`；不存在目标成功，既有目标稳定 EEXIST，绝不回退普通 rename/copy/delete。 |
| Concurrent publish   | PASS   | 两个 native pthread 对同一 destination 竞争，严格为 1 success / 1 EEXIST；final bytes 与完整 hash 保持正确。                                                                                                                  |
| Source identity      | PASS   | publish 前验证 opened source 的 regular/owner/device/inode/nlink，并在 rename 紧前通过 source-parent fd 重新核对 basename 的 dev/inode/nlink。                                                                                |
| Same filesystem      | PASS   | `uploads`、`temp`、`originals` 的 `st_dev` 与 root 相同；模拟不同 device 时 fail closed，不提供 copy+delete fallback。                                                                                                        |
| File durability      | PASS   | staged file 调用并检查 `fsync`；final fd 调用并检查 `fsync` 与 `F_FULLFSYNC`。错误注入不会返回 durability receipt。                                                                                                           |
| Namespace durability | PASS   | 创建目录时同步 parent；exclusive create 同步 parent；publish 同步 source 与 destination parent directory。所有错误均 fail closed。                                                                                            |
| Close/error handling | PASS   | file/directory/root descriptor close errors不会被忽略；测试验证 close failure 不会被报告为成功。                                                                                                                              |
| Immutable original   | PASS   | `publishOriginal` 只提供 create-once/no-clobber；第二份不同 bytes 无法替换 final，发布前后 SHA-256 不变，final 无 write mode。没有 overwrite/replace/update original API。                                                    |
| Capability state     | PASS   | 合法 synthetic root 返回 `READ_WRITE`；missing、symlinked、marker mismatch、extended ACL、不可写及 cross-device contract 返回 `UNAVAILABLE`。`READ_ONLY` 类型保留给后续受控维护/容量状态，本阶段没有伪造正向 READ_ONLY 结果。 |

## Test results

- Native filesystem integration：16/16 PASS
- Pure path/unit tests：15/15 PASS
- Combined storage targeted suite：31 tests expected after the final cross-process/ACL/special-entry additions; final command is recorded in the task result.
- Native build：PASS，C11 `-Wall -Wextra -Werror`
- Storage TypeScript typecheck：PASS
- Scoped ESLint：PASS（0 warnings）
- Scoped Prettier：PASS

## Known limitations and boundaries

- 这些测试证明当前 Node/macOS/APFS runtime 可以调用并检查批准的 syscall，不等同于真实断电、坏硬件或控制器谎报下的绝对持久性证明。
- 当前验证目标是本机内置 APFS synthetic fixture。未来实际外接 SSD、volume/marker 变化或文件系统升级必须重新运行 capability gate；不能沿用本报告推断。
- 没有可用的第二个测试 mount，因此真实 `EXDEV` rename 未执行；能力层已真实核对 `st_dev`，模拟 device mismatch 时 fail closed，且没有 cross-device fallback。后续外接盘验收应补真实 EXDEV/掉线测试。
- `READ_ONLY` 仅定义 contract；Phase 3A 只要求并验证正常 `READ_WRITE` 与异常 `UNAVAILABLE`。维护模式、容量余量与 DB readiness 会在后续 coordinator 中决定 READ_ONLY/READ_WRITE。
- 本阶段没有实现 chunk streaming、容量预留、upload mutex、hash/dedupe、DB durability receipt、recovery daemon 或 tus endpoint。native `createExclusive` 的 buffer 输入只用于 synthetic capability harness，不能视为完整上传实现。
- 完整 finalize 仍必须遵守 Phase 3 guardrails 中 intent、hash、filesystem publish、DB complete 的顺序；本 primitive 的成功不能单独表示业务上传完成。

## Gate decision

当前 macOS runtime 所需 native invariant 均已获得真实 synthetic filesystem 证据，未发现需要降低既定安全保证的平台限制。

`MACOS_STORAGE_CAPABILITY_GATE: PASS`  
`READY_FOR_PHASE_3_SCHEMA: YES`
