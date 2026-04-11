---
doc: "Auto Layout for Flow Editor"
version: "1.0"
status: "implementation_spec"
owner: "Frontend / Workflow Builder"
stack:
  frontend: "React 19 + TypeScript + Vite"
  canvas: "React Flow"
  layout_engine: "elkjs"
goal:
  primary: "Render a readable top-to-bottom workflow tree with no node overlap"
  secondary:
    - "Keep root nodes at the top"
    - "Keep all final nodes on one bottom row"
    - "Reduce crossings"
    - "Keep layout stable between recalculations"
non_goals:
  - "Hand-written coordinate placement"
  - "Using dagre for final layout"
  - "Allowing overlap as an acceptable result"
algorithm:
  name: "ELK Layered"
  id: "org.eclipse.elk.layered"
  direction: "DOWN"
required_rules:
  - "All root nodes must use FIRST_SEPARATE layer constraint"
  - "All final nodes must use LAST_SEPARATE layer constraint"
  - "All nodes must provide real width and height to ELK"
  - "All rendered nodes must use sourcePosition=bottom and targetPosition=top"
  - "Disconnected components must be laid out separately"
  - "If ports/handles are used, port order must be fixed"
layout_options:
  elk.algorithm: "layered"
  elk.direction: "DOWN"
  elk.edgeRouting: "ORTHOGONAL"
  elk.layered.layering.strategy: "NETWORK_SIMPLEX"
  elk.layered.crossingMinimization.strategy: "LAYER_SWEEP"
  elk.layered.crossingMinimization.greedySwitch.type: "TWO_SIDED"
  elk.layered.nodePlacement.strategy: "BRANDES_KOEPF"
  elk.layered.nodePlacement.bk.edgeStraightening: "IMPROVE_STRAIGHTNESS"
  elk.layered.nodePlacement.favorStraightEdges: "true"
  elk.layered.considerModelOrder.strategy: "PREFER_NODES"
  elk.spacing.nodeNode: "48"
  elk.layered.spacing.nodeNodeBetweenLayers: "120"
  elk.layered.spacing.edgeNodeBetweenLayers: "32"
  elk.separateConnectedComponents: "true"
recommended_node_defaults:
  width: 220
  height: 72
recalc_triggers:
  - "node added"
  - "node removed"
  - "edge added"
  - "edge removed"
  - "node size changed"
  - "explicit user action: Auto Layout"
acceptance:
  - "No node rectangles overlap after layout"
  - "All final states are placed on one bottom layer"
  - "All root states are placed on the first layer"
  - "Top-to-bottom reading order is visually obvious"
  - "Repeated layout on unchanged graph is stable"
  - "Layout works with multiple disconnected trees"
---

# 1) Что должен сделать агент

Реализовать auto layout для React Flow через **ELK Layered**, а не через dagre. Для top-to-bottom направления нужно использовать `org.eclipse.elk.layered` c `org.eclipse.elk.direction = DOWN`. ELK Layered — это layered-алгоритм с отдельными фазами layering, crossing minimization и node placement; для него доступны стратегии `NETWORK_SIMPLEX`, `LAYER_SWEEP`, `BRANDES_KOEPF` и ограничения слоёв для узлов.

# 2) Обязательные правила layout

## 2.1 Root-узлы
Все стартовые / initial / root-узлы должны получать node option:

```ts
'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE'
```

## 2.2 Final-узлы
Все финальные состояния должны получать node option:

```ts
'elk.layered.layering.layerConstraint': 'LAST_SEPARATE'
```

Это правило обязательно: все final-узлы должны быть в одном нижнем слое, отдельно от обычных состояний.

## 2.3 Реальные размеры узлов
Перед вызовом ELK каждому node нужно передать реальные `width` и `height`.

## 2.4 Разделение компонентов
Если на полотне несколько несвязанных деревьев, их нужно раскладывать раздельно через:

```ts
'elk.separateConnectedComponents': 'true'
```

## 2.5 Порты / handles
Если используются несколько handles на одном узле, агент обязан:
- выдавать каждому handle уникальный id,
- передавать ports в ELK,
- задавать `elk.portConstraints = FIXED_ORDER`,
- задавать корректный `side` и, при необходимости, индекс порта.

