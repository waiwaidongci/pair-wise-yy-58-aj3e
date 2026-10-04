import { defineStore } from 'pinia';
import { graphqlClient, LIFT_PLAN_QUERY } from './graphql';
import {
  DatumParams, DatumVersion, DatumKind, Vec3, Box, identityParams,
  toCanonical, fromCanonical, migratePointCoords,
  transformBox, minClearance as computeMinClearance, envelopeOf, boxCorners, round3
} from './datum';

export type { DatumKind };

export type StepStatus = 'pending' | 'passed' | 'blocked';
export type PointSource = 'field' | 'model' | 'field-migrated' | 'model-migrated';

export interface ModelComponent {
  id: string;
  title: string;
  manufacturerDatumId: string;
  localBox: Box;
}

export interface Obstacle {
  id: string;
  title: string;
  siteDatumId: string;
  box: Box;
}

export interface LiftStep {
  id: string;
  title: string;
  time: string;
  componentId: string;
  localCenter: Vec3;
  loadRate: number;
  wind: number;
  note: string;
}

export type ClearanceStatus = 'passed' | 'blocked';
export type ConclusionState = 'draft' | 'published' | 'stale';

export interface MeasuredPoint {
  id: string;
  stepId: string;
  componentId: string;
  coords: Vec3; // 始终存放在 capturedDatumId 对应基准框架下
  capturedDatumId: string;
  source: PointSource;
  historical: boolean; // 换版迁移后归档的历史原值
  scannerId?: string;
  roundId?: string;
  migratedFromDatumId?: string;
  migratedAt?: string;
  createdAt: string;
}

export interface ScanRound {
  id: string;
  stepId: string;
  scannerId: string;
  scannerName: string;
  occupied: boolean;
  submittedAt: string;
  pointIds: string[];
  envelope: Box;
}

export interface ClearanceConclusion {
  id: string;
  stepId: string;
  state: ConclusionState;
  clearance: number;
  obstacleId: string | null;
  status: ClearanceStatus;
  basis: 'field' | 'model' | 'field-history' | 'model-history';
  siteDatumId: string;
  manufacturerDatumId: string;
  occupiedRoundId?: string;
  reviewScanRoundIds: string[];
  needReview?: boolean;
  supersededBy?: string;
  staleReason?: string;
  publishedAt?: string;
  calculatedAt: string;
}

export type ReviewKind = 'duplicate-scan' | 'published-rebasis' | 'field-over-limit';

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  stepId: string;
  title: string;
  message: string;
  roundId?: string;
  scannerId?: string;
  conclusionId?: string;
  resolved: boolean;
  createdAt: string;
}

export interface ResurveyTicket {
  id: string;
  stepId: string;
  title: string;
  reason: string;
  keptPointIds: string[];
  status: 'open' | 'done';
  createdAt: string;
  closedAt?: string;
}

export interface AuditEntry {
  id: string;
  time: string;
  action: string;
  detail: string;
}

export interface Comment {
  id: string;
  author: string;
  role: string;
  content: string;
  status: 'open' | 'resolved';
  stepId: string;
}

export interface ConflictRow {
  id: string;
  stepId: string;
  title: string;
  message: string;
  severity: 'high' | 'medium';
  kind: string;
}

export const CLEARANCE_LIMIT = 1.5;

// ---------- 种子：基准 ----------

const SITE_V1: DatumVersion = {
  id: 'SITE-V1', kind: 'site', label: '现场测绘基准 V1（东塔一级导线点）',
  params: identityParams(), publishedAt: '2026-09-12T09:00:00+08:00', status: 'active',
  note: '以控制点 KZ-01 为原点的第一版现场独立坐标系。'
};

const MFR_V1: DatumVersion = {
  id: 'MFR-V1', kind: 'manufacturer', label: '厂家模型基准 2024-R0',
  params: identityParams(), publishedAt: '2026-08-20T10:00:00+08:00', status: 'active',
  note: '厂家深化模型交付版本，未作现场配准。'
};

const initialComponents: ModelComponent[] = [
  { id: 'TR-01', title: '转换桁架主段（15m）', manufacturerDatumId: 'MFR-V1', localBox: { center: [0, 0, 0], half: [1.2, 7.5, 1.2] } },
  { id: 'TB-02', title: '平衡梁吊具', manufacturerDatumId: 'MFR-V1', localBox: { center: [0, 0, 0.9], half: [0.5, 2.2, 0.5] } }
];

