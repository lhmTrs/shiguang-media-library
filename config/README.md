# 发行版云端连接配置（T-LOCAL-007）

`cloud-release.json` 只允许包含**公共信息**：

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` | 固定为 `1` |
| `enabled` | 只有正式发行包才为 `true` |
| `apiOrigin` | 业务 mTLS 入口，如 `https://cloud.example.com:8443` |
| `enrollmentOrigin` | 只用于兑换开通码的 HTTPS 入口，如 `https://cloud.example.com:8444` |
| `serverCaPem` | 验证云端 HTTPS 的公开 CA 证书（PEM） |
| `deviceCaPem` | 验证签发设备证书的公开 CA 证书（PEM） |

原始仓库模板保持 `enabled=false`、地址与证书为空；当前分支已按 T-LOCAL-009
生成正式发行值（见文末“正式发行配置”）。正式值必须由部署批准后用脚本生成，
不要手工填私钥、个人设备证书或旧探针地址：

```bash
node scripts/cloud-release-config.mjs \
  --api-origin https://cloud.example.com:8443 \
  --enrollment-origin https://cloud.example.com:8444 \
  --server-ca /secure/path/server-ca.pem \
  --device-ca /secure/path/device-ca.pem

node scripts/cloud-release-config.mjs --check
```

设备私钥、`cloud-auth.json`、`cloud-device/`、待开通记录都在本机数据目录，
不属于源码，也不在分享白名单内。

## 正式发行配置（2026-10-22，T-LOCAL-009）

当前 `cloud-release.json` 已由 `scripts/cloud-release-config.mjs` 按正式云端生成：

| 字段 | 值 |
| --- | --- |
| `apiOrigin` | `https://112.74.109.173:8443` |
| `enrollmentOrigin` | `https://112.74.109.173:8444` |
| `serverCaPem` / `deviceCaPem` | 同一张公开根 CA：`CN=Shiguang Production Root CA 2026` |
| 根 CA SHA-256 指纹 | `66:5A:D3:0D:94:FE:BF:20:49:E0:65:31:91:A7:95:F2:87:DE:96:70:9A:3D:AB:4D:00:80:DC:55:53:BA:CF:46` |
| `enabled` / `usable` | `true` / `true` |

- 这张 CA 只用于验证云端 HTTPS 与设备证书链，**不是设备身份**；文件里没有私钥、
  P12、开通码、JWT、默认账户或备份。不得安装为系统全局信任，也不得关闭证书或
  主机名校验。
- 新用户仍需管理员发出的一次性开通码，由本机后端生成独立私钥走现有开通流程。
- 首台 owner 的本地运行身份尚未配置：现有受控入口是“云端连接设置”的高级表单，
  最小字段为云端地址、云端 CA 路径、设备证书（PEM 或 P12）与对应私钥/口令；
  owner 私钥、设备证书和口令由 GPT 与用户另行受控配置，不属于本文件，也不随
  发行包分发。若 owner 设备导出的 PEM/P12 未带签发中间 CA，当前表单没有单独的
  “中间证书链”字段，需要另行确认；不得为此增加绕过激活或鉴权的后门。

