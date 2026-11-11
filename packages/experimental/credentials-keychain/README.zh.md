---
description: "面向希望把 API 密钥移出明文文件的用户与维护者的 OS 钥匙串凭据提供方：配置、分层，以及它能与不能保护什么。"
kind: "package-reference"
---

# @deepseek-ai/dsh-credentials-keychain

[English](README.md) | 中文

## 概述

`dsh-credentials-keychain` 把 API 密钥和其他凭据保存在操作系统的机密存储中——macOS 钥匙串或 Linux Secret Service——而不是 `dsh-credentials-local` 写入的明文 `.credentials.yaml`。它实现同一个 `ctx.credentials` 服务，因此适配器和配置界面无需改动。它去掉了明文文件，但本身并不能把密钥对智能体的 shell 隐藏（见[已知限制](#known-limitations-and-deferred-work)）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

用它替换 `dsh-credentials-local`；两者实现同一个服务，因此一个组合只加载其中之一。

```yaml
- name: '@deepseek-ai/dsh-credentials-keychain'
  config:
    service: dsh
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `service` | `dsh` | 所有条目共用的钥匙串服务名。只允许字母、数字、`.`、`_` 与 `-`；其他字符在加载时失败 |
| `lockWaitMs` | `30000` | 获取 OS 用户/服务写锁的最长等待时间；以毫秒为单位的正安全整数 |

### 密钥来自哪里

引用从第一个持有非空值的层解析：OS 钥匙串（来源 `keychain`）、继承的进程环境（`env`）、调用项目的 `.env`（`project-env`），最后是 `$DSH_HOME/.env`（`user-env`）。钥匙串优先，因此在产品中保存的密钥会压过已导出的变量，与本地提供方一致。只有钥匙串层可写。

### 平台

macOS 通过系统 `osascript` JavaScript 桥接调用 Security API 写入，并用 `security` 读取和删除；两者均无需安装。Linux 使用 libsecret 的 `secret-tool` 以及运行中的 Secret Service 会话（GNOME Keyring 或 KeePassXC）；无头服务器通常两者都没有。预构建 POSIX 锁绑定支持 arm64 和 x64 上的 macOS 与 Linux；其他架构须使用 `credentials-local`。Windows 暂无受支持的存储。不支持的平台、缺失的工具或无法访问的存储会在插件加载时失败，而不是在第一次查找时才失败。

### 迁移现有密钥

不会自动迁移。通过配置界面或 `ctx.credentials.set` 重新保存每个密钥，然后删除旧的 `.credentials.yaml`。迁移命令为延后项。

<a id="understand-the-implementation"></a>
## 理解实现

每个引用是一个钥匙串条目，账户为 `ref:<NAME>`；每条记录是一个条目，账户为 `record:<scope>/<id>`，内容为其 JSON。账户为 `index` 的条目列出记录键，因为平台工具无法按服务枚举条目。机密值通过 stdin 或 stdout 传给工具，绝不经过参数向量——同一用户的其他进程可以通过 `ps` 读取参数向量。macOS 写入通过 stdin 向 Security API 传递 JSON，保留长 grant、Unicode、引号、换行和末尾空格，不受交互式输入行长度限制。base64 存储与已有条目兼容。新条目信任 `/usr/bin/osascript` 和 `/usr/bin/security`；更新保留已有访问设置。写入失败时不报告辅助程序输出。

记录在创建事务之前，以及读取已存记录或事务替代值时，使用[共享 JSON 校验](../../credentials/credentials/README.zh.md#understand-the-implementation)。无效数据会在任何条目改变之前终止操作；解析错误不暴露已存文本或原因链。

`backend.ts` 包含两个平台后端，建立在可注入的命令运行器之上；`index.ts` 包含 `Config`、分层、记录校验与写入队列。记录操作和引用写入跨进程持有同一个 OS 用户/服务独占锁，包括异步 mutation 回调。`record-transaction-v1` 条目在修改记录和索引之前保存完整替换内容及目标索引；启动和后续记录操作先完成中断的事务，再读取或修改记录。损坏或不一致的事务会停止记录操作，不会覆盖已存条目。只有本提供方的写入和完成的修复会发出 `credentials/reference-updated` 与 `credentials/record-updated`。记录通知发生在记录、索引更新及 journal 删除之后；删除之后的进程崩溃可能丢失通知。记录提交或修复失败抛出 `KeychainCommitError`（`code: KEYCHAIN_COMMIT_UNKNOWN`、`outcome: unknown`），不保证存储未改变。重新打开提供方尝试恢复，然后检查凭据再重试；不会自动重试 mutation 回调。旧版本无法恢复待处理的 journal：降级或通过旧进程访问同一服务前须完成恢复。

原生 POSIX 锁绑定在 `<OS 用户主目录>/.dsh-keychain-locks/` 下使用持久文件，以服务名的 SHA-256 哈希命名。该标识不依赖 `DSH_HOME`、profile 或工作目录。目录/文件的所有权或权限不安全时，在访问存储前失败。运行器以描述符 3 向辅助程序传递锁定的打开文件描述；只有全部副本关闭后内核才释放锁。获取超时不会启动操作。释放提供方时取消锁获取并等待已接受的操作结束；已开始的 mutation 回调由调用方负责取消。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 提供方、配置、分层、记录、写入队列 |
| [`src/backend.ts`](src/backend.ts) | macOS 与 Secret Service 后端、命令运行器 |
| [`src/service-lock.ts`](src/service-lock.ts) | 私有锁文件校验与有期限的 POSIX 锁获取 |

<a id="further-exploration"></a>
## 进一步探索

- [dsh-credentials](../../credentials/credentials/README.zh.md)——本提供方实现的服务。
- [dsh-credentials-local](../../credentials/credentials-local/README.zh.md)——文件型提供方，本包是它的钥匙串对应物。

-----

<a id="model-experience"></a>
## 模型体验

经由 `ctx.credentials` 的消费方间接生效：消费方拥有存储值所启用的全部模型可见行为。

#### KV Cache 影响

无直接失效；存储值绝不进入请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **同 UID 进程仍可读取密钥**——`security` 与 `secret-tool` 客户端会不经提示地回应你 OS 用户的任何进程，因此智能体 shell 可以执行 `security find-generic-password -s dsh -a ref:NAME -w`。本包去掉的是明文文件，而不是这条读取路径；要堵上它，需要限定为已签名 harness 二进制的访问列表，以及拒绝钥匙串访问的沙箱配置。
- **外部变更不可见**——在“钥匙串访问”或其他工具中所做的编辑不会发出事件，下一次解析时才会看到。
- **只有协作进程共享锁**——旧版提供方与外部机密存储写入方不获取该锁；升级或更新同一服务前须停止它们。
- **不支持 Windows**，Linux 需要 Secret Service 会话。
- **没有迁移命令**——密钥通过重新保存来迁移。
- **条目在钥匙串界面中可见**——账户名会暴露存在哪些引用和记录键，但绝不暴露值。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为与限制以上文和链接的 Agent Note 为准。

#### 命令行客户端与原生绑定

机密存储访问仍使用平台工具；现有 system addon 负责 POSIX 锁。`@napi-rs/keyring` 之类的绑定可以补上 Windows 和无子进程的进程内访问，并允许条目的访问列表指明 harness 本身。这是需要维护者决定的依赖选择。

#### 离开 experimental

本包位于 `packages/experimental`；把它移到 `credentials-local` 旁边需要产品使用分类。

</details>
