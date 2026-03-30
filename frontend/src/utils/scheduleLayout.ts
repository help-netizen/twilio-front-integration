/**
 * Schedule Layout Utilities — collision detection and lane assignment.
 *
 * Used by DayView and WeekView to lay out overlapping items
 * in parallel sub-columns without visual collision.
 */

export interface LayoutItem {
  key: string;       // unique ID like "job-123"
  startMin: number;  // minutes from midnight in company TZ
  endMin: number;    // minutes from midnight in company TZ
}

export interface LayoutResult {
  key: string;
  lane: number;      // 0-based lane index
  totalLanes: number; // total lanes in this collision group
}

/**
 * Two items overlap if their time intervals intersect (exclusive endpoints).
 */
function itemsOverlap(a: LayoutItem, b: LayoutItem): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * Assign lanes to overlapping items using greedy interval scheduling.
 *
 * Algorithm:
 * 1. Sort items by start time, then by duration (longer first for ties)
 * 2. For each item, find the first lane where it doesn't overlap with existing items
 * 3. Group connected overlapping items to determine totalLanes per group
 *
 * Returns a Map<key, LayoutResult> for O(1) lookup.
 */
export function assignLanes(items: LayoutItem[]): Map<string, LayoutResult> {
  const result = new Map<string, LayoutResult>();

  if (items.length === 0) {
    return result;
  }

  // 1. Sort by startMin ascending; ties broken by longer duration first
  const sorted = [...items].sort((a, b) => {
    if (a.startMin !== b.startMin) {
      return a.startMin - b.startMin;
    }
    const durA = a.endMin - a.startMin;
    const durB = b.endMin - b.startMin;
    return durB - durA; // longer duration first
  });

  // 2. Greedy lane assignment
  // Each lane tracks the list of items assigned to it (we only need the last item's endMin)
  const lanes: LayoutItem[][] = [];
  const laneAssignment = new Map<string, number>(); // key -> lane index

  for (const item of sorted) {
    let placed = false;
    for (let i = 0; i < lanes.length; i++) {
      const lastInLane = lanes[i][lanes[i].length - 1];
      // Item fits in this lane if it starts at or after the last item's end
      if (item.startMin >= lastInLane.endMin) {
        lanes[i].push(item);
        laneAssignment.set(item.key, i);
        placed = true;
        break;
      }
    }
    if (!placed) {
      lanes.push([item]);
      laneAssignment.set(item.key, lanes.length - 1);
    }
  }

  // 3. Find connected clusters to determine totalLanes per group.
  // Sweep through sorted items. A cluster is a maximal set of items connected
  // by transitive overlap. A cluster ends when the next item starts at or after
  // the running maximum endMin of the current cluster.
  let clusterStart = 0;
  let clusterMaxEnd = sorted[0].endMin;

  for (let i = 1; i <= sorted.length; i++) {
    // Check if we've reached the end or the current item starts a new cluster
    if (i === sorted.length || sorted[i].startMin >= clusterMaxEnd) {
      // Finalize the cluster from clusterStart to i-1
      const clusterItems = sorted.slice(clusterStart, i);

      // Find the max lane index used in this cluster
      let maxLane = 0;
      for (const item of clusterItems) {
        const lane = laneAssignment.get(item.key)!;
        if (lane > maxLane) {
          maxLane = lane;
        }
      }
      const totalLanes = maxLane + 1;

      // Assign results for all items in this cluster
      for (const item of clusterItems) {
        result.set(item.key, {
          key: item.key,
          lane: laneAssignment.get(item.key)!,
          totalLanes,
        });
      }

      // Start new cluster
      if (i < sorted.length) {
        clusterStart = i;
        clusterMaxEnd = sorted[i].endMin;
      }
    } else {
      // Extend current cluster
      if (sorted[i].endMin > clusterMaxEnd) {
        clusterMaxEnd = sorted[i].endMin;
      }
    }
  }

  return result;
}
