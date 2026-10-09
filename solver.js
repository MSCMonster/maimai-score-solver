/**
 * maimai DX 判定分布反推求解器 (纯 JS, 精确解)
 *
 * 使用专用的整数 DP 求精确解:
 *
 * 以"全 Critical Perfect"为满分, 每个判定只会造成两种整数损失:
 *   M: 基础分损失, 单位 = 50 分 x 倍率. 普通音符 great/good/miss = 2r/5r/10r, break = 10/20/25/30/50
 *   X: 绝赞额外分损失, 单位 = 5 分. break p75/p50/great/good/miss = 5/10/12/14/20
 * 达成率损失(0.0001%) = 1e6 * M / B + 1e4 * X / E
 *   B = sum(倍率 * 10 * 物量), E = 20 * break 物量
 * 两边同乘 B*E 后全部是整数, 不会有浮点误差.
 *
 * 求解:
 *   1. 普通音符: 每类做"最少音符数凑出 w"的 DP, 得到可达集合, 再逐类卷积得到普通音符可达的 M 集合
 *   2. break: 对 (X, M/5) 做二维 DP, 记录最小"不自然度"
 *   3. 枚举 break 的每个可达状态, 用前缀最大值 O(1) 查普通音符能补的最大 M,
 *      取"达成率 >= 目标且最低"的方案, 同达成率时取 break 不自然度最低的
 *
 * 浏览器里挂到 window.MaiSolver, Node 里 module.exports.
 */
