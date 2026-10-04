// 测绘基准 / 厂家模型基准统一换算内核
// 所有几何量先折算到“统一数学框架(canonical)”再参与净空计算：
//   canonical = scale * Rz(rotZ) * p + translation
// 实测点以采集时的测绘基准版本入库；厂家模型以厂家基准版本入库。
// 换版时点坐标经 canonical 过渡换算到新基准，原值归档为历史数据。

export type Vec3 = [number, number, number];

export interface DatumParams {
  tx: number; // x 平移 / m
  ty: number; // y 平移 / m
  tz: number; // z 平移 / m
  rotZ: number; // 绕 Z 轴旋转 / rad
  scale: number; // 尺度因子
}

export type DatumKind = 'site' | 'manufacturer';
export type DatumStatus = 'active' | 'superseded';

export interface DatumVersion {
  id: string;
  kind: DatumKind;
  label: string;
  params: DatumParams;
  publishedAt: string;
  status: DatumStatus;
  note?: string;
}

export interface Box {
  center: Vec3;
  half: Vec3;
}

export const identityParams = (): DatumParams => ({ tx: 0, ty: 0, tz: 0, rotZ: 0, scale: 1 });

// ---- 向量 / 参数运算 ----

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** 从某基准框架折算到统一数学框架 */
export function toCanonical(p: Vec3, d: DatumParams): Vec3 {
  const c = Math.cos(d.rotZ);
  const s = Math.sin(d.rotZ);
  const x = d.scale * (c * p[0] - s * p[1]) + d.tx;
  const y = d.scale * (s * p[0] + c * p[1]) + d.ty;
  const z = d.scale * p[2] + d.tz;
  return [x, y, z];
}

/** 从统一数学框架折算回某基准框架（toCanonical 的逆变换） */
export function fromCanonical(p: Vec3, d: DatumParams): Vec3 {
  const c = Math.cos(-d.rotZ);
  const s = Math.sin(-d.rotZ);
  const q: Vec3 = [(p[0] - d.tx) / d.scale, (p[1] - d.ty) / d.scale, (p[2] - d.tz) / d.scale];
  return [c * q[0] - s * q[1], s * q[0] + c * q[1], q[2]];
}

/** 点坐标在两套基准版本间迁移（经统一数学框架过渡，原值由调用方归档） */
export function migratePointCoords(coords: Vec3, from: DatumParams, to: DatumParams): Vec3 {
  return fromCanonical(toCanonical(coords, from), to);
}

/**
 * 轴对齐包围盒经基准变换：中心严格变换；
 * 旋转后取各轴最大投影作为半长（安全侧偏保守的外包 AABB）。
 */
export function transformBox(box: Box, d: DatumParams): Box {
  const c = Math.abs(Math.cos(d.rotZ));
  const s = Math.abs(Math.sin(d.rotZ));
  const k = d.scale;
  return {
    center: toCanonical(box.center, d),
    half: [
      k * (c * box.half[0] + s * box.half[1]),
      k * (s * box.half[0] + c * box.half[1]),
      k * box.half[2]
    ]
  };
}

/** 两个 AABB 的最小间距：各轴分离距离平方和开根；相交返回 0 */
export function boxGap(a: Box, b: Box): number {
  let sum = 0;
  for (let i = 0; i < 3; i += 1) {
    const gap = Math.abs(a.center[i] - b.center[i]) - a.half[i] - b.half[i];
    if (gap > 0) sum += gap * gap;
  }
  return Math.sqrt(sum);
}

/** 构件包围盒相对一组障碍物的最小净空，返回净空值与最近障碍 */
export function minClearance(
  component: Box,
  obstacles: { id: string; box: Box }[]
): { value: number; obstacleId: string | null } {
  let best = Infinity;
  let obstacleId: string | null = null;
  for (const obstacle of obstacles) {
    const gap = boxGap(component, obstacle.box);
    if (gap < best) {
      best = gap;
      obstacleId = obstacle.id;
    }
  }
  return { value: obstacles.length ? Number(best.toFixed(3)) : Infinity, obstacleId };
}

/** 一组实测点（已在统一框架下）的外包 AABB；少于 2 个点返回 null */
export function envelopeOf(points: Vec3[]): Box | null {
  if (points.length < 2) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    half: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]
  };
}

/** 包围盒 8 角点，用于按厂家模型回填“实测点” */
export function boxCorners(box: Box): Vec3[] {
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push([
          box.center[0] + sx * box.half[0],
          box.center[1] + sy * box.half[1],
          box.center[2] + sz * box.half[2]
        ]);
      }
    }
  }
  return out;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function formatVec(v: Vec3): string {
  return `(${v.map((n) => round3(n).toFixed(2)).join(', ')})`;
}

export function formatParams(d: DatumParams): string {
  return `平移(${round3(d.tx)}, ${round3(d.ty)}, ${round3(d.tz)})m · 旋转 ${round3(d.rotZ)}rad · 尺度 ${round3(d.scale)}`;
}
