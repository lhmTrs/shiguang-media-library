/**
 * T-LOCAL-008：本地管理适配（隔离 HTTPS/mTLS mock）验收测试。
 *
 * - 一次性 CA/证书 + 本机随机端口；不连正式云端、不使用真实账户/素材。
 * - 覆盖：DTO 收敛、固定路由、分页/状态/候选、小组生命周期、账户开通码、
 *   密码重置（无 Bearer、mTLS）、角色/影响/分配/撤销、审计、403/409/429/401、
 *   401 清会话、退出后旧响应 STALE、敏感一次性码不落本地文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { CloudAuth } from "../server/cloud-auth.mjs";
import { CloudManagement, CloudManagementError } from "../server/cloud-management.mjs";
import { startManagementCloud } from "./cloud-management-mock.mjs";

const PASSWORD = "correct horse battery staple";

async function setup(t, { as = "owner", cert = "clientOwner" } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-management-")));
  const lib = await new Library(path.join(base, "data")).init();
  const cloud = await startManagementCloud();
  const auth = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
  t.after(async () => {
    auth.dispose();
    lib.db.close();
    await cloud.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await auth.configure({
    origin: cloud.origin,
    caPath: cloud.caCert,
    certPath: cloud[cert].cert,
    keyPath: cloud[cert].key,
  });
  if (as) await auth.login({ username: as, password: PASSWORD });
  cloud.requests.length = 0;
  return { base, lib, cloud, auth, mgmt: new CloudManagement(lib, { cloudAuth: auth }) };
}

async function filesContain(dir, needle) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await filesContain(full, needle)) return true;
    } else if (entry.isFile()) {
      const content = await fs.readFile(full, "utf8").catch(() => "");
      if (content.includes(needle)) return true;
    }
  }
  return false;
}

/** 让第一笔云请求在真实响应后暂停，便于确定性地把后续写操作排进本地串行队列。 */
function holdFirstProxy(auth) {
  let release;
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const real = auth.proxy.bind(auth);
  let first = true;
  auth.proxy = async (...args) => {
    const value = await real(...args);
    if (first) {
      first = false;
      reached();
      await gate;
    }
    return value;
  };
  return { arrived, release };
}

function configureWith(auth, cloud, cert) {
  return auth.configure({
    origin: cloud.origin,
    caPath: cloud.caCert,
    certPath: cert.cert,
    keyPath: cert.key,
  });
}

test("profile 只暴露脱敏资料，路径固定为 /me、/me/capabilities、/me/devices", async (t) => {
  const { cloud, mgmt, auth } = await setup(t);
  const profile = await mgmt.profile();
  assert.equal(profile.me.username, "owner");
  assert.equal(profile.me.superAdmin, true);
  assert.ok(profile.capabilities.systemPermissions.includes("account:read"));
  assert.ok(profile.devices.length >= 1);
  assert.equal("accessToken" in profile.me, false);
  assert.equal("refreshToken" in profile.me, false);
  const paths = cloud.requests.map((item) => item.path);
  assert.deepEqual(paths.sort(), ["/api/v1/me", "/api/v1/me/capabilities", "/api/v1/me/devices"]);
  const state = JSON.stringify(auth.getState());
  assert.equal(state.includes("accessToken"), false);
  assert.equal(state.includes("refreshToken"), false);
});

test("小组列表/管理模式/成员资料合并，版本字段完整", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const own = await mgmt.groups({ management: false, limit: 50, offset: 0 });
  // owner 不是小组成员，普通列表为空；管理模式可看到全部状态。
  assert.deepEqual(own, []);
  const all = await mgmt.groups({ management: true, limit: 50, offset: 0 });
  assert.equal(all.length, 4);
  const groupA = all.find((row) => row.id === cloud.ids.groups.a);
  assert.equal(groupA.state, "ACTIVE");
  assert.equal(groupA.version, 0);
  const members = await mgmt.members(groupA.id, { limit: 100, offset: 0 });
  const memberRow = members.find((row) => row.accountId === cloud.ids.member);
  assert.equal(memberRow.username, "member");
  assert.equal(memberRow.displayName, "组员小王");
  assert.equal(memberRow.memberState, "ACTIVE");
  assert.equal(memberRow.accountState, "ACTIVE");
  assert.ok(Array.isArray(members));
});

