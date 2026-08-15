import type { ElkNode } from "elkjs/lib/elk-api";

export interface MaterialLayoutBox {
  id: string;
  parentId?: string;
  kind: "material" | "text" | "group";
  width: number;
  height: number;
}

export interface MaterialLayoutLink {
  id: string;
  source: string;
  target: string;
}

export interface MaterialLayoutPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
}

let enginePromise: Promise<InstanceType<(typeof import("elkjs/lib/elk.bundled.js"))["default"]>> | null = null;

async function layoutEngine() {
  if (!enginePromise) {
    enginePromise = import("elkjs/lib/elk.bundled.js").then(({ default: ELK }) => new ELK());
  }
  return enginePromise;
}

/**
 * 用 ELK 的分层布局处理真实卡片尺寸、连通分量、交叉最小化与编组层级。
 * 返回的子卡坐标相对父组，正好对应 React Flow subflow 的坐标约定。
 */
export async function layoutMaterialCanvas(
  boxes: MaterialLayoutBox[],
  links: MaterialLayoutLink[],
): Promise<Map<string, MaterialLayoutPlacement>> {
  const groups = new Set(boxes.filter((box) => box.kind === "group").map((box) => box.id));
  const childrenByParent = new Map<string, MaterialLayoutBox[]>();
  const roots: MaterialLayoutBox[] = [];

  for (const box of boxes) {
    if (box.parentId && groups.has(box.parentId)) {
      const siblings = childrenByParent.get(box.parentId) || [];
      siblings.push(box);
      childrenByParent.set(box.parentId, siblings);
    } else {
      roots.push(box);
    }
  }

  const asElkNode = (box: MaterialLayoutBox): ElkNode => {
    const children = childrenByParent.get(box.id) || [];
    if (!children.length) {
      return { id: box.id, width: box.width, height: box.height };
    }
    return {
      id: box.id,
      width: Math.max(260, box.width),
      height: Math.max(180, box.height),
      children: children.map(asElkNode),
      layoutOptions: {
        "elk.padding": "[top=58,left=28,bottom=28,right=28]",
        "elk.spacing.nodeNode": "38",
        "elk.layered.spacing.nodeNodeBetweenLayers": "68",
      },
    };
  };

  const knownIds = new Set(boxes.map((box) => box.id));
  const graph: ElkNode = {
    id: "material-canvas-root",
    children: roots.map(asElkNode),
    edges: links
      .filter((link) => knownIds.has(link.source) && knownIds.has(link.target) && link.source !== link.target)
      .map((link) => ({ id: link.id, sources: [link.source], targets: [link.target] })),
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=48,left=48,bottom=48,right=48]",
      "elk.spacing.nodeNode": "52",
      "elk.spacing.edgeNode": "28",
      "elk.spacing.edgeEdge": "18",
      "elk.spacing.componentComponent": "64",
      "elk.layered.spacing.nodeNodeBetweenLayers": "88",
      "elk.layered.spacing.edgeNodeBetweenLayers": "34",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
      "elk.layered.crossingMinimization.greedySwitchHierarchical.type": "TWO_SIDED",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.compaction.connectedComponents": "true",
      "elk.separateConnectedComponents": "true",
    },
  };

  const laidOut = await (await layoutEngine()).layout(graph);
  const placements = new Map<string, MaterialLayoutPlacement>();
  const collect = (items: ElkNode[] | undefined) => {
    for (const item of items || []) {
      const original = boxes.find((box) => box.id === item.id);
      if (original) {
        placements.set(item.id, {
          x: item.x || 0,
          y: item.y || 0,
          width: item.width || original.width,
          height: item.height || original.height,
        });
      }
      collect(item.children);
    }
  };
  collect(laidOut.children);
  return placements;
}
