import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type Comment = {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
};

// ===== 测绘基准与换算（厂家模型基准 ↔ 现场测绘基准）=====
export type DatumKind = 'survey' | 'manufacturer';
export type TransformParams = { dx: number; dy: number; dz: number; rx: number; ry: number; rz: number; k: number };
export type DatumVersion = {
  id: string;
  code: string;
  name: string;
  kind: DatumKind;
  version: string;
  params: TransformParams;
  status: 'active' | 'superseded';
  registeredAt: string;
  note: string;
};
export type PointBasis = 'measured' | 'migrated' | 'backfilled';
export type MeasuredPoint = {
  id: string;
  componentId: string;
  scannerId: string;
  raw: [number, number, number];
  datumVersionId: string;
  submittedAt: string;
  migrated: boolean;
  backfilled: boolean;
  occupied: boolean;
  pendingReview: boolean;
};
export type ConclusionStatus = 'draft' | 'published' | 'invalid' | 'review';
export type Conclusion = {
  id: string;
  componentId: string;
  stepId: string;
  datumVersionId: string;
  basis: PointBasis;
  status: ConclusionStatus;
  minClearance: number;
  threshold: number;
  overLimit: boolean;
  conflictId: string | null;
  occupiedBy: string | null;
  reviewScanners: string[];
  retestId: string | null;
  publishedAt: string | null;
  calculatedAt: string;
  reviewReason: string;
};
export type LiftComponent = {
  id: string;
  code: string;
  name: string;
  stepId: string;
  modelPos: [number, number, number];
  threshold: number;
};
export type DatumConflict = {
  id: string;
  conclusionId: string;
  componentId: string;
  stepId: string;
  message: string;
  severity: 'high' | 'medium';
  keptMeasurement: boolean;
  retestId: string | null;
  createdAt: string;
};
export type RetestRecord = {
  id: string;
  componentId: string;
  conclusionId: string;
  reason: string;
  scannerIds: string[];
  keptMeasurement: boolean;
  createdAt: string;
};

// 障碍物（东侧临时配电箱）：中心与半尺寸，净空为构件到障碍物表面的距离
const OBSTACLE_CENTER: [number, number, number] = [10, 2.5, 8];
const OBSTACLE_HALF: [number, number, number] = [2.5, 2.5, 2];

// 七参数换算（布尔莎模型，小角度近似）：p_survey = T + (1+k) · Rz(rz)·Ry(ry)·Rx(rx) · p_model
export function applyTransform(p: [number, number, number], t: TransformParams): [number, number, number] {
  const [x, y, z] = p;
  const cx = Math.cos(t.rx), sx = Math.sin(t.rx);
  const cy = Math.cos(t.ry), sy = Math.sin(t.ry);
  const cz = Math.cos(t.rz), sz = Math.sin(t.rz);
  const ry1 = cx * y - sx * z;
  const rz1 = sx * y + cx * z;
  const rx2 = cy * x + sy * rz1;
  const rz2 = -sy * x + cy * rz1;
  const rx3 = cz * rx2 - sz * ry1;
  const ry3 = sz * rx2 + cz * ry1;
  const scale = 1 + t.k / 1e6;
  return [
    +(rx3 * scale + t.dx).toFixed(3),
    +(ry3 * scale + t.dy).toFixed(3),
    +(rz2 * scale + t.dz).toFixed(3)
  ];
}

// 七参数反算：旧基准实测点迁移时先还原到模型基准，再用新参数换算
export function applyInverse(p: [number, number, number], t: TransformParams): [number, number, number] {
  const scale = 1 + t.k / 1e6;
  const x0 = (p[0] - t.dx) / scale;
  const y0 = (p[1] - t.dy) / scale;
  const z0 = (p[2] - t.dz) / scale;
  const cx = Math.cos(t.rx), sx = Math.sin(t.rx);
  const cy = Math.cos(t.ry), sy = Math.sin(t.ry);
  const cz = Math.cos(t.rz), sz = Math.sin(t.rz);
  const x1 = cz * x0 + sz * y0;
  const y1 = -sz * x0 + cz * y0;
  const z1 = z0;
  const x2 = cy * x1 - sy * z1;
  const y2 = y1;
  const z2 = sy * x1 + cy * z1;
  const y3 = cx * y2 + sx * z2;
  const z3 = -sx * y2 + cx * z2;
  return [+x2.toFixed(3), +y3.toFixed(3), +z3.toFixed(3)];
}