test("账户分页/搜索/状态过滤；非法 limit、state 与未知字段被拒绝", async (t) => {
  const { mgmt } = await setup(t);
  const page = await mgmt.accounts({ limit: 2, offset: 0 });
  assert.equal(page.items.length, 2);
  assert.equal(page.limit, 2);
  assert.ok(page.total >= 5);
  for (const account of page.items) {
    assert.deepEqual(Object.keys(account).sort(), [
      "createdAt", "displayName", "id", "securityVersion", "state", "superAdmin", "username",
    ]);
  }
  const found = await mgmt.accounts({ query: "member", limit: 50, offset: 0 });
  assert.equal(found.items.length, 1);
  assert.equal(found.items[0].username, "member");
  const pending = await mgmt.accounts({ state: "PENDING", limit: 50, offset: 0 });
  assert.equal(pending.items.length, 1);
  await assert.rejects(() => mgmt.accounts({ limit: 1000 }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => mgmt.accounts({ state: "HACK" }), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(
    () => mgmt.createAccount({ username: "newuser", displayName: "新人", superAdmin: true }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("精确候选查询：规范化用户名、0/1 条结果、禁止模糊空查询", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const hit = await mgmt.candidates({ username: "  MEMBER " });
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, cloud.ids.member);
  assert.deepEqual(Object.keys(hit[0]).sort(), ["displayName", "id", "username"]);
  assert.deepEqual(await mgmt.candidates({ username: "nobody" }), []);
  assert.deepEqual(await mgmt.candidates({ username: "pending" }), []);
  assert.deepEqual(await mgmt.candidates({ username: "member", groupId: cloud.ids.groups.a }), hit);
  await assert.rejects(() => mgmt.candidates({}), (error) => error.code === "INVALID_REQUEST");
});

test("创建账户返回一次性开通码；签发/撤销码；未知字段与非法 ID 拒绝", async (t) => {
  const { lib, cloud, mgmt } = await setup(t);
  const opening = await mgmt.createAccount({ username: "  New.User ", displayName: "新用户" });
  assert.equal(opening.username, "new.user");
  assert.match(opening.openingCode, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(typeof opening.expiresAt, "string");
  assert.equal(await filesContain(lib.dataDir, opening.openingCode), false, "开通码不能落本地文件");
  const issued = await mgmt.issueOpeningCode(opening.accountId);
  assert.match(issued.openingCode, /^[A-Za-z0-9_-]{43}$/);
  await mgmt.revokeOpeningCode(issued.id);
  assert.equal(cloud.state.openings.has(issued.id), false);
  await assert.rejects(() => mgmt.issueOpeningCode("../me"), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(
    () => mgmt.createAccount({ username: "bad name", displayName: "x" }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("小组创建幂等：同 requestId 同参数重放原快照，参数变化 409", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const requestId = crypto.randomUUID();
  const created = await mgmt.createGroup({
    name: " 验收小组 ",
    initialLeaderAccountId: cloud.ids.admin,
    requestId,
  });
  assert.equal(created.name, "验收小组");
  assert.equal(created.version, 0);
  const replay = await mgmt.createGroup({
    name: "验收小组",
    initialLeaderAccountId: cloud.ids.admin,
    requestId,
  });
  assert.equal(replay.id, created.id);
  assert.equal(replay.version, 0);
  await assert.rejects(
    () => mgmt.createGroup({ name: "另一个名字", initialLeaderAccountId: cloud.ids.admin, requestId }),
    (error) => error.code === "IDEMPOTENCY_CONFLICT" && error.status === 409,
  );
});

test("版本冲突不静默覆盖；成员加入/移除/退出与负责人约束", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const group = await mgmt.group(cloud.ids.groups.a);
  await assert.rejects(
    () => mgmt.renameGroup(group.id, { name: "新名字", expectedVersion: group.version + 5 }),
    (error) => error.code === "VERSION_CONFLICT" && error.status === 409,
  );
  const renamed = await mgmt.renameGroup(group.id, { name: "音频组改名", expectedVersion: group.version });
  assert.equal(renamed.name, "音频组改名");
  assert.equal(renamed.version, group.version + 1);

  const fresh = await mgmt.group(group.id);
  await assert.rejects(
    () => mgmt.addMember(group.id, { accountId: cloud.ids.disabled, expectedVersion: fresh.version }),
    (error) => error.code === "INVALID_GROUP",
  );
  const added = await mgmt.addMember(group.id, { accountId: cloud.ids.newbie, expectedVersion: fresh.version });
  assert.equal(added.version, fresh.version + 1);

  const current = await mgmt.group(group.id);
  await assert.rejects(
    () => mgmt.removeMember(group.id, cloud.ids.leader, { expectedVersion: current.version }),
    (error) => error.code === "LEADER_TRANSFER_REQUIRED" && error.status === 409,
  );
});

test("负责人交接/停用恢复小组；紧急封禁负责人后 NEEDS_LEADER 不能直接恢复", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const group = await mgmt.group(cloud.ids.groups.a);
  const transferred = await mgmt.transferLeader(group.id, {
    accountId: cloud.ids.admin,
    expectedVersion: group.version,
  });
  assert.equal(transferred.leaderAccountId, cloud.ids.admin);
  assert.equal(transferred.version, group.version + 1);

  // 停用/恢复：恢复要求当前负责人仍是有效成员。
  const disabled = await mgmt.setGroupState(transferred.id, {
    enabled: false,
    expectedVersion: transferred.version,
  });
  assert.equal(disabled.state, "DISABLED");
  const restored = await mgmt.setGroupState(disabled.id, {
    enabled: true,
    expectedVersion: disabled.version,
  });
  assert.equal(restored.state, "ACTIVE");

  // 紧急封禁 admin：其负责的 groupA/groupB 进入 NEEDS_LEADER，不能直接恢复。
  const admin = await mgmt.account(cloud.ids.admin);
  await mgmt.setAccountState(admin.id, {
    enabled: false,
    expectedSecurityVersion: admin.securityVersion,
    emergency: true,
  });
  const needsLeader = await mgmt.group(cloud.ids.groups.b);
  assert.equal(needsLeader.state, "NEEDS_LEADER");
  await assert.rejects(
    () => mgmt.setGroupState(needsLeader.id, { enabled: true, expectedVersion: needsLeader.version }),
    (error) => error.code === "GROUP_NEEDS_LEADER",
  );
});

test("普通账户停用需要交接，emergency 才封禁负责人", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const leader = await mgmt.account(cloud.ids.leader);
  await assert.rejects(
    () => mgmt.setAccountState(leader.id, {
      enabled: false,
      expectedSecurityVersion: leader.securityVersion,
      emergency: false,
    }),
    (error) => error.code === "LEADER_TRANSFER_REQUIRED" && error.status === 409,
  );
  await mgmt.setAccountState(leader.id, {
    enabled: false,
    expectedSecurityVersion: leader.securityVersion,
    emergency: true,
  });
  const group = await mgmt.group(cloud.ids.groups.a);
  assert.equal(group.state, "NEEDS_LEADER");
});

test("owner 签发重置码：仅本次返回；目标设备用 mTLS 无 Bearer 完成；本地清会话", async (t) => {
  const { base, cloud, mgmt } = await setup(t);
  const member = await mgmt.account(cloud.ids.member);
  const reset = await mgmt.resetAccountPassword(member.id, {
    expectedSecurityVersion: member.securityVersion,
    currentPassword: PASSWORD,
  });
  assert.match(reset.resetToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(reset.accountId, member.id);
  assert.equal("password" in reset, false);

  // 换到目标账户自己的设备证书，验证 reset-password 不要求旧登录/Bearer。
  const targetData = path.join(base, "target");
  await fs.mkdir(targetData, { recursive: true });
  const targetAuth = await new CloudAuth(mgmt.lib, { dataDir: targetData }).init();
  await targetAuth.configure({
    origin: cloud.origin,
    caPath: cloud.caCert,
    certPath: cloud.clientMember.cert,
    keyPath: cloud.clientMember.key,
  });
  const target = new CloudManagement(mgmt.lib, { cloudAuth: targetAuth });
  const result = await target.resetPassword({ resetToken: reset.resetToken, newPassword: "a brand new password" });
  assert.equal(result.reset, true);
  assert.equal(targetAuth.getState().state, "needs-login");
  const entry = cloud.requests.filter((item) => item.path === "/api/v1/auth/reset-password").at(-1);
  assert.equal(entry.hasAuth, false);
  assert.equal(JSON.stringify(entry.body).includes("accessToken"), false);

  // 重置码重放/换账户失败。
  await assert.rejects(
    () => target.resetPassword({ resetToken: reset.resetToken, newPassword: "another new password" }),
    (error) => error.code === "UNAUTHORIZED",
  );
  await targetAuth.logout().catch(() => undefined);
});

test("本人改密/撤销当前设备清本地会话；撤销其他设备保留会话", async (t) => {
  const { cloud, mgmt, auth } = await setup(t);
  const profile = await mgmt.profile();
  const other = profile.devices.find((device) => device.id !== profile.me.deviceId);
  assert.ok(other, "测试夹具需要第二台设备");
  await mgmt.revokeDevice(other.id);
  assert.equal(auth.getState().state, "logged-in");
  const meDevice = profile.me.deviceId;
  const result = await mgmt.revokeDevice(meDevice);
  assert.equal(result.signedOut, true);
  assert.equal(auth.getState().state, "needs-login");
  assert.equal(auth.getState().deviceId, null);
  void cloud;
});

test("角色目录/角色/影响预览/创建/更新/分配/撤销完整可用", async (t) => {
  const { cloud, mgmt } = await setup(t);
  const catalog = await mgmt.permissions();
  assert.ok(catalog.some((item) => item.code === "group:member:manage" && item.customAssignable));
  const roles = await mgmt.roles({ limit: 50, offset: 0 });
  assert.ok(roles.every((item) => item.role && Array.isArray(item.permissions)));
  const member = await mgmt.account(cloud.ids.member);
  const assignments = await mgmt.roleAssignments(member.id, { limit: 50, offset: 0 });
  assert.ok(assignments.items.length >= 2);
  const assignment = assignments.items[0];
  assert.deepEqual(Object.keys(assignment).sort(), [
    "accountId", "grantedBy", "groupId", "id", "roleId", "scopeKey", "scopeType",
  ]);
  await mgmt.revokeRole(assignment.id);
  const after = await mgmt.roleAssignments(member.id, { limit: 50, offset: 0 });
  assert.equal(after.items.length, assignments.items.length - 1);

  const created = await mgmt.createRole({
    code: "audit_viewer",
    name: "审计查看",
    scopeType: "GROUP",
    permissions: ["media:review", "media:review"],
  });
  assert.equal(created.role.code, "AUDIT_VIEWER");
  assert.deepEqual(created.permissions, ["media:review"]);
  const impact = await mgmt.roleImpact(cloud.ids.roles.reviewer, { limit: 50, offset: 0 });
  assert.equal(impact.totalAssignments, 1);
  assert.equal(impact.hasMore, false);
  const updated = await mgmt.updateRolePermissions(cloud.ids.roles.reviewer, {
    expectedVersion: 0,
    permissions: ["group:member:manage"],
  });
  assert.equal(updated.role.version, 1);
  await assert.rejects(
    () => mgmt.updateRolePermissions(cloud.ids.roles.reviewer, { expectedVersion: 0, permissions: [] }),
    (error) => error.code === "VERSION_CONFLICT",
  );
  const assigned = await mgmt.assignRole({
    accountId: cloud.ids.member,
    roleId: cloud.ids.roles.reviewer,
    groupId: cloud.ids.groups.a,
  });
  assert.equal(assigned.groupId, cloud.ids.groups.a);
  await assert.rejects(
    () => mgmt.assignRole({ accountId: cloud.ids.newbie, roleId: cloud.ids.roles.reviewer, groupId: cloud.ids.groups.b }),
    (error) => error.code === "INVALID_AUTHORIZATION",
  );
});

test("审计只读分页且字段收敛", async (t) => {
  const { cloud, mgmt } = await setup(t);
  await mgmt.renameGroup(cloud.ids.groups.a, { name: "审计组", expectedVersion: 0 });
  const page = await mgmt.auditEvents({ limit: 10, offset: 0 });
  assert.ok(page.total >= 1);
  for (const event of page.items) {
    assert.deepEqual(Object.keys(event).sort(), ["actorAccountId", "createdAt", "eventType", "id", "targetId"]);
  }
});

test("权限不足 403 与限流 429 原样映射；错误不含云端原始 message", async (t) => {
  const { mgmt } = await setup(t, { as: "leader", cert: "clientReader" });
  await assert.rejects(() => mgmt.accounts({}), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.status, 403);
    assert.equal(String(error.message).includes("FORBIDDEN"), false);
    return true;
  });
  const owner = await setup(t);
  owner.cloud.failNext(429, "RATE_LIMITED");
  await assert.rejects(() => owner.mgmt.accounts({}), (error) => {
    assert.equal(error.code, "RATE_LIMITED");
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterMs > 0);
    return true;
  });
});

test("401 撤销会话后清本地登录态，且后续管理请求不能再拿旧令牌", async (t) => {
  const { cloud, mgmt, auth } = await setup(t);
  cloud.revokeAllSessions();
  await assert.rejects(() => mgmt.profile(), (error) => error.code === "UNAUTHORIZED" || error.status === 401);
  assert.equal(auth.getState().state, "needs-login");
  assert.equal(auth.getState().username, null);
  // 等待 profile 并发请求全部落地后再清计数，避免把"清会话前已发出"的请求算进去。
  await new Promise((resolve) => setTimeout(resolve, 150));
  cloud.requests.length = 0;
  await assert.rejects(() => mgmt.accounts({}));
  assert.equal(cloud.requests.length, 0, "清会话后不得再向云端发请求，更不能带旧 Bearer");
});

test("本人改密成功后清会话，新密码可重新登录", async (t) => {
  const { mgmt, auth, cloud } = await setup(t);
  await mgmt.changePassword({ currentPassword: PASSWORD, newPassword: "a brand new password" });
  assert.equal(auth.getState().state, "needs-login");
  await auth.login({ username: "owner", password: "a brand new password" });
  assert.equal(auth.getState().state, "logged-in");
  assert.equal(cloud.state.accounts.get(cloud.ids.owner).password, "a brand new password");
});

test("排队写操作在入队时绑定代次：owner→admin 切换后旧写 STALE，不会用新身份执行", async (t) => {
  const { cloud, auth, mgmt } = await setup(t);
  const { arrived, release } = holdFirstProxy(auth);
  const first = mgmt.createAccount({ username: "queue-first", displayName: "第一笔" });
  await arrived;
  // 第二笔已在本地排队，但用的是 owner 代次；随后切到 admin 证书并登录。
  const second = mgmt.createAccount({ username: "queue-after-switch", displayName: "不得执行" });
  await auth.logout();
  await configureWith(auth, cloud, cloud.clientAdmin);
  await auth.login({ username: "admin", password: PASSWORD });
  const before = cloud.requests.length;
  release();
  const outcomes = await Promise.allSettled([first, second]);
  assert.equal(outcomes[0].status, "rejected");
  assert.equal(outcomes[1].status, "rejected");
  assert.equal(outcomes[1].reason.code, "STALE");
  assert.equal(
    [...cloud.state.accounts.values()].some((item) => item.username === "queue-after-switch"),
    false,
    "旧身份排队的写不能落到新身份的云端",
  );
  const posts = cloud.requests
    .slice(before)
    .filter((item) => item.method === "POST" && item.path === "/api/v1/accounts");
  assert.equal(posts.length, 0, "旧写开始前就应被 STALE 拦下，不能发云请求");
  // 新身份之后的新写仍应正常执行，不能把整个队列卡死。
  const fresh = await mgmt.createAccount({ username: "queue-admin-ok", displayName: "管理员新建" });
  assert.equal(fresh.username, "queue-admin-ok");
});

test("排队写绑定代次：同账户重新登录、仅退出、切换配置都会拦下未开始的旧写", async (t) => {
  const { cloud, auth, mgmt } = await setup(t);

  // 同账户重新登录：旧 JWT 已作废，旧排队写也不能借新登录执行。
  {
    const { arrived, release } = holdFirstProxy(auth);
    const first = mgmt.createAccount({ username: "relogin-first", displayName: "第一笔" });
    await arrived;
    const second = mgmt.createAccount({ username: "relogin-old", displayName: "同账户重登" });
    await auth.logout();
    await auth.login({ username: "owner", password: PASSWORD });
    const before = cloud.requests.length;
    release();
    await Promise.allSettled([first, second]);
    const outcomes = await Promise.allSettled([second]);
    assert.equal(outcomes[0].reason.code, "STALE");
    assert.equal(
      cloud.requests
        .slice(before)
        .filter((item) => item.method === "POST" && item.path === "/api/v1/accounts").length,
      0,
    );
    assert.equal([...cloud.state.accounts.values()].some((item) => item.username === "relogin-old"), false);
  }

  // 仅退出不重登：旧排队写必须 STALE，且不发请求。
  {
    const { arrived, release } = holdFirstProxy(auth);
    const first = mgmt.createAccount({ username: "logout-first", displayName: "第一笔" });
    await arrived;
    const second = mgmt.createAccount({ username: "logout-old", displayName: "退出后" });
    await auth.logout();
    const before = cloud.requests.length;
    release();
    await Promise.allSettled([first]);
    await assert.rejects(second, (error) => error.code === "STALE");
    assert.equal(
      cloud.requests
        .slice(before)
        .filter((item) => item.method === "POST" && item.path === "/api/v1/accounts").length,
      0,
    );
  }

  // 只切换高级配置（不登录）：旧排队写同样不能继续。
  await auth.login({ username: "owner", password: PASSWORD });
  {
    const { arrived, release } = holdFirstProxy(auth);
    const first = mgmt.createAccount({ username: "config-first", displayName: "第一笔" });
    await arrived;
    const second = mgmt.createAccount({ username: "config-old", displayName: "切配置后" });
    await configureWith(auth, cloud, cloud.clientAdmin);
    const before = cloud.requests.length;
    release();
    await Promise.allSettled([first]);
    await assert.rejects(second, (error) => error.code === "STALE");
    assert.equal(
      cloud.requests
        .slice(before)
        .filter((item) => item.method === "POST" && item.path === "/api/v1/accounts").length,
      0,
    );
  }
});

test("旧改密任务的清会话不会覆盖排队期间的新登录", async (t) => {
  const { auth, mgmt } = await setup(t);
  let release;
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const realForget = auth.forgetSession.bind(auth);
  auth.forgetSession = async (reason, options) => {
    reached();
    await gate;
    return realForget(reason, options);
  };

  const changing = mgmt.changePassword({
    currentPassword: PASSWORD,
    newPassword: "a brand new password",
  });
  await Promise.race([
    entered,
    changing.then(
      () => {
        throw new Error("changePassword 未进入清会话收尾");
      },
      (error) => {
        throw error;
      },
    ),
  ]);
  // 云端已改密、旧任务正在收尾时，用户用新密码重新登录。
  await auth.login({ username: "owner", password: "a brand new password" });
  release();
  await assert.rejects(changing, (error) => error.code === "STALE");
  assert.equal(auth.getState().state, "logged-in", "旧任务的 forgetSession 不能清掉新会话");
  assert.equal(auth.getState().username, "owner");
});

test("仅 account:create 的自定义角色可创建账户，但不能读取全局列表", async (t) => {
  const { cloud, mgmt } = await setup(t, { as: "creator", cert: "clientCreator" });
  await assert.rejects(() => mgmt.accounts({}), (error) => {
    assert.equal(error.code, "FORBIDDEN");
    assert.equal(error.status, 403);
    return true;
  });
  const opening = await mgmt.createAccount({ username: "created.by.only", displayName: "仅创建" });
  assert.equal(opening.username, "created.by.only");
  assert.match(opening.openingCode, /^[A-Za-z0-9_-]{43}$/);
  assert.equal([...cloud.state.accounts.values()].some((item) => item.username === "created.by.only"), true);
});

test("管理方法不暴露任意路径：注入型 ID/查询被拒绝，且请求只落在固定路径", async (t) => {
  const { cloud, mgmt } = await setup(t);
  await assert.rejects(() => mgmt.group("../me"), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => mgmt.group("a/b"), (error) => error.code === "INVALID_REQUEST");
  await assert.rejects(() => mgmt.removeMember(cloud.ids.groups.a, "../../me", { expectedVersion: 0 }), (error) => error.code === "INVALID_REQUEST");
  assert.equal(cloud.requests.some((item) => item.path.includes("..")), false);
});

test("未登录/未配置时给出固定错误码，不泄露本机路径", async (t) => {
  const { auth, lib } = await setup(t, { as: null });
  const mgmt = new CloudManagement(lib, { cloudAuth: auth });
  await assert.rejects(() => mgmt.profile(), (error) => {
    assert.equal(error.code, "NOT_LOGGED_IN");
    assert.equal(String(error.message).includes("/Users/"), false);
    return true;
  });
});

test("profile 的 3 个云请求复用受控连接池，重复刷新零握手", async (t) => {
  const { auth, cloud, mgmt } = await setup(t);
  const base = cloud.secureConnections();
  const profile = await mgmt.profile();
  assert.equal(profile.me.username, "owner");
  const firstWave = cloud.secureConnections() - base;
  assert.ok(firstWave >= 1 && firstWave <= 4, `首轮 profile 连接数应在 1..4，实际 ${firstWave}`);

  const beforeSecond = cloud.secureConnections();
  await mgmt.profile();
  assert.equal(cloud.secureConnections(), beforeSecond, "再次刷新不得重新握手");

  const pool = auth.getConnectionPoolInfo();
  assert.equal(pool.configured, true);
  assert.ok(pool.freeSockets >= 1 && pool.freeSockets <= 4);
});