(function (root) {
    'use strict';

    const NOTE_TYPES = ['tap', 'hold', 'slide', 'touch', 'break'];
    const NORMAL_TYPES = ['tap', 'hold', 'slide', 'touch'];
    const NOTE_LABELS = { tap: 'TAP', hold: 'HOLD', slide: 'SLIDE', touch: 'TOUCH', break: 'BREAK' };
    const RATE = { tap: 1, hold: 2, slide: 3, touch: 1, break: 5 };

    // tier: 0 完美档, 1 great, 2 good, 3 miss. 用于 FC/FC+/AP 约束
    const JUDGES = {
        normal: [
            { key: 'cp', label: 'Critical Perfect', short: 'CP', tier: 0, dx: 3 },
            { key: 'p', label: 'Perfect', short: 'P', tier: 0, dx: 2 },
            { key: 'great', label: 'Great', short: 'GR', tier: 1, dx: 1, m: 2 },
            { key: 'good', label: 'Good', short: 'GD', tier: 2, dx: 0, m: 5 },
            { key: 'miss', label: 'Miss', short: 'MS', tier: 3, dx: 0, m: 10 },
        ],
        // mb: M 损失 / 5, x: X 损失, cost: 不自然度
        break: [
            { key: 'cp', label: 'Critical Perfect', short: 'CP', tier: 0, dx: 3, mb: 0, x: 0, cost: 0 },
            { key: 'p1', label: 'Perfect (2550)', short: 'P', tier: 0, dx: 2, mb: 0, x: 5, cost: 1 },
            { key: 'p2', label: 'Perfect (2525)', short: 'P', tier: 0, dx: 2, mb: 0, x: 10, cost: 2 },
            { key: 'g1', label: 'Great (2000)', short: 'GR', tier: 1, dx: 1, mb: 2, x: 12, cost: 3 },
            { key: 'g2', label: 'Great (1500)', short: 'GR', tier: 1, dx: 1, mb: 4, x: 12, cost: 4 },
            { key: 'g3', label: 'Great (1250)', short: 'GR', tier: 1, dx: 1, mb: 5, x: 12, cost: 5 },
            { key: 'good', label: 'Good (1000)', short: 'GD', tier: 2, dx: 0, mb: 6, x: 14, cost: 8 },
            { key: 'miss', label: 'Miss', short: 'MS', tier: 3, dx: 0, mb: 10, x: 20, cost: 15 },
        ],
    };

    const CONSTRAINTS = {
        none: { label: '无限制', maxTier: 3 },
        fc: { label: 'FC', maxTier: 2 },
        fcp: { label: 'FC+', maxTier: 1 },
        ap: { label: 'AP', maxTier: 0 },
    };

    const judgesOf = (type) => (type === 'break' ? JUDGES.break : JUDGES.normal);

    /** 单类普通音符: 用 <= n 个音符能凑出的 w (损失 = 倍率 * w) 的最少音符数 */
    function minNotesTable(n, coins) {
        const max = 10 * n;
        const dp = new Uint32Array(max + 1).fill(0xffffffff);
        dp[0] = 0;
        for (let w = 1; w <= max; w++) {
            for (const c of coins) {
                if (c <= w && dp[w - c] + 1 < dp[w]) dp[w] = dp[w - c] + 1;
            }
        }
        return dp;
    }

    /** 可达 w 的极大连续区间 [a, b] 列表 */
    function toIntervals(dp, n) {
        const out = [];
        let start = -1;
        for (let w = 0; w <= dp.length; w++) {
            const ok = w < dp.length && dp[w] <= n;
            if (ok && start < 0) start = w;
            if (!ok && start >= 0) {
                out.push([start, w - 1]);
                start = -1;
            }
        }
        return out;
    }

    /**
     * cur 与 {rate * w | w in intervals} 做布尔卷积.
     * 对每个区间用同余类前缀和判断窗口内是否有可达点, 复杂度 O(范围 * 区间数)
     */
    function convolve(cur, rate, intervals, newMax) {
        const pre = new Uint32Array(newMax + 1); // pre[v] = sum cur[v], cur[v-rate], ...
        for (let v = 0; v <= newMax; v++) pre[v] = (v < cur.length ? cur[v] : 0) + (v >= rate ? pre[v - rate] : 0);
        const out = new Uint8Array(newMax + 1);
        for (let v = 0; v <= newMax; v++) {
            for (const [a, b] of intervals) {
                const hi = v - rate * a; // 最大的 cur 下标
                if (hi < 0) continue;
                const lo = v - rate * (b + 1); // 不含
                if (pre[hi] - (lo >= 0 ? pre[lo] : 0) > 0) {
                    out[v] = 1;
                    break;
                }
            }
        }
        return out;
    }

    /** 给定单类损失 w, 选 great 尽量多 (miss 最少, 其次 good 最少) 的组合 */
    function splitNormal(w, n, coins) {
        const allowGood = coins.includes(5);
        const allowMiss = coins.includes(10);
        for (let m = 0; m <= (allowMiss ? Math.floor(w / 10) : 0); m++) {
            const r = w - 10 * m;
            for (let g = r % 2; g <= (allowGood ? Math.floor(r / 5) : 0); g += 2) {
                const a = (r - 5 * g) / 2;
                if (a + g + m <= n) return { great: a, good: g, miss: m };
            }
        }
        return null;
    }

    /**
     * @param {object} input
     * @param {Record<string, number>} input.counts   各类音符物量
     * @param {number} input.target                   目标达成率, 单位 0.0001% (1005000 = 100.5000%)
     * @param {'none'|'fc'|'fcp'|'ap'} [input.constraint]
     * @param {number|null} [input.targetDx]          目标 DX 分, 为空则全部给 CP
     */
    function solve(input) {
        const t0 = Date.now();
        const counts = {};
        for (const t of NOTE_TYPES) counts[t] = Math.max(0, Math.floor(Number(input.counts[t]) || 0));
        const constraint = CONSTRAINTS[input.constraint] ? input.constraint : 'none';
        const maxTier = CONSTRAINTS[constraint].maxTier;
        const target = Math.floor(Number(input.target) || 0);
        const targetDx = input.targetDx == null || input.targetDx === '' ? null : Math.floor(Number(input.targetDx));

        const totalNotes = NOTE_TYPES.reduce((s, t) => s + counts[t], 0);
        if (totalNotes === 0) return { ok: false, message: '物量全为 0' };

        const nb = counts.break;
        const B = NOTE_TYPES.reduce((s, t) => s + RATE[t] * 10 * counts[t], 0);
        const E = nb > 0 ? 20 * nb : 1;
        const scale = B * E;
        const alpha = 1e6 * E; // 每单位 M 的损失 (乘以 scale 后)
        const beta = 1e4 * B; // 每单位 X 的损失
        const maxExact = 1000000 + (nb > 0 ? 10000 : 0);
        const achievementOf = (F) => Math.floor((maxExact * scale - F) / scale);

        // ---- 1. 普通音符可达的 M 集合 ----
        const coins = JUDGES.normal.filter((j) => j.m && j.tier <= maxTier).map((j) => j.m);
        const normals = NORMAL_TYPES.filter((t) => counts[t] > 0).map((t) => {
            const dp = coins.length ? minNotesTable(counts[t], coins) : new Uint32Array(1);
            return { type: t, n: counts[t], rate: RATE[t], dp, intervals: toIntervals(dp, counts[t]) };
        });
        const stages = [Uint8Array.of(1)];
        let nMax = 0;
        for (const s of normals) {
            nMax += s.rate * (s.dp.length - 1);
            stages.push(convolve(stages[stages.length - 1], s.rate, s.intervals, nMax));
        }
        const reach = stages[stages.length - 1];
        const prefMax = new Int32Array(nMax + 1); // <= v 的最大可达 M, 不存在为 -1
        for (let v = 0, last = -1; v <= nMax; v++) prefMax[v] = last = reach[v] ? v : last;

        // ---- 2. break 的 (X, M/5) 二维 DP ----
        const bj = JUDGES.break.filter((j) => j.key !== 'cp' && j.tier <= maxTier);
        const XW = 20 * nb + 1;
        const MW = 10 * nb + 1;
        const bCost = new Uint32Array(XW * MW).fill(0xffffffff);
        const bCnt = new Uint16Array(XW * MW);
        const bPar = new Int8Array(XW * MW).fill(-1);
        bCost[0] = 0;
        for (let x = 1; x < XW; x++) {
            for (let mb = 0; mb < MW; mb++) {
                const idx = x * MW + mb;
                for (let k = 0; k < bj.length; k++) {
                    const j = bj[k];
                    if (j.x > x || j.mb > mb) continue;
                    const p = (x - j.x) * MW + (mb - j.mb);
                    if (bCost[p] === 0xffffffff || bCnt[p] + 1 > nb) continue;
                    const c = bCost[p] + j.cost;
                    if (c < bCost[idx] || (c === bCost[idx] && bCnt[p] + 1 < bCnt[idx])) {
                        bCost[idx] = c;
                        bCnt[idx] = bCnt[p] + 1;
                        bPar[idx] = k;
                    }
                }
            }
        }

        // ---- 3. 枚举 break 状态, 普通音符补齐 ----
        const T = (maxExact - target) * scale; // 允许的最大损失
        let best = null;
        if (T >= 0) {
            for (let x = 0; x < XW; x++) {
                const budget = T - beta * x;
                if (budget < 0) break;
                const mCap = Math.floor(budget / alpha);
                for (let mb = 0; mb < MW; mb++) {
                    const idx = x * MW + mb;
                    if (bCost[idx] === 0xffffffff) continue;
                    const rem = mCap - 5 * mb;
                    if (rem < 0) break;
                    const mn = prefMax[Math.min(rem, nMax)];
                    if (mn < 0) continue;
                    const F = alpha * (5 * mb + mn) + beta * x;
                    const ach = achievementOf(F);
                    if (!best || ach < best.ach || (ach === best.ach && bCost[idx] < best.cost)) {
                        best = { ach, cost: bCost[idx], x, mb, mn };
                    }
                }
            }
        }
        // 目标高于理论值 (或无解) 时退回全 CP
        if (!best) best = { ach: maxExact, cost: 0, x: 0, mb: 0, mn: 0 };

        // ---- 还原分布 ----
        const distribution = {};
        for (const t of NOTE_TYPES) {
            if (counts[t] === 0) continue;
            distribution[t] = Object.fromEntries(judgesOf(t).map((j) => [j.key, 0]));
        }
        // break
        if (nb > 0) {
            let x = best.x, mb = best.mb, used = 0;
            while (x > 0) {
                const j = bj[bPar[x * MW + mb]];
                distribution.break[j.key]++;
                used++;
                x -= j.x;
                mb -= j.mb;
            }
            distribution.break.cp = nb - used;
        }
        // 普通音符: 从后往前, 每类取最接近"按容量比例分摊"的值
        let left = best.mn;
        for (let i = normals.length - 1; i >= 0; i--) {
            const s = normals[i];
            const prev = stages[i];
            const capLeft = normals.slice(0, i + 1).reduce((a, q) => a + q.rate * (q.dp.length - 1), 0);
            const share = capLeft ? (left * s.rate * (s.dp.length - 1)) / capLeft : 0;
            let pick = -1;
            for (let w = 0; w < s.dp.length; w++) {
                if (s.dp[w] > s.n) continue;
                const rest = left - s.rate * w;
                if (rest < 0) break;
                if (rest < prev.length && prev[rest] && (pick < 0 || Math.abs(s.rate * w - share) < Math.abs(s.rate * pick - share))) pick = w;
            }
            const sp = splitNormal(pick, s.n, coins);
            Object.assign(distribution[s.type], sp);
            distribution[s.type].cp = s.n - sp.great - sp.good - sp.miss;
            left -= s.rate * pick;
        }

        // ---- DX 分: 普通音符 CP/P 不影响达成率, 用来贴近目标 DX ----
        const dxOf = () => NOTE_TYPES.reduce((s, t) => s + (distribution[t]
            ? judgesOf(t).reduce((a, j) => a + j.dx * distribution[t][j.key], 0) : 0), 0);
        if (targetDx != null) {
            let need = dxOf() - targetDx; // 每把一个普通 CP 改成 P, DX -1
            for (const s of normals) {
                if (need <= 0) break;
                const d = distribution[s.type];
                const k = Math.min(need, d.cp);
                d.cp -= k;
                d.p += k;
                need -= k;
            }
        }

        // 校验物量守恒
        for (const t of Object.keys(distribution)) {
            const sum = Object.values(distribution[t]).reduce((a, b) => a + b, 0);
            if (sum !== counts[t]) return { ok: false, message: `内部错误: ${t} 物量不守恒` };
        }

        return {
            ok: true,
            distribution,
            achievement: best.ach,
            target,
            maxAchievement: maxExact,
            exact: best.ach === target,
            dx: dxOf(),
            dxMax: totalNotes * 3,
            totalNotes,
            constraint,
            elapsed: Date.now() - t0,
        };
    }

    /** 由分布直接计算达成率 (浮点, 用于展示/交叉校验) */
    function scoreOf(counts, distribution) {
        const pts = { cp: 500, p: 500, great: 400, good: 250, miss: 0 };
        const bpts = { cp: [500, 100], p1: [500, 75], p2: [500, 50], g1: [400, 40], g2: [300, 40], g3: [250, 40], good: [200, 30], miss: [0, 0] };
        let base = 0, maxBase = 0, extra = 0;
        for (const t of NOTE_TYPES) {
            maxBase += RATE[t] * 500 * (counts[t] || 0);
            const d = distribution[t];
            if (!d) continue;
            for (const [k, n] of Object.entries(d)) {
                if (t === 'break') {
                    base += RATE[t] * bpts[k][0] * n;
                    extra += bpts[k][1] * n;
                } else base += RATE[t] * pts[k] * n;
            }
        }
        const maxExtra = 100 * (counts.break || 0);
        return (base / maxBase) * 1e6 + (maxExtra ? (extra / maxExtra) * 1e4 : 0);
    }

    const api = { NOTE_TYPES, NOTE_LABELS, RATE, JUDGES, CONSTRAINTS, judgesOf, solve, scoreOf };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MaiSolver = api;
})(typeof window !== 'undefined' ? window : globalThis);
