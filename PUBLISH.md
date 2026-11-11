# 发布指引

本目录已经可以发布。两条渠道都缺**你的账号**，所以下面的命令需要你执行（或者登录后让我执行）。

产物状态：

- `dsh-read-image-0.1.0.tgz` —— 已打包，可直接 `dsh plugin add <tgz>` 安装
- git 仓库已初始化并完成首个提交（分支 `main`）
- `submission/catalog-entry.json` —— 插件广场的收录条目，**把 `<owner>` 换成你的 GitHub 用户名**即可用

---

## 一、Git

### 1. 先在 GitHub 建一个空仓库

名字建议 `dsh-read-image`，**不要**勾选自动生成 README / .gitignore / LICENSE（本地已经有了，否则首推会冲突）。

### 2. 关联并推送

```bash
cd /Users/mac/Desktop/Deepseek_harness/publish/dsh-read-image

# 换成你的用户名
git remote add origin https://github.com/<owner>/dsh-read-image.git
git push -u origin main
```

首次推送会要求认证。用 **Personal Access Token**（`repo` 权限）当密码，不要用账号密码
（GitHub 已不支持密码推送）。建议用 macOS 钥匙串记住：

```bash
git config --global credential.helper osxkeychain
```

> 已把提交作者设成 `dsh-read-image <noreply@localhost>` 是临时的。
> 先设置你自己的身份，再把作者改成你：
>
> ```bash
> git config --global user.name  "你的名字"
> git config --global user.email "你的邮箱"
> git commit --amend --reset-author --no-edit
> git push -f -u origin main        # 首次推送前改作者用 -f
> ```

### 3. 加 topic（**这一步决定会不会被广场自动收录**）

仓库页 → 右侧 About 齿轮 → Topics 填 **`dsh-plugin`**。

广场会定时扫描带这个 topic 的仓库自动收录；掉了 topic 也只在下一次全量对账后才下架。

---

## 二、插件广场（DSH 1024Store）

广场**只提供 npm 安装**。所以顺序是：**先发 npm，再收录**。
没发 npm 也能被收录，但只是"浏览态"（有仓库链接、没有安装命令）。

### 1. 发 npm（必须先做）

```bash
cd /Users/mac/Desktop/Deepseek_harness/publish/dsh-read-image

NODE=/Users/mac/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/node/bin/node
PNPM=/Users/mac/.dsh/dsh-runtimes/dsh-next-primary-runtime/dependencies/pnpm/bin/pnpm.mjs

"$NODE" "$PNPM" login                 # token 只落在 ~/.npmrc，不经过对话
"$NODE" "$PNPM" publish --access public
```

发完验证：

```bash
curl -s https://registry.npmjs.org/dsh-read-image | head -c 200
```

### 2. 提交收录条目

按广场规则（`CONTRIBUTING.md`）：**一个 PR 只能新增一个** `catalog/plugins/<id>.json`，
**不能改别的任何路径**（README 与 catalog/README.md 都是机器人生成的）。

```bash
git clone https://github.com/imsai-sh/awesome-deepseek-harness-plugins.git
cd awesome-deepseek-harness-plugins

# 文件名规则：owner/repository → owner--repository.json
#   把 <owner> 换成你的 GitHub 用户名
cp /Users/mac/Desktop/Deepseek_harness/publish/dsh-read-image/submission/catalog-entry.json \
   catalog/plugins/<owner>--dsh-read-image.json

git checkout -b add-dsh-read-image
git add catalog/plugins/<owner>--dsh-read-image.json
git commit -m "Add <owner>/dsh-read-image"
git push -u origin add-dsh-read-image
```

然后在 GitHub 上开 PR。

条目里必须已经替换好三处 `<owner>`：`id`、`repository`，以及文件名。

> 也可以不提 PR——加好 `dsh-plugin` topic 后等自动收录即可。
> PR 的好处是**当天就能出现在目录里**。

### 3. 分类

`category` 目前填的是 **`tools`**（Tools & Capabilities）。
如果要改，可选值见广场仓库的 `catalog/categories.json`。

---

## 三、检查清单

- [ ] GitHub 仓库已建、`main` 已推
- [ ] 仓库加了 `dsh-plugin` topic
- [ ] npm 已 publish（`latest` 能取到 `0.1.0`）
- [ ] 条目里 3 处 `<owner>` 已替换
- [ ] PR 只新增了 1 个 `catalog/plugins/*.json`
- [ ] 装一次验证：`dsh plugin add dsh-read-image` 后刷新页面，输入框旁出现「视觉」

---

## 四、以后发新版本

```bash
# 改 package.json 的 version
cd /Users/mac/Desktop/Deepseek_harness/publish/dsh-read-image
"$NODE" "$PNPM" pack          # 自检
"$NODE" "$PNPM" publish --access public
git add -A && git commit -m "chore: release 0.1.1" && git tag v0.1.1 && git push --tags
```

⚠️ npm **不允许复用已发布的版本号**——改动必须升版本，不能覆盖重发。
