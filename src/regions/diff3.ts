// 行级三路合并(diff3): base=上次同步的文本, mine=笔记导出, theirs=磁盘当前。
// 非重叠的两边改动自动合并; 重叠处产出冲突标记并标记 conflict=true(调用方决定写盘还是弹 UI)。
// 纯函数, 无依赖, 便于离屏单测。

function lcsPairs(x: string[], y: string[]): Array<[number, number]> {
  const n = x.length;
  const m = y.length;
  // dp[i][j] = LCS 长度 of x[i:], y[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

function eqArr(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export interface Diff3Result {
  merged: string;
  conflict: boolean;
}

/** base/mine/theirs 三路行级合并。冲突处用 <<<<<<< / ======= / >>>>>>> 标记并 conflict=true。 */
export function diff3(baseS: string, mineS: string, theirsS: string): Diff3Result {
  // 两边完全没改 / 一边没改 的快路径
  if (mineS === theirsS) return { merged: mineS, conflict: false };
  if (baseS === mineS) return { merged: theirsS, conflict: false }; // 只有外部改
  if (baseS === theirsS) return { merged: mineS, conflict: false }; // 只有本地改

  const O = baseS.split("\n");
  const A = mineS.split("\n");
  const B = theirsS.split("\n");
  const aOf = new Map<number, number>();
  for (const [o, a] of lcsPairs(O, A)) aOf.set(o, a);
  const bOf = new Map<number, number>();
  for (const [o, b] of lcsPairs(O, B)) bOf.set(o, b);

  const out: string[] = [];
  let conflict = false;
  let oi = 0;
  let ai = 0;
  let bi = 0;

  for (;;) {
    // 下一个"锚点": base 行同时在 mine 和 theirs 里都对得上
    let k = oi;
    while (k < O.length && !(aOf.has(k) && bOf.has(k))) k++;
    const aEnd = k < O.length ? aOf.get(k)! : A.length;
    const bEnd = k < O.length ? bOf.get(k)! : B.length;
    const oReg = O.slice(oi, k);
    const aReg = A.slice(ai, aEnd);
    const bReg = B.slice(bi, bEnd);
    const aChanged = !eqArr(oReg, aReg);
    const bChanged = !eqArr(oReg, bReg);

    if (!aChanged && !bChanged) out.push(...oReg);
    else if (aChanged && !bChanged) out.push(...aReg);
    else if (!aChanged && bChanged) out.push(...bReg);
    else if (eqArr(aReg, bReg)) out.push(...aReg); // 两边改成一样
    else {
      conflict = true;
      out.push("<<<<<<< 笔记(本地)");
      out.push(...aReg);
      out.push("=======");
      out.push(...bReg);
      out.push(">>>>>>> 源文件(外部)");
    }

    if (k >= O.length) break;
    out.push(O[k]); // 锚点行
    oi = k + 1;
    ai = aEnd + 1;
    bi = bEnd + 1;
  }

  return { merged: out.join("\n"), conflict };
}