export function clearanceToObstacle(p: [number, number, number]): number {
  const dx = Math.max(OBSTACLE_CENTER[0] - OBSTACLE_HALF[0] - p[0], 0, p[0] - (OBSTACLE_CENTER[0] + OBSTACLE_HALF[0]));
  const dy = Math.max(OBSTACLE_CENTER[1] - OBSTACLE_HALF[1] - p[1], 0, p[1] - (OBSTACLE_CENTER[1] + OBSTACLE_HALF[1]));
  const dz = Math.max(OBSTACLE_CENTER[2] - OBSTACLE_HALF[2] - p[2], 0, p[2] - (OBSTACLE_CENTER[2] + OBSTACLE_HALF[2]));
  return +Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(2);
}

export function nowStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type LiftStep = {
  id: string;
  title: string;
  time: string;
  loadRate: number;
  clearance: number;
  wind: number;
  radius: number;
  boom: number;
  status: StepStatus;
  note: string;
};

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '吊车支腿就位与地耐力复核', time: '07:30', loadRate: 0, clearance: 4.2, wind: 3.4, radius: 18, boom: 42, status: 'passed', note: '支腿钢板 2.4m × 2.4m，已完成压实度复检。' },
  { id: 'S-02', title: '空钩回转与障碍物净空检查', time: '08:10', loadRate: 28, clearance: 1.2, wind: 4.1, radius: 22, boom: 46, status: 'blocked', note: '东侧临时配电箱侵入回转半径 0.6m。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', loadRate: 76, clearance: 2.8, wind: 5.2, radius: 20, boom: 44, status: 'pending', note: '需安全员确认吊点受力均匀。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', loadRate: 83, clearance: 1.8, wind: 6.8, radius: 24, boom: 48, status: 'pending', note: '风速超过 8m/s 立即停止。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', loadRate: 92, clearance: 1.3, wind: 7.2, radius: 27, boom: 52, status: 'blocked', note: '辅吊荷载率超过方案控制值。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', loadRate: 68, clearance: 2.1, wind: 5.6, radius: 21, boom: 45, status: 'pending', note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与配电箱净空不足，请调整吊车站位或迁移配电箱。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

// ===== 测绘基准版本：现场测绘基准为换算目标，厂家模型基准按七参数换算 =====
const initialDatums: DatumVersion[] = [
  {
    id: 'DV-SURVEY-2026', code: 'CJ-2026', name: '2026 测绘基准', kind: 'survey', version: '2026',
    params: { dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, k: 0 },
    status: 'active', registeredAt: '2026-01-08', note: '现场扫描点统一入库基准，作为换算目标基准。'
  },
  {
    id: 'DV-MFG-V1', code: 'CJ-MFG', name: '厂家模型基准', kind: 'manufacturer', version: 'v1.0',
    params: { dx: 0.82, dy: -0.35, dz: 0.44, rx: 0.0021, ry: -0.0013, rz: 0.0032, k: 6.5 },
    status: 'active', registeredAt: '2026-02-10', note: '厂家模型出厂自带基准，构件位置与净空结论按七参数换算到测绘基准。'
  }
];

const initialComponents: LiftComponent[] = [
  { id: 'C-01', code: 'HJ-1', name: '主桁架分段 HJ-1', stepId: 'S-01', modelPos: [0, 6.5, 2], threshold: 1.5 },
  { id: 'C-02', code: 'HJ-2', name: '主桁架分段 HJ-2', stepId: 'S-02', modelPos: [7.6, 6.0, 7.2], threshold: 1.5 },
  { id: 'C-03', code: 'LG-1', name: '连廊钢梁 LG-1', stepId: 'S-04', modelPos: [-4, 5.2, 6], threshold: 1.5 },
  { id: 'C-04', code: 'FJ-1', name: '辅吊构件 FJ-1', stepId: 'S-05', modelPos: [11.6, 3.4, 8.6], threshold: 1.5 }
];

// 实测点：现场扫描按厂家模型基准入库，先到的扫描仪占用本次结论
const initialPoints: MeasuredPoint[] = [
  { id: 'P-C01-A', componentId: 'C-01', scannerId: 'SCAN-A', raw: [0.04, 6.47, 2.02], datumVersionId: 'DV-MFG-V1', submittedAt: '2026-09-18', migrated: false, backfilled: false, occupied: true, pendingReview: false },
  { id: 'P-C02-A', componentId: 'C-02', scannerId: 'SCAN-A', raw: [7.64, 5.97, 7.22], datumVersionId: 'DV-MFG-V1', submittedAt: '2026-09-18', migrated: false, backfilled: false, occupied: true, pendingReview: false },
  { id: 'P-C04-A', componentId: 'C-04', scannerId: 'SCAN-A', raw: [11.64, 3.37, 8.62], datumVersionId: 'DV-MFG-V1', submittedAt: '2026-09-18', migrated: false, backfilled: false, occupied: true, pendingReview: false }
];

function buildConclusion(
  comp: LiftComponent,
  datum: DatumVersion,
  point: MeasuredPoint | null,
  status: ConclusionStatus,
  extra: Partial<Conclusion> = {}
): Conclusion {
  const raw = point ? point.raw : comp.modelPos;
  const survey = applyTransform(raw, datum.params);
  const minClearance = clearanceToObstacle(survey);
  return {
    id: `CL-${comp.id.slice(2)}`,
    componentId: comp.id,
    stepId: comp.stepId,
    datumVersionId: datum.id,
    basis: point ? (point.backfilled ? 'backfilled' : 'measured') : 'backfilled',
    status,
    minClearance,
    threshold: comp.threshold,
    overLimit: minClearance < comp.threshold,
    conflictId: null,
    occupiedBy: point && !point.backfilled ? point.scannerId : null,
    reviewScanners: [],
    retestId: null,
    publishedAt: status === 'published' ? '2026-09-20' : null,
    calculatedAt: '2026-09-20',
    reviewReason: '',
    ...extra
  };
}

const initialConclusions: Conclusion[] = [
  buildConclusion(initialComponents[0], initialDatums[1], initialPoints[0], 'published'),
  buildConclusion(initialComponents[1], initialDatums[1], initialPoints[1], 'draft'),
  buildConclusion(initialComponents[2], initialDatums[1], null, 'draft'),
  buildConclusion(initialComponents[3], initialDatums[1], initialPoints[2], 'published', {
    conflictId: 'CF-01',
    retestId: 'RT-01'
  })
];

const initialConflicts: DatumConflict[] = [
  {
    id: 'CF-01', conclusionId: 'CL-04', componentId: 'C-04', stepId: 'S-05',
    message: '辅吊构件 FJ-1 最小净空 0.00m 小于 1.5m 阈值，与东侧障碍物干涉',
    severity: 'high', keptMeasurement: true, retestId: 'RT-01', createdAt: '2026-09-20'
  }
];

const initialRetests: RetestRecord[] = [
  {
    id: 'RT-01', componentId: 'C-04', conclusionId: 'CL-04',
    reason: '净空超限，保留现场测量数据，安排重测复核',
    scannerIds: ['SCAN-A'], keptMeasurement: true, createdAt: '2026-09-20'
  }
];

const cacheKey = 'yy58-lift-plan-draft';
const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(cacheKey) : null;
const saved = stored ? JSON.parse(stored) : null;

export const useLiftStore = defineStore('lift-plan', {
  state: () => ({
    steps: (saved?.steps as LiftStep[]) ?? initialSteps,
    comments: (saved?.comments as Comment[]) ?? initialComments,
    selectedStepId: (saved?.selectedStepId as string) ?? 'S-02',
    revision: (saved?.revision as number) ?? 4,
    locked: (saved?.locked as boolean) ?? false,
    viewBookmarks: (saved?.viewBookmarks as string[]) ?? ['主吊全景', '东侧障碍', '安装轴线'],
    activeBookmark: (saved?.activeBookmark as string) ?? '主吊全景',
    datumVersions: (saved?.datumVersions as DatumVersion[]) ?? initialDatums,
    components: (saved?.components as LiftComponent[]) ?? initialComponents,
    points: (saved?.points as MeasuredPoint[]) ?? initialPoints,
    conclusions: (saved?.conclusions as Conclusion[]) ?? initialConclusions,
    datumConflicts: (saved?.datumConflicts as DatumConflict[]) ?? initialConflicts,
    retests: (saved?.retests as RetestRecord[]) ?? initialRetests
  }),
  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    conflicts(state) {
      return state.steps.flatMap((step) => {
        const issues: string[] = [];
        if (step.loadRate > 90) issues.push(`荷载率 ${step.loadRate}% 超过 90% 阈值`);
        if (step.clearance < 1.5) issues.push(`净空 ${step.clearance}m 小于 1.5m`);
        if (step.wind > 8) issues.push(`风速 ${step.wind}m/s 超过暂停值`);
        if (step.radius > step.boom * 0.62) issues.push('工作半径接近额定幅度');
        return issues.map((message, index) => ({ id: `${step.id}-${index}`, stepId: step.id, title: step.title, message, severity: step.status === 'blocked' ? 'high' : 'medium' }));
      });
    },
    openComments(state) {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    readiness(state): number {
      const passedChecks = state.steps.filter((step) => step.status === 'passed').length;
      const commentPenalty = state.comments.filter((item) => item.status === 'open').length * 12;
      return Math.max(0, Math.round((passedChecks / state.steps.length) * 100 - commentPenalty));
    },
    activeManufacturerDatum(state): DatumVersion | undefined {
      return state.datumVersions.find((d) => d.kind === 'manufacturer' && d.status === 'active');
    },
    surveyDatum(state): DatumVersion | undefined {
      return state.datumVersions.find((d) => d.kind === 'survey' && d.status === 'active');
    },
    datumById(state) {
      return (id: string | null | undefined): DatumVersion | undefined => state.datumVersions.find((d) => d.id === id);
    },
    pointsByComponent(state) {
      return (componentId: string): MeasuredPoint[] => state.points.filter((p) => p.componentId === componentId);
    },
    activeConclusionByComponent(state) {
      return (componentId: string): Conclusion | undefined =>
        state.conclusions.find((c) => c.componentId === componentId && c.status !== 'invalid');
    },
    activeConclusionForStep(state) {
      return (stepId: string): Conclusion | undefined =>
        state.conclusions.find((c) => c.stepId === stepId && c.status !== 'invalid');
    },
    surveyPosition(state) {
      return (componentId: string): [number, number, number] | null => {
        const datum = state.datumVersions.find((d) => d.kind === 'manufacturer' && d.status === 'active');
        const comp = state.components.find((c) => c.id === componentId);
        if (!datum || !comp) return null;
        const point = state.points.find((p) => p.componentId === componentId && p.occupied && p.datumVersionId === datum.id);
        return applyTransform(point ? point.raw : comp.modelPos, datum.params);
      };
    },
    clearanceOf(state) {
      return (componentId: string): number | null => {
        const pos = this.surveyPosition(componentId);
        return pos ? clearanceToObstacle(pos) : null;
      };
    },
    pendingReviewCount(state) {
      return (componentId: string): number =>
        state.points.filter((p) => p.componentId === componentId && p.pendingReview).length;
    }
  },
  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },
    updateStep(patch: Partial<LiftStep>) {
      const index = this.steps.findIndex((step) => step.id === this.selectedStepId);
      if (index >= 0) this.steps[index] = { ...this.steps[index], ...patch };
      this.persist();
    },
    setStatus(status: StepStatus) {
      this.updateStep({ status });
    },
    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      this.comments.unshift({ id: `C-${Date.now()}`, author, role, content, status: 'open', stepId: this.selectedStepId });
      this.persist();
    },
    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.persist();
    },
    lockPlan() {
      if (this.conflicts.length === 0 && this.openComments.length === 0) {
        this.locked = true;
        this.revision += 1;
        graphqlClient.writeQuery({
          query: LIFT_PLAN_QUERY,
          variables: { id: 'LP-2026-0918' },
          data: { liftPlan: { __typename: 'LiftPlan', id: 'LP-2026-0918', name: '东塔转换桁架吊装', revision: this.revision, status: 'LOCKED', steps: this.steps } }
        });
      }
      this.persist();
    },
    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },
    // 厂家换版：登记新基准版本与换算参数；未发布结论立即失效并按新参数重算，已发布保留原依据但标待复核
    registerManufacturerVersion() {
      const current = this.activeManufacturerDatum;
      if (!current) return;
      const match = /v(\d+)\.\d+/.exec(current.version);
      const n = match ? Number(match[1]) + 1 : 2;
      const stamp = nowStamp();
      const newDatum: DatumVersion = {
        id: `DV-MFG-V${n}`,
        code: current.code,
        name: '厂家模型基准',
        kind: 'manufacturer',
        version: `v${n}.0`,
        params: {
          dx: +(current.params.dx + 0.12).toFixed(3),
          dy: +(current.params.dy - 0.08).toFixed(3),
          dz: +(current.params.dz + 0.06).toFixed(3),
          rx: +(current.params.rx + 0.0006).toFixed(4),
          ry: +(current.params.ry - 0.0004).toFixed(4),
          rz: +(current.params.rz + 0.0005).toFixed(4),
          k: +(current.params.k + 1.2).toFixed(1)
        },
        status: 'active',
        registeredAt: stamp,
        note: `厂家模型换版，七参数换算更新为 ${current.version} → v${n}.0。`
      };
      this.datumVersions.forEach((d) => {
        if (d.kind === 'manufacturer' && d.status === 'active') d.status = 'superseded';
      });
      this.datumVersions.push(newDatum);

      // 旧实测点作为历史数据迁移：旧基准反算还原后，再按新参数换算入库
      this.points.forEach((p) => {
        if (p.backfilled) {
          p.datumVersionId = newDatum.id;
          return;
        }
        const old = this.datumVersions.find((d) => d.id === p.datumVersionId);
        if (old) {
          p.raw = applyTransform(applyInverse(p.raw, old.params), newDatum.params);
          p.datumVersionId = newDatum.id;
          p.migrated = true;
        }
      });
      // 缺实测的构件按厂家模型回填
      this.components.forEach((comp) => {
        const hasMeasurement = this.points.some((p) => p.componentId === comp.id && !p.backfilled);
        if (!hasMeasurement) {
          this.points.push({
            id: `P-${comp.id}-BF`,
            componentId: comp.id,
            scannerId: 'MODEL',
            raw: [...comp.modelPos] as [number, number, number],
            datumVersionId: newDatum.id,
            submittedAt: stamp,
            migrated: false,
            backfilled: true,
            occupied: true,
            pendingReview: false
          });
        }
      });

      // 结论处理：已发布保留原依据、标待复核；未发布（草稿）引用旧基准的立即失效，按新参数重算
      this.conclusions.forEach((cl) => {
        if (cl.status === 'published') {
          cl.status = 'review';
          cl.reviewReason = `厂家基准已换版至 ${newDatum.version}，已发布结论保留原依据（${current.version}），请按新参数复核。`;
        } else if (cl.status === 'draft' && cl.datumVersionId !== newDatum.id) {
          cl.status = 'invalid';
          cl.reviewReason = `引用旧基准 ${current.version}，结论已失效，并按 ${newDatum.version} 参数重算。`;
        }
      });
      this.components.forEach((comp) => {
        const oldConclusion = this.conclusions.find((c) => c.componentId === comp.id && c.status === 'invalid');
        if (!oldConclusion) return;
        const point = this.points.find((p) => p.componentId === comp.id && p.occupied && p.datumVersionId === newDatum.id);
        const raw = point ? point.raw : comp.modelPos;
        const survey = applyTransform(raw, newDatum.params);
        const minClearance = clearanceToObstacle(survey);
        this.conclusions.push({
          id: `CL-${comp.id.slice(2)}-${newDatum.version}`,
          componentId: comp.id,
          stepId: comp.stepId,
          datumVersionId: newDatum.id,
          basis: point ? (point.backfilled ? 'backfilled' : point.migrated ? 'migrated' : 'measured') : 'backfilled',
          status: 'draft',
          minClearance,
          threshold: comp.threshold,
          overLimit: minClearance < comp.threshold,
          conflictId: oldConclusion.conflictId,
          occupiedBy: point && !point.backfilled ? point.scannerId : null,
          reviewScanners: [...oldConclusion.reviewScanners],
          retestId: oldConclusion.retestId,
          publishedAt: null,
          calculatedAt: stamp,
          reviewReason: ''
        });
      });
      this.persist();
    },
    // 两台扫描仪同时提交同一构件实测点：先到的占用本次结论，后到的并入待复核项
    submitMeasurement(componentId: string, scannerId: string) {
      const datum = this.activeManufacturerDatum;
      const comp = this.components.find((c) => c.id === componentId);
      if (!datum || !comp) return;
      const stamp = nowStamp();
      const alreadyOccupied = this.points.some((p) => p.componentId === componentId && p.occupied && !p.backfilled);
      const noise: Record<string, [number, number, number]> = {
        'SCAN-A': [0.04, -0.03, 0.02],
        'SCAN-B': [-0.04, 0.06, -0.05]
      };
      const delta = noise[scannerId] ?? [0, 0, 0];
      const raw: [number, number, number] = [
        +(comp.modelPos[0] + delta[0]).toFixed(3),
        +(comp.modelPos[1] + delta[1]).toFixed(3),
        +(comp.modelPos[2] + delta[2]).toFixed(3)
      ];
      const point: MeasuredPoint = {
        id: `P-${comp.id}-${scannerId}-${Date.now()}`,
        componentId,
        scannerId,
        raw,
        datumVersionId: datum.id,
        submittedAt: stamp,
        migrated: false,
        backfilled: false,
        occupied: !alreadyOccupied,
        pendingReview: alreadyOccupied
      };
      this.points.push(point);
      const conclusion = this.conclusions.find(
        (c) => c.componentId === componentId && c.datumVersionId === datum.id && c.status !== 'invalid'
      );
      if (!conclusion) return;
      if (!alreadyOccupied) {
        conclusion.basis = 'measured';
        conclusion.occupiedBy = scannerId;
        conclusion.reviewScanners = [];
        conclusion.reviewReason = '';
        this.recalcConclusion(conclusion);
      } else {
        if (!conclusion.reviewScanners.includes(scannerId)) conclusion.reviewScanners.push(scannerId);
        conclusion.reviewReason = `扫描仪 ${scannerId} 后到，数据并入待复核项；先到 ${conclusion.occupiedBy} 已占用本次结论。`;
      }
      this.persist();
    },
    // 保存冲突：保留现场测量数据，并留下重测条
    saveConflict(conclusionId: string) {
      const cl = this.conclusions.find((c) => c.id === conclusionId);
      if (!cl || !cl.overLimit || cl.conflictId) return;
      const comp = this.components.find((c) => c.id === cl.componentId);
      const stamp = nowStamp();
      const conflictId = `CF-${cl.id}`;
      const retestId = `RT-${cl.id}`;
      const scannerIds = [cl.occupiedBy, ...cl.reviewScanners].filter((s): s is string => !!s);
      this.datumConflicts.unshift({
        id: conflictId,
        conclusionId,
        componentId: cl.componentId,
        stepId: cl.stepId,
        message: `${comp?.name ?? cl.componentId} 最小净空 ${cl.minClearance}m 小于 ${cl.threshold}m 阈值`,
        severity: cl.minClearance < cl.threshold * 0.6 ? 'high' : 'medium',
        keptMeasurement: true,
        retestId,
        createdAt: stamp
      });
      this.retests.unshift({
        id: retestId,
        componentId: cl.componentId,
        conclusionId,
        reason: '净空超限，保留现场测量数据，安排重测复核',
        scannerIds,
        keptMeasurement: true,
        createdAt: stamp
      });
      cl.conflictId = conflictId;
      cl.retestId = retestId;
      this.persist();
    },
    publishConclusion(id: string) {
      const cl = this.conclusions.find((c) => c.id === id);
      if (!cl || cl.status === 'published') return;
      cl.status = 'published';
      cl.publishedAt = nowStamp();
      cl.reviewReason = '';
      this.persist();
    },
    recalcConclusion(cl: Conclusion) {
      const comp = this.components.find((c) => c.id === cl.componentId);
      const datum = this.datumVersions.find((d) => d.id === cl.datumVersionId);
      if (!comp || !datum) return;
      const point =
        this.points.find((p) => p.componentId === cl.componentId && p.occupied && !p.backfilled && p.datumVersionId === cl.datumVersionId) ??
        this.points.find((p) => p.componentId === cl.componentId && p.occupied && p.backfilled && p.datumVersionId === cl.datumVersionId);
      const raw = point ? point.raw : comp.modelPos;
      const survey = applyTransform(raw, datum.params);
      cl.minClearance = clearanceToObstacle(survey);
      cl.overLimit = cl.minClearance < cl.threshold;
      cl.calculatedAt = nowStamp();
    },
    persist() {
      if (typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, JSON.stringify({ ...this.$state, draftSavedAt: new Date().toISOString() }));
    }
  }
});
