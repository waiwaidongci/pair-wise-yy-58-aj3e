<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as THREE from 'three';
import { useLiftStore } from './store';
import type { ClearanceConclusion, DatumKind, MeasuredPoint, ReviewItem } from './store';
import { CLEARANCE_LIMIT } from './store';
import { DatumParams, formatParams, formatVec, fromCanonical, toCanonical } from './datum';

const route = useRoute();
const router = useRouter();
const store = useLiftStore();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const commentText = ref('');
const sceneContainer = ref<HTMLElement | null>(null);
let renderer: THREE.WebGLRenderer | null = null;
let frame = 0;
let resizeObserver: ResizeObserver | null = null;
let theta = 0.8;
let phi = 0.9;
let dragging = false;
let previousX = 0;

const nav = [
  { path: '/', label: '三维复核', icon: 'view_in_ar' },
  { path: '/models', label: '模型与参数', icon: 'tune' },
  { path: '/datum', label: '基准与净空', icon: 'travel_explore' },
  { path: '/checks', label: '冲突与评论', icon: 'rule' },
  { path: '/review', label: '多角色会签', icon: 'fact_check' }
];

const pageTitle = computed(() => nav.find((item) => item.path === route.path)?.label ?? '吊装工作台');

function go(path: string) {
  router.push(path);
}

function severityLabel(severity: string) {
  return severity === 'high' ? '阻断' : '预警';
}

function submitComment() {
  store.addComment(commentText.value);
  commentText.value = '';
}

// ---------- 基准登记表单 ----------

const newKind = ref<DatumKind>('manufacturer');
const newLabel = ref('');
const newNote = ref('');
const newTx = ref(0);
const newTy = ref(0);
const newTz = ref(0);
const newRot = ref(0);
const newScale = ref(1);
const activateOnRegister = ref(true);

function currentParams(): DatumParams {
  return { tx: newTx.value, ty: newTy.value, tz: newTz.value, rotZ: newRot.value, scale: newScale.value };
}

function registerDatum() {
  if (!newLabel.value.trim()) return;
  store.registerDatum(newKind.value, newLabel.value.trim(), currentParams(), newNote.value.trim(), activateOnRegister.value);
  if (activateOnRegister.value) {
    const id = (newKind.value === 'site' ? 'SITE' : 'MFR') + `-V${store.datums.filter((d) => d.kind === newKind.value).length}`;
    store.activateDatum(id);
  }
  newLabel.value = '';
  newNote.value = '';
  newTx.value = 0; newTy.value = 0; newTz.value = 0; newRot.value = 0; newScale.value = 1;
}

function quickVendorV2() {
  store.registerDatum(
    'manufacturer',
    '厂家模型基准 2026-R1（现场配准后）',
    { tx: -0.5, ty: 0, tz: 0, rotZ: 0.02, scale: 1 },
    '厂家换版：模型原点整体西移 0.5m 并顺时针配准 0.02rad。',
    false
  );
  const id = `MFR-V${store.datums.filter((d) => d.kind === 'manufacturer').length}`;
  store.activateDatum(id);
}

function quickSiteV2() {
  store.registerDatum(
    'site',
    '现场测绘基准 V2（导线点复测平差）',
    { tx: 0.12, ty: -0.08, tz: 0.02, rotZ: 0.004, scale: 1.0001 },
    '控制点网复测平差后的新版现场基准；旧实测点迁移归档。',
    false
  );
  const id = `SITE-V${store.datums.filter((d) => d.kind === 'site').length}`;
  store.activateDatum(id);
}

// ---------- 双扫描仪提交 ----------

const scannerChoice = ref<'A' | 'B'>('A');

function demoScanCoords(which: 'A' | 'B'): [number, number, number][] {
  if (which === 'A') {
    return [
      [1.45, -5.5, 5.65], [1.45, -5.5, 8.35], [-1.05, -5.5, 5.65], [-1.05, -5.5, 8.35],
      [1.45, 9.5, 5.65], [1.45, 9.5, 8.35], [-1.05, 9.5, 5.65], [-1.05, 9.5, 8.35]
    ];
  }
  return [
    [1.35, -5.35, 5.7], [1.35, -5.35, 8.3], [-0.95, -5.35, 5.7], [-0.95, -5.35, 8.3],
    [1.35, 9.35, 5.7], [1.35, 9.35, 8.3], [-0.95, 9.35, 5.7], [-0.95, 9.35, 8.3]
  ];
}

