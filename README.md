# maimai DX 判定分布反推

输入谱面物量和目标达成率, 反推出一组能**恰好达到**该达成率的判定分布 (每种音符各有多少 Critical Perfect / Perfect / Great / Good / Miss).

在线使用: https://mscmonster.github.io/maimai-score-solver/

## 功能

- 曲库搜索: 从 [水鱼查分器](https://www.diving-fish.com/maimaidx/prober/) 拉取曲目数据, 选中谱面后自动填入 TAP / HOLD / SLIDE / TOUCH / BREAK 物量; 曲库加载失败时也可以手动输入
- 目标达成率: 支持任意达成率, 并提供 97% ~ 101% 常用档位快捷按钮
- 判定约束: 无限制 / FC / FC+ / AP
- 目标 DX 分 (可选): 留空时普通音符的完美档全部取 Critical Perfect
- 求得的是"达成率 >= 目标且最低"的方案; 达成率相同时, 优先选择 BREAK 判定更自然的组合

## 算法

计算全部在浏览器本地完成, 使用整数 DP 求精确解, 没有浮点误差. 详见 [`solver.js`](./solver.js) 顶部注释:

以全 Critical Perfect 为满分, 每个判定只会造成两种整数损失:

| 损失 | 含义 |
|---|---|
| M | 基础分损失, 单位 = 50 分 x 倍率 |
| X | 绝赞额外分损失, 单位 = 5 分 |

达成率损失 (单位 0.0001%) = `1e6 * M / B + 1e4 * X / E`, 其中 `B = sum(倍率 * 10 * 物量)`, `E = 20 * BREAK 物量`. 两边同乘 `B * E` 后全部化为整数运算.

1. 普通音符: 每类做"最少音符数凑出 w"的 DP, 再逐类卷积得到可达的 M 集合
2. BREAK: 对 (X, M/5) 做二维 DP, 记录最小"不自然度"
3. 枚举 BREAK 的每个可达状态, 用前缀最大值 O(1) 查询普通音符能补的最大 M, 取最优方案

## 本地运行

纯静态页面, 没有构建步骤和依赖. 直接用浏览器打开 `index.html`, 或者:

```
npx serve .
```

`solver.js` 也可以在 Node 中 `require` 使用 (在浏览器中挂载到 `window.MaiSolver`).

## 致谢

曲库数据来自 [diving-fish/maimaidx-prober](https://github.com/Diving-Fish/maimaidx-prober).

## License

[MIT](./LICENSE)