const initialObstacles: Obstacle[] = [
  { id: 'O-01', title: '已装桁架段', siteDatumId: 'SITE-V1', box: { center: [0, -17.5, 7], half: [1.5, 2.5, 1.5] } },
  { id: 'O-02', title: '东侧临时配电箱', siteDatumId: 'SITE-V1', box: { center: [6.3, -4, 2.5], half: [0.8, 0.8, 2.5] } },
  { id: 'O-03', title: '西侧堆场', siteDatumId: 'SITE-V1', box: { center: [-8, 4, 1.5], half: [3, 2, 1.5] } },
  { id: 'O-04', title: '上方管廊', siteDatumId: 'SITE-V1', box: { center: [0, 6, 12.5], half: [3, 3, 0.4] } },
  { id: 'O-05', title: '东侧斜撑', siteDatumId: 'SITE-V1', box: { center: [6, -1, 3.5], half: [0.5, 0.5, 3.5] } },
  { id: 'O-06', title: '西侧立柱', siteDatumId: 'SITE-V1', box: { center: [-0.5, 11, 2.5], half: [0.6, 0.6, 2] } },
  { id: 'O-07', title: '就位侧临时支撑', siteDatumId: 'SITE-V1', box: { center: [-4.5, -8, 3.8], half: [0.6, 0.6, 3.8] } }
];

const initialSteps: LiftStep[] = [
  { id: 'S-01', title: '地面组对与吊点验收', time: '07:30', componentId: 'TR-01', localCenter: [0, -29, 3], loadRate: 12, wind: 3.4, note: '组对胎架区域，与已装段保持安全距离。' },
  { id: 'S-02', title: '空钩回转与南侧障碍净空', time: '08:10', componentId: 'TR-01', localCenter: [3, -3, 7], loadRate: 28, wind: 4.1, note: '东侧斜撑在厂家模型基准下侵入净空。' },
  { id: 'S-03', title: '桁架试吊离地 300mm', time: '08:45', componentId: 'TR-01', localCenter: [0, 2, 7], loadRate: 76, wind: 5.2, note: '两台扫描仪同时提交本步骤实测点。' },
  { id: 'S-04', title: '主吊回转至安装轴线', time: '09:20', componentId: 'TR-01', localCenter: [2.8, 8, 7], loadRate: 83, wind: 6.8, note: '西侧立柱为控制性障碍。' },
  { id: 'S-05', title: '双机抬吊姿态调整', time: '10:05', componentId: 'TB-02', localCenter: [0, 4, 7.4], loadRate: 92, wind: 7.2, note: '辅吊荷载率为主要风险，净空按模型回填。' },
  { id: 'S-06', title: '就位、临时固定与摘钩', time: '10:50', componentId: 'TR-01', localCenter: [0, -8, 7.2], loadRate: 68, wind: 5.6, note: '四组临时螺栓到位后方可摘钩。' }
];

const initialComments: Comment[] = [
  { id: 'C-11', author: '周工', role: '安全', content: 'S-02 回转路径与东侧斜撑净空不足，请核实厂家模型基准与现场基准偏差。', status: 'open', stepId: 'S-02' },
  { id: 'C-12', author: '刘明', role: '设备', content: '辅吊支腿下方需要补充路基板，提供地耐力实测记录。', status: 'open', stepId: 'S-05' },
  { id: 'C-13', author: '陈晓', role: '总包', content: '同意主吊选型，建议把第三检查点前移到试吊阶段。', status: 'resolved', stepId: 'S-03' }
];

const SEED_TIME = '2026-10-03T08:40:00+08:00';

function scanCornersS03A(): Vec3[] {
  return [
    [1.45, -5.5, 5.65], [1.45, -5.5, 8.35], [-1.05, -5.5, 5.65], [-1.05, -5.5, 8.35],
    [1.45, 9.5, 5.65], [1.45, 9.5, 8.35], [-1.05, 9.5, 5.65], [-1.05, 9.5, 8.35]
  ];
}
function scanCornersS03B(): Vec3[] {
  return [
    [1.35, -5.35, 5.7], [1.35, -5.35, 8.3], [-0.95, -5.35, 5.7], [-0.95, -5.35, 8.3],
    [1.35, 9.35, 5.7], [1.35, 9.35, 8.3], [-0.95, 9.35, 5.7], [-0.95, 9.35, 8.3]
  ];
}

// ---------- 纯函数：统一框架几何 ----------

type GeoState = {
  datums: DatumVersion[];
  activeManufacturerDatumId: string;
  components: ModelComponent[];
  obstacles: Obstacle[];
  steps: LiftStep[];
  points: MeasuredPoint[];
};

export interface ComputedStepRow {
  step: LiftStep;
  component: ModelComponent;
  box: Box;
  modelBox: Box;
  activePoints: MeasuredPoint[];
  basis: 'field' | 'model';
  clearance: number;
  obstacleId: string | null;
}

function pointCanonical(point: MeasuredPoint, datums: DatumVersion[]): Vec3 {
  const datum = datums.find((d) => d.id === point.capturedDatumId);
  return toCanonical(point.coords, datum ? datum.params : identityParams());
}