function submitDemoScan() {
  const which = scannerChoice.value;
  store.submitScan(
    store.selectedStepId,
    `SCAN-${which}`,
    `扫描仪 ${which}（${which === 'A' ? '先到' : '后到'}）`,
    demoScanCoords(which)
  );
}

// ---------- 展示辅助 ----------

function stepClearance(stepId: string): number {
  return store.computedSteps.find((row) => row.step.id === stepId)?.clearance ?? Infinity;
}

function stepObstacleTitle(stepId: string): string {
  const row = store.computedSteps.find((item) => item.step.id === stepId);
  return row?.obstacleId ? store.obstacleById(row.obstacleId)?.title ?? row.obstacleId : '—';
}

function liveConclusion(stepId: string): ClearanceConclusion | undefined {
  return store.activeConclusions
    .filter((c) => c.stepId === stepId)
    .sort((a, b) => b.calculatedAt.localeCompare(a.calculatedAt))[0];
}

function stateBadge(conclusion?: ClearanceConclusion) {
  if (!conclusion) return { color: 'grey', label: '未建结论' };
  if (conclusion.state === 'published') return { color: conclusion.needReview ? 'amber-9' : 'positive', label: conclusion.needReview ? '已发布·待复核' : '已发布' };
  if (conclusion.state === 'stale') return { color: 'grey-6', label: '已作废' };
  return { color: conclusion.status === 'blocked' ? 'negative' : 'info', label: conclusion.status === 'blocked' ? '未发布·阻断' : '未发布' };
}

function basisLabel(basis: ClearanceConclusion['basis']) {
  return {
    field: '现场实测',
    model: '厂家模型回填',
    'field-history': '历史实测迁移',
    'model-history': '历史模型迁移'
  }[basis];
}

function sourceLabel(source: MeasuredPoint['source']) {
  return {
    field: '现场实测',
    model: '模型回填',
    'field-migrated': '实测点迁移(现行)',
    'model-migrated': '模型点迁移(现行)'
  }[source];
}

