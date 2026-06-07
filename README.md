# 🃏 炸金花 - 多人实时在线游戏

好友娱乐专属，⚠️ 仅供娱乐，禁止赌博！

## 快速开始（局域网）

```bash
npm install
node server.js
```

访问 http://localhost:3000

## 永久外网访问（推荐）

### 步骤 1: 创建 GitHub 仓库
1. 打开 https://github.com/new
2. 仓库名: `zha-jin-hua`
3. 选 Public
4. 点 Create repository

### 步骤 2: 推送代码
```bash
cd C:\zha
git init
echo node_modules/ > .gitignore
echo cloudflared.exe >> .gitignore
echo cf.exe >> .gitignore
echo "*.log" >> .gitignore
git add .
git commit -m "initial"
git remote add origin https://github.com/你的用户名/zha-jin-hua.git
git push -u origin main
```

### 步骤 3: 部署到 Render.com（免费）
1. 打开 https://render.com 注册/登录（可以用GitHub账号）
2. 点 "New" → "Web Service"
3. 连接刚才的 GitHub 仓库
4. 设置:
   - Build Command: `npm install`
   - Start Command: `node server.js`
5. 点 "Create Web Service"
6. 等几分钟部署完成 → 得到永久链接 `https://xxx.onrender.com`

### 🎉 把链接发给朋友就能玩了！

## 游戏规则
- 6位数字房间号，最多6人
- 初始1000积分，底注5-100分
- 闷牌（暗牌）下注=当前注额，明牌下注=当前注额×2
- 比牌时平局 → 挑战者输
- 牌型大小: 豹子 > 同花顺 > 同花 > 顺子 > 对子 > 散牌
- 最长30轮自动摊牌

## 技术栈
- Node.js + Express
- Socket.io (WebSocket实时通信)
- 纯HTML/CSS/JS前端