# 3) Базовый конфиг ELK

Агент должен использовать такой baseline-конфиг как дефолт:

```ts
const ELK_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',

  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',

  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',

  'elk.separateConnectedComponents': 'true',
};
```

# 4) Алгоритм выполнения

## Шаг 1. Собрать входные данные
На входе есть:
- массив `nodes` из React Flow,
- массив `edges` из React Flow.

Каждый node должен содержать:
- `id`
- `data.isRoot?: boolean`
- `data.isFinal?: boolean`
- `data.order?: number`
- `measured.width / measured.height` или fallback width/height.

## Шаг 2. Отсортировать nodes стабильно
Перед преобразованием в ELK-граф отсортировать узлы по:
1. `data.order`, если задан,
2. `id`, если `order` отсутствует.

Это нужно для более стабильного результата между повторными раскладками.

## Шаг 3. Преобразовать каждый React Flow node в ELK child
Для каждого узла:
- взять реальный `width/height`,
- создать `layoutOptions`,
- если `isRoot`, добавить `FIRST_SEPARATE`,
- если `isFinal`, добавить `LAST_SEPARATE`.

Пример:

```ts
function toElkNode(node) {
  const width = node.measured?.width ?? node.width ?? 220;
  const height = node.measured?.height ?? node.height ?? 72;

  const layoutOptions: Record<string, string> = {};

  if (node.data?.isRoot) {
    layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST_SEPARATE';
  }

  if (node.data?.isFinal) {
    layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST_SEPARATE';
  }

  return {
    id: node.id,
    width,
    height,
    layoutOptions,
  };
}
```

## Шаг 4. Если есть handles, преобразовать их в ports
Если узел использует несколько source/target handles, агент должен строить ELK ports. Для узла нужно добавить:

```ts
layoutOptions: {
  'elk.portConstraints': 'FIXED_ORDER'
}
```

А для каждого порта:
- `id`
- `width: 1`
- `height: 1`
- `layoutOptions['elk.port.side']`
- `layoutOptions['elk.port.index']`

## Шаг 5. Преобразовать edges
Для обычного узла без ports:
- `sources: [edge.source]`
- `targets: [edge.target]`

Для узла с ports:
- использовать `sourceHandle` / `targetHandle`
- мапить в ids вида `${nodeId}__${handleId}`

## Шаг 6. Собрать корневой ELK graph
Нужно собрать объект:

```ts
const graph = {
  id: 'root',
  layoutOptions: ELK_OPTIONS,
  children: orderedNodes.map(toElkNode),
  edges: edges.map(toElkEdge),
};
```

## Шаг 7. Вызвать layout
Выполнить:

```ts
const layouted = await elk.layout(graph);
```

Затем для каждого node перенести координаты:

```ts
position: { x: laidOut.x, y: laidOut.y }
```

И выставить:
- `sourcePosition = Position.Bottom`
- `targetPosition = Position.Top`

## Шаг 8. Настроить edges для читаемости
После layout каждому edge по умолчанию нужно ставить:
- `type: 'smoothstep'`
- `markerEnd: { type: MarkerType.ArrowClosed }`

## Шаг 9. После обновления вызвать `fitView`
После `setNodes` и `setEdges` агент должен вызывать:

```ts
fitView({ padding: 0.2 })
```

# 5) Когда пересчитывать layout

Пересчитывать auto layout только при:
- добавлении node,
- удалении node,
- добавлении edge,
- удалении edge,
- изменении размера node,
- явном действии пользователя `Auto Layout`.

Не нужно делать полный layout:
- на каждый drag node,
- на каждый символ в label/input.

# 6) Полный util, который агент должен реализовать