function canonicalEnvelope(points: MeasuredPoint[], datums: DatumVersion[]): Box | null {
  return envelopeOf(points.map((p) => pointCanonical(p, datums)));
}

function obstaclesCanonical(state: Pick<GeoState, 'obstacles' | 'datums'>) {
  return state.obstacles.map((obstacle) => {
    const datum = state.datums.find((d) => d.id === obstacle.siteDatumId && d.kind === 'site');
    return { id: obstacle.id, title: obstacle.title, box: transformBox(obstacle.box, datum ? datum.params : identityParams()) };
  });
}

function computeStepRow(state: GeoState, step: LiftStep): ComputedStepRow {
  const mfr = state.datums.find((d) => d.id === state.activeManufacturerDatumId && d.kind === 'manufacturer')!;
  const component = state.components.find((c) => c.id === step.componentId)!;
  const fieldPoints = state.points.filter((p) => p.stepId === step.id && !p.historical && p.source.startsWith('field'));
  const modelPoints = state.points.filter((p) => p.stepId === step.id && !p.historical && p.source.startsWith('model'));
  const modelBox = transformBox(
    { center: step.localCenter.map((v, i) => v + component.localBox.center[i]) as Vec3, half: component.localBox.half },
    mfr.params
  );
  const fieldBox = canonicalEnvelope(fieldPoints, state.datums);
  const activePoints = fieldPoints.length ? fieldPoints : modelPoints;
  const box = fieldPoints.length && fieldBox ? fieldBox : modelBox;
  const result = computeMinClearance(box, obstaclesCanonical(state));
  return {
    step, component, box, modelBox, activePoints,
    basis: fieldPoints.length ? 'field' : 'model',
    clearance: result.value,
    obstacleId: result.obstacleId
  };
}

function computeAllRows(state: GeoState): ComputedStepRow[] {
  return state.steps.map((step) => computeStepRow(state, step));
}

function envelopeFromCoords(coords: Vec3[]): Box | null {
  return envelopeOf(coords);
}

// ---------- 持久化 / 种子 ----------

const cacheKey = 'yy58-lift-datum-v2';

interface PersistShape extends GeoState {
  version: number;
  activeSiteDatumId: string;
  rounds: ScanRound[];
  conclusions: ClearanceConclusion[];
  reviewItems: ReviewItem[];
  tickets: ResurveyTicket[];
  audit: AuditEntry[];
  comments: Comment[];
  selectedStepId: string;
  revision: number;
  locked: boolean;
}

function buildSeed(): PersistShape {
  const points: MeasuredPoint[] = [];
  let seq = 0;
  const pid = () => `P-${String(++seq).padStart(3, '0')}`;

  const addPoints = (coords: Vec3[], scannerId: string, roundId: string) =>
    coords.map((coordsRow) => {
      const id = pid();
      points.push({
        id, stepId: 'S-03', componentId: 'TR-01', coords: coordsRow,
        capturedDatumId: 'SITE-V1', source: 'field', historical: false,
        scannerId, roundId, createdAt: SEED_TIME
      });
      return id;
    });

  const idsA = addPoints(scanCornersS03A(), 'SCAN-A', 'R-S03-A');
  const idsB = addPoints(scanCornersS03B(), 'SCAN-B', 'R-S03-B');

  const rounds: ScanRound[] = [
    { id: 'R-S03-A', stepId: 'S-03', scannerId: 'SCAN-A', scannerName: '扫描仪 A（先到）', occupied: true, submittedAt: '2026-10-03T08:31:00+08:00', pointIds: idsA, envelope: envelopeFromCoords(scanCornersS03A())! },
    { id: 'R-S03-B', stepId: 'S-03', scannerId: 'SCAN-B', scannerName: '扫描仪 B（后到）', occupied: false, submittedAt: '2026-10-03T08:34:00+08:00', pointIds: idsB, envelope: envelopeFromCoords(scanCornersS03B())! }
  ];

  return {
    version: 2,
    datums: [SITE_V1, MFR_V1],
    activeSiteDatumId: 'SITE-V1',
    activeManufacturerDatumId: 'MFR-V1',
    components: initialComponents,
    obstacles: initialObstacles,
    steps: initialSteps,
    points,
    rounds,
    conclusions: [],
    reviewItems: [
      {
        id: 'RV-SEED-01', kind: 'duplicate-scan', stepId: 'S-03',
        title: '重复扫描待复核 · S-03',
        message: '扫描仪 B（后到）晚于占用批次提交 8 个实测点；按先到先得原则不覆盖本次结论，已并入待复核。',
        roundId: 'R-S03-B', scannerId: 'SCAN-B', resolved: false, createdAt: '2026-10-03T08:34:00+08:00'
      }
    ],
    tickets: [],
    audit: [
      { id: 'AU-01', time: SEED_TIME, action: '初始化', detail: '登记现场测绘基准 SITE-V1 与厂家模型基准 MFR-V1，按统一数学框架重算全部步骤；S-03 扫描仪 A 先到占用结论，扫描仪 B 并入待复核。' }
    ],
    comments: initialComments,
    selectedStepId: 'S-02',
    revision: 4,
    locked: false
  };
}