function pointsOfStep(stepId: string, historical = false) {
  return store.points
    .filter((p) => p.stepId === stepId && p.historical === historical)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function roundsOfStep(stepId: string) {
  return store.rounds.filter((r) => r.stepId === stepId);
}

function reviewItemForRound(roundId: string): ReviewItem | undefined {
  return store.reviewItems.find((i) => i.roundId === roundId);
}

function obstacleTitle(id: string | null | undefined) {
  return id ? store.obstacleById(id)?.title ?? id : '—';
}

// 现行现场基准下展示用坐标（实测点采集基准 → canonical → 现行现场基准）
function displayCoords(point: MeasuredPoint): string {
  const captured = store.datumById(point.capturedDatumId);
  if (!captured || !point.source.startsWith('field')) return formatVec(point.coords) + `（${point.capturedDatumId}）`;
  const canonical = toCanonical(point.coords, captured.params);
  const shown = fromCanonical(canonical, store.activeSite.params);
  return formatVec(shown);
}

function initializeScene() {
  if (!canvasRef.value || !sceneContainer.value) return;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dce6e1');
  scene.fog = new THREE.Fog('#dce6e1', 34, 92);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  renderer = new THREE.WebGLRenderer({ canvas: canvasRef.value, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene.add(new THREE.HemisphereLight('#eefaf5', '#273b34', 2.3));
  const sun = new THREE.DirectionalLight('#fff4d6', 3.2);
  sun.position.set(14, 28, 18);
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 70),
    new THREE.MeshStandardMaterial({ color: '#b8c7bf', roughness: 0.95 })
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const grid = new THREE.GridHelper(90, 45, '#80948a', '#a8b8b0');
  grid.position.y = 0.02;
  scene.add(grid);

  const steel = new THREE.MeshStandardMaterial({ color: '#ec7a3c', roughness: 0.48, metalness: 0.35 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: '#2d5c4f', roughness: 0.58, metalness: 0.42 });
  const truss = new THREE.Group();
  const chordGeometry = new THREE.BoxGeometry(1.1, 1.1, 15);
  for (const x of [-1.5, 1.5]) {
    for (const y of [5.8, 8.4]) {
      const chord = new THREE.Mesh(chordGeometry, steel);
      chord.position.set(x, y, 0);
      truss.add(chord);
    }
  }
  for (let z = -6; z <= 6; z += 2) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(0.34, 4.8, 0.34), steel);
    brace.position.set(-1.5, 7, z);
    brace.rotation.x = z % 4 === 0 ? 0.36 : -0.36;
    truss.add(brace);
    const cross = new THREE.Mesh(new THREE.BoxGeometry(3, 0.3, 0.3), darkSteel);
    cross.position.set(0, 5.8, z);
    truss.add(cross);
  }
  truss.position.set(0, 1, -6);
  scene.add(truss);

  const crane = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(7, 1.2, 5), darkSteel);
  base.position.y = 0.6;
  crane.add(base);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(3, 2.7, 3), new THREE.MeshStandardMaterial({ color: '#d8a733' }));
  cabin.position.set(-1, 2.5, 0);
  crane.add(cabin);
  const mast = new THREE.Mesh(new THREE.BoxGeometry(1.2, 24, 1.2), darkSteel);
  mast.position.y = 12;
  crane.add(mast);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 36), steel);
  boom.position.set(-8.5, 20.5, 9.5);
  boom.rotation.set(-0.38, 0.7, 0.14);
  crane.add(boom);
  crane.position.set(-22, 0, -18);
  scene.add(crane);

  // 障碍物按统一数学框架（种子 SITE-V1 为 identity，直接用其坐标）绘制
  const obstacleMat = new THREE.MeshStandardMaterial({ color: '#d34c45', transparent: true, opacity: 0.32 });
  for (const obstacle of store.obstacleBoxes) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(obstacle.box.half[0] * 2, obstacle.box.half[2] * 2, obstacle.box.half[1] * 2),
      obstacleMat
    );
    mesh.position.set(obstacle.box.center[0], obstacle.box.center[2], obstacle.box.center[1]);
    scene.add(mesh);
    scene.add(new THREE.BoxHelper(mesh, '#a92d2a'));
  }

  const updateCamera = () => {
    const radius = 62;
    camera.position.set(
      Math.sin(theta) * Math.sin(phi) * radius,
      Math.cos(phi) * radius + 14,
      Math.cos(theta) * Math.sin(phi) * radius
    );
    camera.lookAt(0, 7, -4);
  };

  const render = () => {
    frame = requestAnimationFrame(render);
    // 按当前选中步骤的厂家模型姿态定位桁架（统一框架）
    const row = store.computedSteps.find((item) => item.step.id === store.selectedStepId);
    if (row) {
      const c = row.modelBox.center;
      truss.position.set(c[0], c[2] - 7.1, c[1]);
    }
    truss.position.y += Math.sin(Date.now() / 900) * 0.05;
    updateCamera();
    renderer?.render(scene, camera);
  };
  render();

  const resize = () => {
    if (!sceneContainer.value || !renderer) return;
    const { width, height } = sceneContainer.value.getBoundingClientRect();
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  };
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneContainer.value);
  resize();

  canvasRef.value.onpointerdown = (event) => {
    dragging = true;
    previousX = event.clientX;
    canvasRef.value?.setPointerCapture(event.pointerId);
  };
  canvasRef.value.onpointermove = (event) => {
    if (!dragging) return;
    theta += (event.clientX - previousX) * 0.006;
    previousX = event.clientX;
  };
  canvasRef.value.onpointerup = () => {
    dragging = false;
  };
}

onMounted(() => {
  nextTick(initializeScene);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frame);
  resizeObserver?.disconnect();
  renderer?.dispose();
});
</script>