```ts
import ELK from 'elkjs/lib/elk.bundled.js';
import { Edge, Node, Position, MarkerType } from '@xyflow/react';

type WorkflowPortSide = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST';

type WorkflowPort = {
  id: string;
  side: WorkflowPortSide;
  index?: number;
};

type WorkflowNodeData = {
  isRoot?: boolean;
  isFinal?: boolean;
  order?: number;
  ports?: WorkflowPort[];
};

type WorkflowNode = Node<WorkflowNodeData>;
type WorkflowEdge = Edge;

const elk = new ELK();

const DEFAULT_NODE_WIDTH = 220;
const DEFAULT_NODE_HEIGHT = 72;

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.edgeRouting': 'ORTHOGONAL',

  'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.edgeStraightening': 'IMPROVE_STRAIGHTNESS',
  'elk.layered.nodePlacement.favorStraightEdges': 'true',
  'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',

  'elk.spacing.nodeNode': '48',
  'elk.layered.spacing.nodeNodeBetweenLayers': '120',
  'elk.layered.spacing.edgeNodeBetweenLayers': '32',

  'elk.separateConnectedComponents': 'true',
};

function getNodeSize(node: WorkflowNode) {
  return {
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
  };
}

function sortNodesForStableModelOrder(nodes: WorkflowNode[]) {
  return [...nodes].sort((a, b) => {
    const ao = typeof a.data?.order === 'number' ? a.data.order : Number.MAX_SAFE_INTEGER;
    const bo = typeof b.data?.order === 'number' ? b.data.order : Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return String(a.id).localeCompare(String(b.id));
  });
}

function getPortRef(nodeId: string, handleId?: string | null) {
  if (!handleId) return nodeId;
  return `${nodeId}__${handleId}`;
}

function toElkNode(node: WorkflowNode) {
  const { width, height } = getNodeSize(node);
  const layoutOptions: Record<string, string> = {};

  if (node.data?.isRoot) {
    layoutOptions['elk.layered.layering.layerConstraint'] = 'FIRST_SEPARATE';
  }

  if (node.data?.isFinal) {
    layoutOptions['elk.layered.layering.layerConstraint'] = 'LAST_SEPARATE';
  }

  const elkNode: any = {
    id: node.id,
    width,
    height,
    layoutOptions,
  };

  if (node.data?.ports?.length) {
    elkNode.layoutOptions = {
      ...elkNode.layoutOptions,
      'elk.portConstraints': 'FIXED_ORDER',
    };

    elkNode.ports = node.data.ports.map((port, index) => ({
      id: getPortRef(node.id, port.id),
      width: 1,
      height: 1,
      layoutOptions: {
        'elk.port.side': port.side,
        'elk.port.index': String(port.index ?? index),
      },
    }));
  }

  return elkNode;
}

function toElkEdge(edge: WorkflowEdge) {
  return {
    id: edge.id,
    sources: [getPortRef(edge.source, edge.sourceHandle)],
    targets: [getPortRef(edge.target, edge.targetHandle)],
  };
}

export async function layoutWithElkLayered(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
) {
  const orderedNodes = sortNodesForStableModelOrder(nodes);

  const graph = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: orderedNodes.map(toElkNode),
    edges: edges.map(toElkEdge),
  };

  const layouted = await elk.layout(graph);

  const nextNodes: WorkflowNode[] = orderedNodes.map((node) => {
    const laidOut = layouted.children?.find((n: any) => n.id === node.id);

    return {
      ...node,
      position: {
        x: laidOut?.x ?? node.position.x,
        y: laidOut?.y ?? node.position.y,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  const nextEdges: WorkflowEdge[] = edges.map((edge) => ({
    ...edge,
    type: edge.type ?? 'smoothstep',
    markerEnd: edge.markerEnd ?? { type: MarkerType.ArrowClosed },
  }));

  return {
    nodes: nextNodes,
    edges: nextEdges,
  };
}
```

# 7) Требования к результату

## Обязательно
- узлы не накладываются друг на друга;
- все root-узлы сверху;
- все final-узлы на одном нижнем уровне;
- вертикальное чтение сверху вниз очевидно;
- disconnected components раскладываются отдельно;
- layout стабилен между повторными вызовами без изменений графа.

## Желательно
- при multi-handle nodes crossings уменьшаются за счёт FIXED_ORDER ports;
- длинные связи визуально остаются читаемыми;
- после layout viewport автоматически показывает всю схему.

# 8) Что нельзя делать

- нельзя использовать guessed размеры, если уже доступны measured размеры;
- нельзя смешивать root и final в обычных слоях;
- нельзя игнорировать `layerConstraint` для initial/final узлов;
- нельзя запускать full layout на каждый drag;
- нельзя передавать несколько handles без ports, если нужна контролируемая читаемость.
