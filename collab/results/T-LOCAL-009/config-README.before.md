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

原始仓库保持 `enabled=false`、地址与证书为空，表示“正式服务尚未内置可用”。
正式值由部署批准后用脚本生成，不要手工填私钥、个人设备证书或旧探针地址：

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
