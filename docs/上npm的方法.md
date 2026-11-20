# 上 npm 的方法（dsh-memory-tree，本机实测）

> 写给下次的自己或接手的人。所有结论都在这台机器上真跑过。
> 换机器要跟着改路径。

---

## 0. 当前状态快照（2026-11-20 核实）

| 项 | 值 |
| --- | --- |
| npm 包名 | **`dsh-dual-memory-tree`**（原名 `dsh-memory-tree` 已被他人占用） |
| GitHub 仓库 | `John4874314/dsh-memory-tree`（仓库名未改） |
| 版本 | `0.1.0`（未发布） |
| npm 上是否存在 | **不存在**（HTTP 404，名字可用） |
| 本机有 npm? | **没有**，只有 `node` / `pnpm` / `python` |
| 本机有 npm 凭据? | **没有**，`.npmrc` 只有 `registry=npmmirror` |
| CI workflow | 已就位 `.github/workflows/publish.yml` |

---

## 1. 一个必须先知道的限制

**npm 不支持为尚不存在的包预配置 Trusted Publisher。**

配置入口挂在包自己的 Settings 页（`npmjs.com/package/<name>/access`）。
包不存在 → 没有那个页面 → 配不了 → OIDC 发布一个全新包会失败。

一手证据：

- [npm/documentation#1926](https://github.com/npm/documentation/issues/1926)（仍 OPEN）
  > attempting to publish a package for the first time using a GitHub Actions workflow
  > with OIDC **failed**. The publish step did not succeed when the package did not yet
  > exist on NPM.

- [npm/cli#8544](https://github.com/npm/cli/issues/8544)
  > "We determined to not have 'first publish' available to limit scope in our MVP"

**所以顺序固定是：手动发第一次 → 包存在 → 配 Trusted Publisher → 之后全交给 CI。**

---

## 2. 首次发布（只有这一次需要手动）

```powershell
cd E:\dsh-workspace\project\dsh-memory-tree\plugins\dsh-memory-tree

$node = 'E:\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$pnpm = 'E:\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs'

# 1) 登录（会开浏览器，需要在网页上确认）
& $node $pnpm login --registry=https://registry.npmjs.org

# 2) 发布 —— 必须显式指定官方源！
#    你本机 .npmrc 里是 registry=npmmirror，淘宝镜像是只读的，
#    不指定 --registry 会推到一个根本不能发布的地方。
& $node $pnpm publish --registry=https://registry.npmjs.org --no-git-checks
```

**为什么用 pnpm 而不是 npm**：本机没有 npm。pnpm 的 `publish` 与 npm 兼容，
读同一个 `package.json`、同一个 `files` 白名单、生成同一种 tarball。

---

## 3. 配置 Trusted Publisher

包发出来后，打开：

```
https://www.npmjs.com/package/dsh-dual-memory-tree/access
```

**Settings → Trusted publishing → Add trusted publisher**，填：

| 字段 | 值 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `John4874314` |
| Repository | `dsh-memory-tree` |
| Workflow filename | `publish.yml` |
| Environment name | （留空） |
| Allowed actions | 勾 **Allow npm publish** |

⚠️ `Workflow filename` 只填文件名，**不要带 `.github/workflows/` 前缀**。

---

## 4. 之后的发布（全自动）

```powershell
cd E:\dsh-workspace\project\dsh-memory-tree\plugins\dsh-memory-tree
$git = 'C:\Users\29879\AppData\Local\GitHubDesktop\app-3.6.7\resources\app\git\cmd\git.exe'

# 三处版本必须一起改：package.json / README 首条 ### x.y.z / 即将打的 tag
& $git add -A
& $git commit -m "release: 0.1.1"
& $git tag v0.1.1

# 推送（本机 github.com:443 不通，走 API）
& $node E:\dsh-workspace\project\dsh-memory-tree\push-to-github.mjs
# 然后单独推 tag：见第 6 节
```

`push-to-github.mjs` **不推 tag**（只推 refs/heads/main），tag 需要另外用 API 建。

---

## 5. CI 会做什么（`.github/workflows/publish.yml`）

打 `vX.Y.Z` tag 触发，四步任一红就不发：

1. **引擎自检** —— `node test/*.test.mjs`
   > 注意：我们的测试是**自研 check 断言**，不是 `node:test`。
   > 它靠 `process.exitCode = 1` 报错，所以直接 `node` 跑，**不能用 `node --test`**。
2. **版本一致性** —— `tag` / `package.json` / README 首条 `### x.y.z` 三者必须相同
3. **打包清单** —— 黑名单（`test/` `.github/` `.memory-tree/` `memory-data/`）
   + 白名单（`index.js` `client.js` `cordis.patch.yml` `lib/engine.js` 必须在包里）
4. **`npm publish --provenance`** —— 用 OIDC，不需要任何 token

---

## 6. 两个坑（都真实踩过）

### 坑一：`setup-node` 传 `registry-url` 会导致 **404**

```yaml
- uses: actions/setup-node@v4
  with:
    node-version: 22
    # 绝对不要加 registry-url
```

传了它，`setup-node` 会往 `.npmrc` 写 `_authToken=${NODE_AUTH_TOKEN}` 并注入占位值。
npm 拿假 token 去认证，registry **PUT 返回 404 而不是 401**——看着像「包不存在」，
极难从错误信息反推真因。

### 坑二：npm 版本必须 >= 11.5.0

Node 22 自带 npm 10.x。老 npm **只认 token，不认 OIDC**，报 `ENEEDAUTH`。

```yaml
- run: npm install -g npm@latest
```

---

## 7. 发 tag（API 方式，因为 github.com 不通）

`push-to-github.mjs` 只管分支。tag 要单独建：

```powershell
# 用 GitHub Git Data API：POST /repos/{owner}/{repo}/git/refs
# body: { ref: "refs/tags/v0.1.0", sha: "<commit sha>" }
```

见下方 `tag.mjs`。

---

## 8. 验证真的发出去了

```powershell
$node -e "(async()=>{const r=await fetch('https://registry.npmjs.org/dsh-dual-memory-tree');const j=await r.json();console.log('latest =',j['dist-tags'].latest);console.log('provenance =',j.versions[j['dist-tags'].latest]?.dist?.attestations?'有':'无')})()"
```

---

## 9. 回退

**npm 的版本不能删也不能覆盖**（72 小时后连 unpublish 都不允许）。

```powershell
# 发补丁版
# 让坏版本从 latest 上下来
& $node $pnpm deprecate 'dsh-dual-memory-tree@0.1.0' "这个版本有问题，请升级到 0.1.1" --registry=https://registry.npmjs.org
```

**打错 tag 但还没推**：`& $git tag -d v0.1.0`
**tag 已推上去**（CI 可能已在跑）：删远端 tag 再删本地。注意：CI 已发布成功的话，
删 tag 不会撤回 npm 上的包。

---

## 10. 一次性检查清单

- [ ] 全部测试通过（`node test/engine.test.mjs` 应为 0 失败）
- [ ] `package.json` 版本 = README 首条 `### x.y.z` = 即将打的 tag
- [ ] `pack --dry-run` 里没有 `test/` `.github/` `.memory-tree/` `memory-data/`
- [ ] 先推 commit，再推 tag
- [ ] Actions 里四步全绿
- [ ] registry 上 `latest` 是新版本，且 provenance 有
- [ ] GitHub 上建了对应 Release

---

## 11. 撞名事故记录

原定包名 `dsh-memory-tree`，2026-11-20 发现已被占用：

```
latest      0.4.1
作者        xuyanjun <4332936@qq.com>
仓库        github.com/qinghuaju/dsh-memory-tree
描述        AST soft-decision-tree long-term memory for DeepSeek Harness
```

同一 DSH 生态、同样叫记忆树，但**是另一个人的另一个实现**（SQLite + embeddings）。

改名时**只动了两处**：

```
package.json  "name": "dsh-dual-memory-tree"
README.md     标题
```

**其它标识符一律不动**，因为数据目录与包名无关：

```js
// lib/engine.js
export function habitHostDir(dshHome) {
  return path.join(dshHome, 'memory-tree')   // 写死的
}
```

所以改名不影响已安装用户的数据。以下标识符也保持原样：

| 标识符 | 值 |
| --- | --- |
| `index.js` `export const name` | `dsh-memory-tree` |
| `index.js` `ROUTE` | `/dsh-memory-tree` |
| `client.js` `id` | `dsh-memory-tree` |
| `cordis.patch.yml` `id`/`name` | `dsh-memory-tree` |