<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <q-header elevated class="topbar">
      <q-toolbar>
        <div class="brand-mark">LIFT</div>
        <div class="brand-copy">
          <strong>大型构件吊装三维校核</strong>
          <span>
            东塔转换桁架 · 方案 V{{ store.revision }} ·
            现行基准 {{ store.activeManufacturer.id }} + {{ store.activeSite.id }}
          </span>
        </div>
        <q-space />
        <q-badge :color="store.locked ? 'teal' : 'orange'" outline class="status-badge">
          {{ store.locked ? '已锁定发布' : '会签中' }}
        </q-badge>
        <q-btn dense flat round icon="notifications" aria-label="通知">
          <q-badge floating color="red">{{ store.openComments.length + store.openReviewItems.length }}</q-badge>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer show-if-above side="left" :width="232" bordered class="left-nav">
      <div class="drawer-section-label">方案工作区</div>
      <q-list padding>
        <q-item
          v-for="item in nav"
          :key="item.path"
          clickable
          :active="route.path === item.path"
          active-class="nav-active"
          @click="go(item.path)"
        >
          <q-item-section avatar><q-icon :name="item.icon" /></q-item-section>
          <q-item-section>{{ item.label }}</q-item-section>
          <q-item-section v-if="item.path === '/checks'" side>
            <q-badge color="negative">{{ store.conflicts.length }}</q-badge>
          </q-item-section>
          <q-item-section v-else-if="item.path === '/datum'" side>
            <q-badge v-if="store.openReviewItems.length" color="warning">{{ store.openReviewItems.length }}</q-badge>
          </q-item-section>
        </q-item>
      </q-list>
      <div class="draft-state">
        <q-icon name="cloud_done" color="teal" />
        <span>
          草稿已自动保存<br />
          <small>{{ new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }}</small>
        </span>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="workspace-page">
        <header class="page-heading">
          <div>
            <div class="eyebrow">LP-2026-0918 / {{ pageTitle }}</div>
            <h1>{{ pageTitle }}</h1>
          </div>
          <div class="heading-actions">
            <q-btn outline no-caps icon="restart_alt" label="重置演示数据" @click="store.resetAll()" />
            <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '版本已锁定' : '确认并锁定'"
              :disable="store.locked || store.blockingConflicts.length > 0 || store.openComments.length > 0"
              @click="store.lockPlan()" />
          </div>
        </header>

        <!-- ========== 三维复核 / 模型参数 ========== -->
        <section v-if="route.path === '/' || route.path === '/models'" class="work-grid">
          <article class="scene-panel content-panel">
            <div class="panel-heading">
              <div>
                <span class="panel-kicker">THREE.JS SCENE</span>
                <h2>吊装姿态与空间冲突</h2>
              </div>
              <div class="view-bookmarks">
                <button
                  v-for="bookmark in store.viewBookmarks"
                  :key="bookmark"
                  :class="{ active: store.activeBookmark === bookmark }"
                  @click="store.setBookmark(bookmark)"
                >
                  {{ bookmark }}
                </button>
              </div>
            </div>
            <div ref="sceneContainer" class="scene-container">
              <canvas ref="canvasRef" aria-label="吊装三维场景" />
              <div class="scene-legend">
                <span><i class="legend-dot crane" />主吊</span>
                <span><i class="legend-dot load" />构件</span>
                <span><i class="legend-dot risk" />障碍物</span>
              </div>
              <div class="scene-hint">拖动旋转视角 · 构件位置按现行基准换算</div>
            </div>
            <div class="timeline">
              <button
                v-for="stepRow in store.computedSteps"
                :key="stepRow.step.id"
                class="timeline-step"
                :class="[stepRow.clearance < CLEARANCE_LIMIT ? 'blocked' : 'passed', { selected: store.selectedStepId === stepRow.step.id }]"
                @click="store.selectStep(stepRow.step.id)"
              >
                <span>{{ stepRow.step.time }} · {{ stepRow.step.id }}</span>
                <strong>{{ stepRow.step.title }}</strong>
                <small>
                  {{ stepRow.clearance === Infinity ? '—' : stepRow.clearance.toFixed(2) }}m 净空 ·
                  {{ stepRow.basis === 'field' ? '实测' : '模型' }}
                </small>
              </button>
            </div>
          </article>

          <aside class="inspector-panel content-panel">
            <div class="panel-heading compact">
              <div>
                <span class="panel-kicker">STEP INSPECTOR</span>
                <h2>{{ store.selectedStep.id }} · {{ store.selectedStep.title }}</h2>
              </div>
            </div>

            <template v-if="store.selectedConclusion">
              <div class="basis-banner">
                <q-badge :color="stateBadge(store.selectedConclusion).color" :label="stateBadge(store.selectedConclusion).label" />
                <q-badge color="deep-purple-4" :label="store.selectedConclusion.manufacturerDatumId" />
                <q-badge color="cyan-8" :label="store.selectedConclusion.siteDatumId" />
                <q-badge v-if="store.selectedConclusion.needReview" color="amber-9" label="待按新版复核" />
              </div>
            </template>

            <div class="metric-grid">
              <div>
                <span>荷载率</span>
                <strong :class="{ danger: store.selectedStep.loadRate > 90 }">{{ store.selectedStep.loadRate }}%</strong>
              </div>
              <div>
                <span>最小净空（统一框架）</span>
                <strong :class="{ danger: stepClearance(store.selectedStepId) < CLEARANCE_LIMIT }">
                  {{ stepClearance(store.selectedStepId).toFixed(2) }}m
                </strong>
              </div>
              <div><span>控制性障碍</span><strong class="metric-text">{{ stepObstacleTitle(store.selectedStepId) }}</strong></div>
              <div><span>风速</span><strong>{{ store.selectedStep.wind }}m/s</strong></div>
            </div>

            <div class="basis-readout">
              <div><span>位置来源</span><strong>{{ store.selectedComputed?.basis === 'field' ? '现场实测包络' : '厂家模型回填' }}</strong></div>
              <div>
                <span>构件中心(统一框架)</span>
                <strong class="metric-text">
                  {{ store.selectedComputed ? formatVec(store.selectedComputed.box.center) : '—' }}
                </strong>
              </div>
            </div>

            <label class="field-label">荷载率（只读，由吊装方案计算）</label>
            <q-linear-progress :model-value="store.selectedStep.loadRate / 120" size="10px"
              :color="store.selectedStep.loadRate > 90 ? 'negative' : 'primary'" rounded />
            <div class="loadrate-value">{{ store.selectedStep.loadRate }}%</div>
            <q-input :model-value="store.selectedStep.note"
              @update:model-value="(value: string | number | null) => store.updateStepNote(String(value ?? ''))"
              type="textarea" autogrow outlined label="现场控制说明" class="note-input" />

            <!-- 双扫描仪提交 -->
            <div class="scan-submit">
              <span class="field-label">现场扫描仪提交（8 角点，基准 {{ store.activeSite.id }}）</span>
              <q-btn-toggle v-model="scannerChoice" spread no-caps
                :options="[{ label: '扫描仪 A', value: 'A' }, { label: '扫描仪 B', value: 'B' }]" />
              <q-btn color="secondary" no-caps icon='radar' label="提交该构件实测点" class="full-btn"
                @click="submitDemoScan" />
              <div v-for="roundRow in roundsOfStep(store.selectedStepId)" :key="roundRow.id" class="round-row">
                <q-icon :name="roundRow.occupied ? 'how_to_reg' : 'hourglass_bottom'"
                  :color="roundRow.occupied ? 'positive' : 'amber-9'" />
                <div>
                  <strong>{{ roundRow.scannerName }}</strong>
                  <small>
                    {{ new Date(roundRow.submittedAt).toLocaleTimeString('zh-CN') }} 提交 ·
                    {{ roundRow.occupied ? '占用本次结论' : '并入待复核' }}
                  </small>
                </div>
                <q-badge v-if="reviewItemForRound(roundRow.id) && !reviewItemForRound(roundRow.id)?.resolved"
                  color="warning">待复核</q-badge>
              </div>
            </div>
          </aside>
        </section>

        <!-- ========== 基准与净空 ========== -->
        <section v-if="route.path === '/datum'" class="datum-page">
          <div class="datum-grid">
            <article class="content-panel datum-panel">
              <div class="panel-heading compact padded">
                <div>
                  <span class="panel-kicker">DATUM REGISTRY</span>
                  <h2>基准版本登记与换算参数</h2>
                </div>
              </div>
              <div class="padded">
                <div v-for="datum in store.datums" :key="datum.id" class="datum-card"
                  :class="{ active: (datum.kind === 'site' ? store.activeSiteDatumId : store.activeManufacturerDatumId) === datum.id }">
                  <div class="datum-card-head">
                    <div>
                      <strong>
                        <q-badge :color="datum.kind === 'site' ? 'cyan-8' : 'deep-purple-4'" :label="datum.id" />
                        {{ datum.label }}
                      </strong>
                      <small>{{ new Date(datum.publishedAt).toLocaleString('zh-CN') }} · {{ datum.status === 'active' ? '现行启用' : '已被替代' }}</small>
                    </div>
                    <q-badge v-if="datum.status === 'active'" color="positive">现行</q-badge>
                    <q-badge v-else color="grey-6">历史</q-badge>
                  </div>
                  <p class="datum-params">{{ formatParams(datum.params) }}</p>
                  <p v-if="datum.note" class="datum-note">{{ datum.note }}</p>
                </div>

                <div class="quick-actions">
                  <span class="field-label">一键演示换版</span>
                  <div class="action-row">
                    <q-btn color="deep-purple-4" no-caps icon="precision_manufacturing"
                      label="厂家换版 2026-R1 并重算" @click="quickVendorV2" />
                    <q-btn color="cyan-8" no-caps icon="landscape"
                      label="现场基准 V2 平差" @click="quickSiteV2" />
                  </div>
                </div>

                <q-separator class="q-mb-md" />
                <span class="field-label">登记新版本</span>
                <div class="action-row">
                  <q-btn-toggle v-model="newKind" spread no-caps
                    :options="[{ label: '厂家模型基准', value: 'manufacturer' }, { label: '现场测绘基准', value: 'site' }]" />
                </div>
                <q-input v-model="newLabel" outlined dense label="版本名称" class="q-mt-sm" />
                <div class="param-row">
                  <q-input v-model.number="newTx" type="number" outlined dense label="tx / m" />
                  <q-input v-model.number="newTy" type="number" outlined dense label="ty / m" />
                  <q-input v-model.number="newTz" type="number" outlined dense label="tz / m" />
                </div>
                <div class="param-row">
                  <q-input v-model.number="newRot" type="number" outlined dense label="rotZ / rad" />
                  <q-input v-model.number="newScale" type="number" outlined dense label="scale" step="0.0001" />
                </div>
                <q-input v-model="newNote" outlined dense label="版本说明" class="q-mt-sm" />
                <q-toggle v-model="activateOnRegister" label="登记后立即启用（触发迁移与重算）" class="q-mt-sm" />
                <q-btn color="primary" no-caps icon="add_link" label="登记基准版本" class="full-btn q-mt-sm"
                  @click="registerDatum" />
              </div>
            </article>

            <article class="content-panel datum-panel">
              <div class="panel-heading compact padded">
                <div>
                  <span class="panel-kicker">CLEARANCE LEDGER</span>
                  <h2>构件位置换算与最小净空台账</h2>
                </div>
                <q-badge color="primary">阈值 {{ CLEARANCE_LIMIT }}m</q-badge>
              </div>
              <div class="ledger-table-wrap">
                <table class="ledger-table">
                  <thead>
                    <tr>
                      <th>步骤</th><th>构件/步骤</th><th>统一框架中心</th><th>来源</th>
                      <th class="right">最小净空</th><th>最近障碍</th><th>结论基准</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in store.computedSteps" :key="row.step.id"
                      :class="{ selected: store.selectedStepId === row.step.id }"
                      @click="store.selectStep(row.step.id)">
                      <td>{{ row.step.id }}</td>
                      <td class="left">{{ row.step.title }}</td>
                      <td class="mono">{{ formatVec(row.box.center) }}</td>
                      <td>
                        <q-badge :color="row.basis === 'field' ? 'green-7' : 'blue-grey-5'"
                          :label="row.basis === 'field' ? '现场实测' : '模型回填'" />
                      </td>
                      <td class="right text-bold" :class="row.clearance < CLEARANCE_LIMIT ? 'text-negative' : 'text-positive'">
                        {{ row.clearance === Infinity ? '—' : row.clearance.toFixed(2) }}m
                      </td>
                      <td>{{ obstacleTitle(row.obstacleId) }}</td>
                      <td>
                        <template v-if="liveConclusion(row.step.id)">
                          <q-badge color="deep-purple-4" :label="liveConclusion(row.step.id)!.manufacturerDatumId" />
                          <q-badge color="cyan-8" :label="liveConclusion(row.step.id)!.siteDatumId" class="q-ml-xs" />
                        </template>
                        <span v-else>—</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div class="padded conclusion-list">
                <span class="field-label">净空结论（每条显示所用基准版本）</span>
                <div v-for="conclusion in store.activeConclusions.sort((a, b) => a.stepId.localeCompare(b.stepId))"
                  :key="conclusion.id" class="conclusion-row"
                  :class="conclusion.status === 'blocked' ? 'blocked' : 'passed'">
                  <div class="conclusion-main">
                    <strong>{{ conclusion.stepId }}</strong>
                    <span :class="conclusion.status === 'blocked' ? 'text-negative text-bold' : 'text-positive'">
                      {{ conclusion.clearance.toFixed(2) }}m
                      {{ conclusion.status === 'blocked' ? '· 超限阻断' : '· 净空合格' }}
                    </span>
                    <small>依据：{{ basisLabel(conclusion.basis) }} · {{ obstacleTitle(conclusion.obstacleId) }}</small>
                  </div>
                  <div class="conclusion-badges">
                    <q-badge color="deep-purple-4" :label="conclusion.manufacturerDatumId" />
                    <q-badge color="cyan-8" :label="conclusion.siteDatumId" />
                    <q-badge :color="stateBadge(conclusion).color" :label="stateBadge(conclusion).label" />
                  </div>
                </div>
              </div>
            </article>
          </div>

          <div class="datum-grid lower">
            <article class="content-panel datum-panel">
              <div class="panel-heading compact padded">
                <div>
                  <span class="panel-kicker">REVIEW QUEUE</span>
                  <h2>待复核项与重测条</h2>
                </div>
              </div>
              <div class="padded">
                <template v-if="store.openReviewItems.length">
                  <div v-for="item in store.openReviewItems" :key="item.id" class="review-card-row">
                    <q-icon
                      :name="item.kind === 'duplicate-scan' ? 'published_with_changes' : item.kind === 'published-rebasis' ? 'history_toggle_off' : 'content_paste_search'"
                      :color="item.kind === 'duplicate-scan' ? 'amber-9' : 'primary'" />
                    <div class="review-card-body">
                      <strong>{{ item.title }}</strong>
                      <p>{{ item.message }}</p>
                      <div v-if="item.kind === 'duplicate-scan'" class="action-row">
                        <q-btn no-caps unelevated color="warning" icon="save"
                          label="保存冲突：保留现场测量并建重测条"
                          @click="store.adoptLaterRound(item.id)" />
                        <q-btn no-caps flat label="判定为重复噪声" @click="store.dismissLaterRound(item.id)" />
                      </div>
                      <div v-else-if="item.kind === 'published-rebasis'" class="action-row">
                        <q-btn no-caps unelevated color="primary" icon="fact_check"
                          label="按新基准重算并复核" @click="store.resolvePublishedReview(item.id)" />
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="empty-state">暂无待复核项。</div>

                <q-separator class="q-my-md" />
                <span class="field-label">重测条（保存冲突时保留现场测量）</span>
                <div v-for="ticket in store.tickets" :key="ticket.id" class="ticket-row"
                  :class="ticket.status">
                  <q-icon :name="ticket.status === 'open' ? 'assignment_late' : 'task_alt'"
                    :color="ticket.status === 'open' ? 'negative' : 'positive'" />
                  <div class="review-card-body">
                    <strong>{{ ticket.title }} <small>{{ ticket.id }}</small></strong>
                    <p>{{ ticket.reason }}</p>
                    <small>保留现场点 {{ ticket.keptPointIds.length }} 个 ·
                      {{ ticket.status === 'open' ? '待复测' : `已闭环 ${new Date(ticket.closedAt!).toLocaleString('zh-CN')}` }}</small>
                  </div>
                  <q-btn v-if="ticket.status === 'open'" dense no-caps color="positive" icon="done_all"
                    label="复测完成" @click="store.closeTicket(ticket.id)" />
                </div>
              </div>
            </article>

            <article class="content-panel datum-panel">
              <div class="panel-heading compact padded">
                <div>
                  <span class="panel-kicker">POINT MIGRATION</span>
                  <h2>实测点历史迁移与模型回填</h2>
                </div>
              </div>
              <div class="padded step-pick">
                <q-select v-model="store.selectedStepId" :options="store.steps.map((s) => ({ label: `${s.id} · ${s.title}`, value: s.id }))"
                  outlined dense label="选择步骤查看点位" emit-value map-options />
              </div>
              <div class="point-columns">
                <div class="point-col">
                  <h4>现行点（参与本次结论）</h4>
                  <div v-for="point in pointsOfStep(store.selectedStepId, false)" :key="point.id" class="point-row">
                    <q-badge :color="point.source.startsWith('field') ? 'green-7' : 'blue-grey-5'"
                      :label="sourceLabel(point.source)" />
                    <code>{{ displayCoords(point) }}</code>
                    <small>{{ point.capturedDatumId }}<template v-if="point.scannerId"> · {{ point.scannerId }}</template></small>
                  </div>
                  <div v-if="!pointsOfStep(store.selectedStepId, false).length" class="empty-state">无现行点</div>
                </div>
                <div class="point-col history">
                  <h4>历史归档点（旧基准原值留存）</h4>
                  <div v-for="point in pointsOfStep(store.selectedStepId, true)" :key="point.id" class="point-row">
                    <q-badge color="grey-6" label="历史" />
                    <code>{{ formatVec(point.coords) }}</code>
                    <small>{{ point.capturedDatumId }}<template v-if="point.migratedFromDatumId"> ← {{ point.migratedFromDatumId }}</template></small>
                  </div>
                  <div v-if="!pointsOfStep(store.selectedStepId, true).length" class="empty-state">换版后此处保留旧基准坐标</div>
                </div>
              </div>
            </article>
          </div>

          <article class="content-panel datum-panel q-mt-md">
            <div class="panel-heading compact padded">
              <div>
                <span class="panel-kicker">AUDIT TRAIL</span>
                <h2>基准与结论操作流水</h2>
              </div>
            </div>
            <q-timeline color="primary" class="padded audit-timeline">
              <q-timeline-entry v-for="entry in store.audit.slice(0, 12)" :key="entry.id"
                :title="entry.action" :subtitle="new Date(entry.time).toLocaleString('zh-CN')">
                <div>{{ entry.detail }}</div>
              </q-timeline-entry>
            </q-timeline>
          </article>
        </section>

        <!-- ========== 冲突与评论 ========== -->
        <section v-if="route.path === '/checks'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">RULE ENGINE</span>
              <h2>冲突定位、待复核与条件清单</h2>
            </div>
            <q-badge color="negative">{{ store.conflicts.length }} 项待处理</q-badge>
          </div>
          <div class="check-layout">
            <div class="conflict-list">
              <button v-for="item in store.conflicts" :key="item.id" class="conflict-item"
                @click="store.selectStep(item.stepId); go('/datum')">
                <span class="severity" :class="item.severity">{{ severityLabel(item.severity) }}</span>
                <div>
                  <strong>{{ item.stepId }} · {{ item.title }}</strong>
                  <small>{{ item.message }}</small>
                </div>
                <q-icon name="arrow_forward" />
              </button>
              <div v-if="store.conflicts.length === 0" class="empty-state">当前基准下未发现规则冲突。</div>
            </div>
            <div class="comments-panel">
              <h3>条件与评论 · {{ store.selectedStep.id }}</h3>
              <div v-for="comment in store.comments.filter((c) => c.stepId === store.selectedStepId)" :key="comment.id" class="comment-row">
                <div class="comment-avatar">{{ comment.author.slice(0, 1) }}</div>
                <div>
                  <strong>{{ comment.author }} <small>{{ comment.role }}</small></strong>
                  <p>{{ comment.content }}</p>
                  <button v-if="comment.status === 'open'" @click="store.resolveComment(comment.id)">标记已解决</button>
                  <span v-else class="resolved">已解决</span>
                </div>
              </div>
              <q-input v-model="commentText" type="textarea" outlined autogrow label="对该步骤提出条件或补充意见" />
              <q-btn color="primary" no-caps icon="send" label="提交意见" @click="submitComment" />
            </div>
          </div>
        </section>

        <!-- ========== 多角色会签 ========== -->
        <section v-if="route.path === '/review'" class="content-panel full-panel">
          <div class="panel-heading">
            <div>
              <span class="panel-kicker">MULTI-PARTY SIGN-OFF</span>
              <h2>多角色会签与发布门禁</h2>
            </div>
            <div class="readiness">
              <strong>{{ store.readiness }}%</strong><span>发布就绪度</span>
            </div>
          </div>
          <div class="review-grid">
            <article v-for="person in [
              { name: '陈晓', team: '总包项目部', scope: '吊装工序与场地移交', state: '已接受' },
              { name: '刘明', team: '设备管理', scope: '吊车参数与支腿地基', state: '待确认' },
              { name: '周工', team: '安全监督', scope: '净空、风速与警戒区', state: '有保留' },
              { name: '赵磊', team: '方案工程', scope: '基准换算与净空结论', state: '待确认' }
            ]" :key="person.name" class="review-card">
              <div class="review-head">
                <strong>{{ person.name }}</strong>
                <q-badge :color="person.state === '已接受' ? 'positive' : person.state === '有保留' ? 'warning' : 'grey'">{{ person.state }}</q-badge>
              </div>
              <span>{{ person.team }}</span>
              <p>{{ person.scope }}</p>
              <q-btn v-if="person.state !== '已接受'" outline no-caps label="接受方案" />
              <q-btn v-else disable no-caps label="已签署" />
            </article>
          </div>
          <div class="release-gate">
            <div>
              <q-icon name="verified_user" size="30px" />
              <div>
                <strong>发布前门禁</strong>
                <span>净空阻断清零、意见全部关闭；每条结论锁定厂家+现场基准版本。已发布结论换版后保留原依据、标出待复核。</span>
              </div>
            </div>
            <div class="gate-actions">
              <q-badge v-if="store.openReviewItems.length" color="amber-11" text-color="black">
                {{ store.openReviewItems.length }} 条待复核（不阻断发布）
              </q-badge>
              <q-btn color="primary" no-caps icon="lock" :label="store.locked ? '已锁定' : '锁定并发布 V' + (store.revision + 1)"
                :disable="store.locked || store.blockingConflicts.length > 0 || store.openComments.length > 0"
                @click="store.lockPlan()" />
            </div>
          </div>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