function loadState(): PersistShape {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(cacheKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PersistShape;
        if (parsed.version === 2 && parsed.datums?.length) return parsed;
      } catch {
        // 旧草稿不兼容，回落种子
      }
    }
  }
  return buildSeed();
}

let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidCounter}`;
}

// ---------- Store ----------

export const useLiftStore = defineStore('lift-datum', {
  state: () => {
    const seed = loadState();
    return {
      ...seed,
      viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'] as string[],
      activeBookmark: '主吊全景' as string
    };
  },

  getters: {
    selectedStep(state): LiftStep {
      return state.steps.find((step) => step.id === state.selectedStepId) ?? state.steps[0];
    },
    selectedComputed(state): ComputedStepRow | undefined {
      return computeAllRows(state).find((row) => row.step.id === state.selectedStepId);
    },
    selectedConclusion(state): ClearanceConclusion | undefined {
      return state.conclusions
        .filter((c) => c.stepId === state.selectedStepId && c.state !== 'stale')
        .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
    },
    activeSite(state): DatumVersion {
      return state.datums.find((d) => d.id === state.activeSiteDatumId) ?? state.datums[0];
    },
    activeManufacturer(state): DatumVersion {
      return state.datums.find((d) => d.id === state.activeManufacturerDatumId) ?? state.datums[0];
    },
    datumById(state): (id: string) => DatumVersion | undefined {
      return (id: string) => state.datums.find((d) => d.id === id);
    },
    componentById(state): (id: string) => ModelComponent | undefined {
      return (id: string) => state.components.find((c) => c.id === id);
    },
    obstacleById(state): (id: string) => Obstacle | undefined {
      return (id: string) => state.obstacles.find((o) => o.id === id);
    },
    obstacleBoxes(state) {
      return obstaclesCanonical(state);
    },
    computedSteps(state): ComputedStepRow[] {
      return computeAllRows(state);
    },
    openComments(state): Comment[] {
      return state.comments.filter((comment) => comment.status === 'open');
    },
    activeConclusions(state): ClearanceConclusion[] {
      return state.conclusions.filter((c) => c.state !== 'stale');
    },
    conclusionByStep(state): Record<string, ClearanceConclusion | undefined> {
      const map: Record<string, ClearanceConclusion | undefined> = {};
      const live = state.conclusions.filter((c) => c.state !== 'stale').sort((a, b) => a.calculatedAt.localeCompare(b.calculatedAt));
      for (const c of live) map[c.stepId] = c; // 升序，最后写入即最新
      return map;
    },
    openReviewItems(state): ReviewItem[] {
      return state.reviewItems.filter((item) => !item.resolved);
    },
    openTickets(state): ResurveyTicket[] {
      return state.tickets.filter((ticket) => ticket.status === 'open');
    },
    conflicts(state): ConflictRow[] {
      const rows: ConflictRow[] = [];
      const rowsForSteps = computeAllRows(state);
      const liveMap: Record<string, ClearanceConclusion | undefined> = {};
      for (const c of state.conclusions.filter((x) => x.state !== 'stale').sort((a, b) => a.calculatedAt.localeCompare(b.calculatedAt))) {
        liveMap[c.stepId] = c;
      }
      for (const row of rowsForSteps) {
        const conclusion = liveMap[row.step.id];
        const clearance = conclusion ? conclusion.clearance : row.clearance;
        const basisBadge = conclusion
          ? `依据 ${conclusion.manufacturerDatumId}+${conclusion.siteDatumId}`
          : `依据 ${state.activeManufacturerDatumId}+${state.activeSiteDatumId}（未建结论）`;
        if (clearance < CLEARANCE_LIMIT) {
          const over = (CLEARANCE_LIMIT - clearance).toFixed(2);
          rows.push({
            id: conclusion ? `cf-${conclusion.id}` : `cf-${row.step.id}`,
            stepId: row.step.id,
            title: row.step.title,
            message: `最小净空 ${clearance.toFixed(2)}m 小于 ${CLEARANCE_LIMIT}m（侵入 ${over}m）· ${basisBadge}`,
            severity: 'high',
            kind: conclusion?.state === 'published' ? 'published-blocked' : 'clearance'
          });
        }
        if (row.step.loadRate > 90) {
          rows.push({
            id: `ld-${row.step.id}`, stepId: row.step.id, title: row.step.title,
            message: `荷载率 ${row.step.loadRate}% 超过 90% 控制阈值`, severity: 'medium', kind: 'load'
          });
        }
      }
      for (const item of state.reviewItems.filter((i) => !i.resolved)) {
        rows.push({ id: `rv-${item.id}`, stepId: item.stepId, title: item.title, message: item.message, severity: 'medium', kind: item.kind });
      }
      return rows;
    },
    blockingConflicts(): ConflictRow[] {
      return this.conflicts.filter((row) => row.severity === 'high' && row.kind !== 'published-blocked');
    },
    readiness(state): number {
      const rows = computeAllRows(state);
      const total = rows.length;
      const ok = rows.filter((row) => row.clearance >= CLEARANCE_LIMIT).length;
      const penalty =
        state.comments.filter((c) => c.status === 'open').length * 8 +
        state.reviewItems.filter((i) => !i.resolved).length * 6 +
        state.tickets.filter((t) => t.status === 'open').length * 6;
      return Math.max(0, Math.round((ok / total) * 100 - penalty));
    }
  },

  actions: {
    selectStep(id: string) {
      this.selectedStepId = id;
      this.persist();
    },

    updateStepNote(note: string) {
      const step = this.steps.find((s) => s.id === this.selectedStepId);
      if (step) step.note = note;
      this.persist();
    },

    addAudit(action: string, detail: string) {
      this.audit.unshift({ id: uid('AU'), time: new Date().toISOString(), action, detail });
    },

    // ---------- 基准登记 / 启用 ----------

    registerDatum(kind: DatumKind, label: string, params: DatumParams, note: string, activate: boolean): string {
      const versionNo = this.datums.filter((d) => d.kind === kind).length + 1;
      const id = `${kind === 'site' ? 'SITE' : 'MFR'}-V${versionNo}`;
      const datum: DatumVersion = {
        id, kind, label, params,
        publishedAt: new Date().toISOString(),
        status: activate ? 'active' : 'superseded',
        note
      };
      if (activate) for (const old of this.datums.filter((d) => d.kind === kind)) old.status = 'superseded';
      this.datums.push(datum);
      this.addAudit('登记基准版本', `${id}「${label}」${activate ? '并启用' : '仅登记'}：平移(${round3(params.tx)},${round3(params.ty)},${round3(params.tz)})，旋转 ${round3(params.rotZ)}rad，尺度 ${round3(params.scale)}`);
      this.persist();
      return id;
    },

    /**
     * 换版总流程：
     * 1) 旧版本 superseded、新版本 active；
     * 2) 关联旧基准的现行点经统一框架折算迁移到新版本，原值归档为历史数据；
     *    无实测的步骤按厂家模型回填合成点；
     * 3) 未发布且引用旧基准的结论立即作废(stale)，按新参数重算；
     *    已发布的保留原依据、原净空，仅置待复核。
     */
    activateDatum(newId: string) {
      const newDatum = this.datums.find((d) => d.id === newId);
      if (!newDatum || newDatum.status === 'active') return;
      const kind = newDatum.kind;
      const oldId = kind === 'site' ? this.activeSiteDatumId : this.activeManufacturerDatumId;
      if (oldId === newId) return;
      const oldDatum = this.datums.find((d) => d.id === oldId)!;
      const stamp = new Date().toISOString();

      for (const d of this.datums) if (d.kind === kind) d.status = 'superseded';
      newDatum.status = 'active';
      if (kind === 'site') this.activeSiteDatumId = newId;
      else this.activeManufacturerDatumId = newId;

      // 2) 点迁移（现场换版迁现场实测点；厂家换版迁模型回填点；历史归档点冻结）
      const migratable = this.points.filter((p) => {
        if (p.historical || p.capturedDatumId !== oldId) return false;
        if (kind === 'site') return p.source.startsWith('field');
        return p.source.startsWith('model');
      });
      for (const point of migratable) {
        const migrated = migratePointCoords(point.coords, oldDatum.params, newDatum.params);
        this.points.push({
          ...point,
          id: uid('H'),
          coords: point.coords,
          historical: true,
          source: point.source.startsWith('field') ? 'field-migrated' : 'model-migrated',
          capturedDatumId: oldId,
          migratedFromDatumId: oldId,
          migratedAt: stamp,
          createdAt: stamp
        });
        point.coords = migrated.map((v) => round3(v)) as Vec3;
        point.capturedDatumId = newId;
        point.source = point.source.startsWith('field') ? 'field-migrated' : 'model-migrated';
        point.migratedFromDatumId = oldId;
        point.migratedAt = stamp;
      }

      this.backfillMissingFromModel(stamp);

      // 3) 结论：未发布作废重算；已发布保留原依据待复核
      const staleStepIds: string[] = [];
      for (const conclusion of this.conclusions) {
        const referencesOld = kind === 'site' ? conclusion.siteDatumId === oldId : conclusion.manufacturerDatumId === oldId;
        if (!referencesOld || conclusion.state === 'stale') continue;
        if (conclusion.state === 'published') {
          conclusion.needReview = true;
          this.reviewItems.unshift({
            id: uid('RV'), kind: 'published-rebasis', stepId: conclusion.stepId,
            title: `已发布结论待复核 · ${conclusion.stepId}`,
            message: `原结论依据 ${conclusion.manufacturerDatumId}+${conclusion.siteDatumId}，净空 ${conclusion.clearance.toFixed(2)}m 保留为原依据；现行${kind === 'site' ? '现场' : '厂家'}基准 ${newId} 已启用，请安排复核。`,
            conclusionId: conclusion.id, resolved: false, createdAt: stamp
          });
        } else {
          conclusion.state = 'stale';
          conclusion.staleReason = `引用的${kind === 'site' ? '现场' : '厂家'}基准 ${oldId} 被 ${newId} 替代，未发布结论立即作废并按新参数重算`;
          staleStepIds.push(conclusion.stepId);
        }
      }
      for (const stepId of Array.from(new Set(staleStepIds))) {
        const created = this.recalcStep(stepId, stamp);
        const stale = this.conclusions.find((c) => c.stepId === stepId && c.state === 'stale' && !c.supersededBy);
        if (stale && created) stale.supersededBy = created.id;
      }

      this.addAudit(
        kind === 'site' ? '现场基准换版' : '厂家基准换版',
        `${oldId} → ${newId}：${migratable.length} 个点迁移并归档原值；未发布结论作废重算 ${Array.from(new Set(staleStepIds)).length} 条；已发布结论保留原依据并标待复核。`
      );
      this.persist();
    },

    /** 缺实测的步骤按厂家模型回填 8 角点（存厂家基准局部框架，标注模型来源） */
    backfillMissingFromModel(stamp: string) {
      for (const step of this.steps) {
        const hasField = this.points.some((p) => p.stepId === step.id && !p.historical && p.source.startsWith('field'));
        const hasBackfill = this.points.some((p) => p.stepId === step.id && !p.historical && p.source.startsWith('model'));
        if (hasField || hasBackfill) continue;
        const component = this.components.find((c) => c.id === step.componentId)!;
        const center = step.localCenter.map((v, i) => v + component.localBox.center[i]) as Vec3;
        const roundId = uid('BM');
        for (const corner of boxCorners({ center, half: component.localBox.half })) {
          this.points.push({
            id: uid('P'), stepId: step.id, componentId: component.id,
            coords: corner.map((v) => round3(v)) as Vec3,
            capturedDatumId: component.manufacturerDatumId,
            source: 'model', historical: false, roundId, createdAt: stamp
          });
        }
      }
    },

    /** 按现行双基准重算单步骤并写入新结论 */
    recalcStep(stepId: string, stamp = new Date().toISOString()): ClearanceConclusion | null {
      const step = this.steps.find((s) => s.id === stepId);
      if (!step) return null;
      const row = computeStepRow(this.$state, step);
      const used = row.activePoints[0];
      const basis: ClearanceConclusion['basis'] = row.basis === 'field'
        ? (used?.source === 'field-migrated' ? 'field-history' : 'field')
        : (used?.source === 'model-migrated' ? 'model-history' : 'model');

      const occupiedRound = this.rounds
        .filter((r) => r.stepId === stepId && r.occupied)
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];

      const conclusion: ClearanceConclusion = {
        id: uid('CL'),
        stepId,
        state: 'draft',
        clearance: row.clearance,
        obstacleId: row.obstacleId,
        status: row.clearance < CLEARANCE_LIMIT ? 'blocked' : 'passed',
        basis,
        siteDatumId: this.activeSiteDatumId,
        manufacturerDatumId: this.activeManufacturerDatumId,
        occupiedRoundId: occupiedRound?.id,
        reviewScanRoundIds: this.rounds.filter((r) => r.stepId === stepId && !r.occupied).map((r) => r.id),
        calculatedAt: stamp
      };
      this.conclusions.push(conclusion);
      this.persist();
      return conclusion;
    },

    /** 首次进入：缺实测先模型回填，再为每个步骤按现行双基准建结论 */
    ensureConclusions() {
      let changed = false;
      this.backfillMissingFromModel(new Date().toISOString());
      for (const step of this.steps) {
        const live = this.conclusions.find(
          (c) => c.stepId === step.id && c.state !== 'stale' &&
            c.siteDatumId === this.activeSiteDatumId &&
            c.manufacturerDatumId === this.activeManufacturerDatumId
        );
        if (!live) {
          this.recalcStep(step.id);
          changed = true;
        }
      }
      if (changed) this.persist();
    },

    // ---------- 双扫描仪并提 ----------

    /** 提交一批实测点：先到占用本次结论；后到并入待复核，不覆盖。 */
    submitScan(stepId: string, scannerId: string, scannerName: string, coords: Vec3[]) {
      const stamp = new Date().toISOString();
      const step = this.steps.find((s) => s.id === stepId)!;
      const roundId = uid('R');
      const pointIds: string[] = [];
      for (const c of coords) {
        const id = uid('P');
        this.points.push({
          id, stepId, componentId: step.componentId,
          coords: c.map((v) => round3(v)) as Vec3,
          capturedDatumId: this.activeSiteDatumId,
          source: 'field', historical: false, scannerId, roundId, createdAt: stamp
        });
        pointIds.push(id);
      }
      const env = envelopeFromCoords(coords) ?? { center: [0, 0, 0] as Vec3, half: [0, 0, 0] as Vec3 };
      const existingOccupied = this.rounds.some((r) => r.stepId === stepId && r.occupied);
      this.rounds.push({
        id: roundId, stepId, scannerId, scannerName,
        occupied: !existingOccupied, submittedAt: stamp, pointIds, envelope: env
      });

      if (!existingOccupied) {
        const created = this.recalcStep(stepId, stamp);
        this.addAudit('现场扫描入库', `${scannerName} 先到，占用 ${stepId} 本次结论（结论 ${created?.id ?? '-'}，依据 ${this.activeManufacturerDatumId}+${this.activeSiteDatumId}）。`);
      } else {
        const live = this.conclusions
          .filter((c) => c.stepId === stepId && c.state !== 'stale')
          .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
        if (live && !live.reviewScanRoundIds.includes(roundId)) live.reviewScanRoundIds.push(roundId);
        this.reviewItems.unshift({
          id: uid('RV'), kind: 'duplicate-scan', stepId,
          title: `重复扫描待复核 · ${stepId}`,
          message: `${scannerName} 晚于占用批次提交 ${coords.length} 个实测点；按先到先得不覆盖本次结论，已并入待复核。`,
          roundId, scannerId, conclusionId: live?.id, resolved: false, createdAt: stamp
        });
        this.addAudit('重复扫描并入复核', `${stepId}：${scannerName} 后到，现场测量已保留，结论仍由先到批次占用，差异进入待复核。`);
      }
      this.persist();
    },

    /** 复核后到批次：保存冲突 → 保留现场测量并建重测条；切换占用并重算。 */
    adoptLaterRound(itemId: string) {
      const item = this.reviewItems.find((i) => i.id === itemId);
      if (!item || !item.roundId) return;
      const round = this.rounds.find((r) => r.id === item.roundId)!;
      const step = this.steps.find((s) => s.id === item.stepId)!;
      const stamp = new Date().toISOString();

      for (const r of this.rounds) if (r.stepId === step.id) r.occupied = r.id === round.id;

      const ticket: ResurveyTicket = {
        id: uid('TK'), stepId: step.id,
        title: `净空重测 · ${step.id} ${step.title}`,
        reason: `复核 ${round.scannerName} 批次与占用批次存在差异，按“保存冲突即保留现场测量”处理：现场点全部保留，结论切换前安排重测确认。`,
        keptPointIds: round.pointIds, status: 'open', createdAt: stamp
      };
      this.tickets.unshift(ticket);

      const created = this.recalcStep(step.id, stamp);
      this.reviewItems.unshift({
        id: uid('RV'), kind: 'field-over-limit', stepId: step.id,
        title: `现场实测净空待闭环 · ${step.id}`,
        message: created && created.status === 'blocked'
          ? `保留现场测量后净空 ${created.clearance.toFixed(2)}m 仍超限，重测条 ${ticket.id} 已下发。`
          : `现场测量已保留，重测条 ${ticket.id} 待复测闭环。`,
        conclusionId: created?.id, resolved: false, createdAt: stamp
      });
      item.resolved = true;
      this.addAudit('保存冲突-保留现场测量', `${step.id}：启用 ${round.scannerName} 批次，原始现场点保留，重测条 ${ticket.id} 已生成（结论 ${created?.id ?? '-'}）。`);
      this.persist();
    },

    /** 后到批次判定为重复噪声，关闭待复核项，维持先到批次结论。 */
    dismissLaterRound(itemId: string) {
      const item = this.reviewItems.find((i) => i.id === itemId);
      if (item) item.resolved = true;
      this.addAudit('重复扫描关闭', `${item?.stepId ?? ''}：后到批次判定为重复噪声，维持先到批次结论。`);
      this.persist();
    },

    closeTicket(ticketId: string) {
      const ticket = this.tickets.find((t) => t.id === ticketId);
      if (ticket) {
        ticket.status = 'done';
        ticket.closedAt = new Date().toISOString();
        this.addAudit('重测闭环', `${ticket.stepId}：重测条 ${ticketId} 复测完成并关闭。`);
      }
      this.persist();
    },

    /** 已发布换版结论按新参数重算复核：通过则清除待复核（原依据留存），超限则保持打开并生成阻断冲突。 */
    resolvePublishedReview(itemId: string) {
      const item = this.reviewItems.find((i) => i.id === itemId);
      if (!item) return;
      const conclusion = this.conclusions.find((c) => c.id === item.conclusionId);
      const stamp = new Date().toISOString();
      const fresh = this.recalcStep(item.stepId, stamp);
      if (conclusion && fresh && fresh.status === 'passed') {
        conclusion.needReview = false;
        item.resolved = true;
        this.addAudit('已发布结论复核通过', `${item.stepId}：按 ${this.activeManufacturerDatumId}+${this.activeSiteDatumId} 重算净空 ${fresh.clearance.toFixed(2)}m；原依据 ${conclusion.manufacturerDatumId}+${conclusion.siteDatumId}（${conclusion.clearance.toFixed(2)}m）留存备查，新结论 ${fresh.id}。`);
      } else if (fresh) {
        this.addAudit('已发布结论复核未过', `${item.stepId}：新基准下净空 ${fresh.clearance.toFixed(2)}m 超限，待复核项保持打开并生成阻断冲突（结论 ${fresh.id}）。`);
      }
      this.persist();
    },

    // ---------- 发布 / 评论 / 锁定 ----------

    /** 发布当前合格的草稿结论；已发布的保持原依据不动。 */
    publishConclusions(): number {
      const stamp = new Date().toISOString();
      let count = 0;
      for (const step of this.steps) {
        const live = this.conclusions
          .filter((c) => c.stepId === step.id && c.state !== 'stale')
          .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
        if (live && live.state === 'draft' && live.status === 'passed') {
          live.state = 'published';
          live.publishedAt = stamp;
          count += 1;
        }
      }
      this.addAudit('结论发布', `发布 ${count} 条净空结论，均锁定当时基准版本作为依据。`);
      this.persist();
      return count;
    },

    addComment(content: string, author = '王工', role = '方案') {
      if (!content.trim()) return;
      this.comments.unshift({ id: uid('C'), author, role, content, status: 'open', stepId: this.selectedStepId });
      this.persist();
    },

    resolveComment(id: string) {
      const item = this.comments.find((comment) => comment.id === id);
      if (item) item.status = 'resolved';
      this.persist();
    },

    lockPlan() {
      if (this.blockingConflicts.length === 0 && this.openComments.length === 0) {
        this.publishConclusions();
        this.locked = true;
        this.revision += 1;
        graphqlClient.writeQuery({
          query: LIFT_PLAN_QUERY,
          variables: { id: 'LP-2026-0918' },
          data: {
            liftPlan: {
              __typename: 'LiftPlan', id: 'LP-2026-0918', name: '东塔转换桁架吊装',
              revision: this.revision, status: 'LOCKED',
              steps: this.steps.map((s) => ({
                __typename: 'LiftStep', id: s.id, name: s.title, loadRate: s.loadRate,
                clearance: this.conclusionByStep[s.id]?.clearance ?? 0
              }))
            }
          }
        });
        this.addAudit('方案锁定发布', `V${this.revision} 锁定，全部净空结论附带基准版本依据快照。`);
      }
      this.persist();
    },

    setBookmark(name: string) {
      this.activeBookmark = name;
      if (!this.viewBookmarks.includes(name)) this.viewBookmarks.push(name);
      this.persist();
    },

    resetAll() {
      localStorage.removeItem(cacheKey);
      const seed = buildSeed();
      Object.assign(this.$state, seed, { viewBookmarks: ['主吊全景', '东侧障碍', '安装轴线'], activeBookmark: '主吊全景' });
      this.ensureConclusions();
      this.persist();
    },

    persist() {
      if (typeof localStorage === 'undefined') return;
      const snapshot: PersistShape = {
        version: 2,
        datums: this.datums,
        activeSiteDatumId: this.activeSiteDatumId,
        activeManufacturerDatumId: this.activeManufacturerDatumId,
        components: this.components,
        obstacles: this.obstacles,
        steps: this.steps,
        points: this.points,
        rounds: this.rounds,
        conclusions: this.conclusions,
        reviewItems: this.reviewItems,
        tickets: this.tickets,
        audit: this.audit,
        comments: this.comments,
        selectedStepId: this.selectedStepId,
        revision: this.revision,
        locked: this.locked
      };
      localStorage.setItem(cacheKey, JSON.stringify(snapshot));
    }
  }
});
