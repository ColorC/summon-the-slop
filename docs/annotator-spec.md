# 标注器交互规范(完整就地标注器)

参照成熟工具(Snipaste / Flameshot / Greenshot / ShareX / Skitch / macOS Markup / Snagit / Excalidraw / tldraw)扒齐的完整交互集,作为 `src/snap/anno.ts` + `src/snap/snap.ts` 的实现对照,避免再零碎补。✓=已实现。

## Create(创建)
- ✓ 选工具(rect/ellipse/arrow/line/pen/highlight/mosaic/text)+ 光标随工具变
- ✓ 拖拽橡皮筋画形状,松开提交
- ✓ **画完即选中**(出把手,可立刻移动/改大小/改色)
- ✓ 文字:点一下落字 + 内联输入
- ✓ 笔/荧光/马赛克 拖拽
- ✓ 零尺寸点击不生成退化元素
- ✓ Shift 约束:rect/ellipse 正方/正圆,line/arrow 吸附 45°
- ✓ 新元素置顶 z-order(push 到数组尾)
- nice(未做):Ctrl 从中心画 · 粘性工具开关

## Select(选中)
- ✓ 点选最上层命中元素(出选框+把手)
- ✓ 点空清选
- ✓ 重叠取最上层(hitTest 从顶往下)
- should/nice(未做):Shift 多选 · 框选 marquee · 仅命中渲染像素 · Ctrl+A 全选 · Tab 轮选

## Move(移动)
- ✓ 拖元素本体移动(含**文字**)
- nice(未做):多选整体移 · 对齐辅助线 · Shift 轴向锁定

## Resize(改大小)
- ✓ 框(rect/ellipse/mosaic)8 把手:角=两轴,边=单轴
- ✓ **箭头/直线 = 两端点把手**(只移那一端)
- ✓ 笔/荧光/文字 = 4 角按比例缩放(文字同时缩字号)
- ✓ 最小尺寸钳制
- ✓ 马赛克缩放自动按新区域重新打码(redraw 时实时从屏幕取色)
- should/nice(未做):Shift 锁比例 · Ctrl 从中心缩 · 端点 Shift 吸附角度

## Edit(编辑)
- ✓ **双击文字改内容**(预填原文,空则删)
- ✓ 输入即改,提交回选中态
- ✓ 空内容自动删除
- nice(未做):Ctrl+D 复制 · Ctrl+C/V 复制粘贴

## Style(样式)
- ✓ **选中后改颜色**(点色块即应用到选中元素)
- ✓ **滚轮调粗细/字号**(有选中改选中,否则改默认)
- ✓ 选中即把其颜色载入工具(样式跟随选中)
- ✓ 新元素继承上次样式
- nice(未做):箭头样式/虚线 · 马赛克强度 · 透明度

## Delete(删除)
- ✓ Delete/Backspace 删选中
- nice(未做):右键菜单删 · 一键清空

## Undo/Redo(撤销重做)
- ✓ **快照式**,覆盖 创建/移动/缩放/改样式/删除/改文字
- ✓ 一次手势一条历史(拖动首帧才压栈)
- ✓ Ctrl+Z 撤销 · Ctrl+Y / Ctrl+Shift+Z 重做

## Keyboard(键盘)
- ✓ **方向键微移**选中(Shift=10px 大步)
- ✓ Delete 删 · Esc 先取消选中再退出
- ✓ 工具字母热键(m/r/o/a/l/p/h/k/t)
- ✓ 编辑文字时按键打字不触发画布动作(input 内 stopPropagation)

## Cursor(光标反馈)
- ✓ 悬停把手=对应缩放向光标(nwse/nesw/ns/ew),端点=crosshair
- ✓ 悬停元素本体=移动光标
- ✓ 画图工具=crosshair,文字=text
- nice(未做):悬停未选元素的高亮提示

## Misc
- ✓ 导出:标注合成进截图 → 结构化 MD(含 omni 实体解析)
- should/nice(未做):层级置顶/置底 · 右键上下文菜单

> 决策:不接 BlockSuite 单独画布(用户:"两个东西"割裂)。就地直接画 + 做到成熟工具完整度,是唯一形态。
