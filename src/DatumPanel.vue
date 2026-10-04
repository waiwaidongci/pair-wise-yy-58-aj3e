<script setup lang="ts">
import { computed } from 'vue';
import { useQuasar } from 'quasar';
import { useLiftStore } from './store';
import type { Conclusion, DatumVersion, LiftComponent, PointBasis, TransformParams } from './store';

const store = useLiftStore();
const $q = useQuasar();

const basisMeta: Record<PointBasis, { label: string; color: string }> = {
  measured: { label: '现场实测', color: 'teal' },
  migrated: { label: '历史迁移', color: 'blue-grey' },
  backfilled: { label: '厂家回填', color: 'deep-orange' }
};

const statusMeta = {
  draft: { label: '草稿', color: 'grey' },
  published: { label: '已发布', color: 'teal' },
  invalid: { label: '已失效', color: 'grey-7' },
  review: { label: '待复核', color: 'amber' }
} as const;

const datums = computed(() =>
  [...store.datumVersions].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'survey' ? -1 : 1;
    return a.registeredAt.localeCompare(b.registeredAt);
  })
);

const rows = computed(() =>
  store.components.map((comp) => {
    const datum = store.activeManufacturerDatum;
    const point = store.points.find(
      (p) => p.componentId === comp.id && p.occupied && p.datumVersionId === datum?.id
    );
    const survey = store.surveyPosition(comp.id);
    const clearance = store.clearanceOf(comp.id);
    const conclusion = store.activeConclusionByComponent(comp.id);
    const pending = store.pendingReviewCount(comp.id);
    return { comp, point, survey, clearance, conclusion, pending };
  })
);

const conclusions = computed(() =>
  [...store.conclusions].sort((a, b) =>
    a.componentId === b.componentId ? a.id.localeCompare(b.id) : a.componentId.localeCompare(b.componentId)
  )
);

function datumOf(id: string | null): DatumVersion | undefined {
  return store.datumById(id);
}
function stepTitle(stepId: string) {
  return store.steps.find((s) => s.id === stepId)?.title ?? stepId;
}
function fmtPos(p: [number, number, number] | null | undefined) {
  return p ? `(${p[0].toFixed(2)}, ${p[1].toFixed(2)}, ${p[2].toFixed(2)})` : '—';
}
function fmtParams(t: TransformParams) {
  return `Δx ${t.dx}m · Δy ${t.dy}m · Δz ${t.dz}m · rx ${t.rx} · ry ${t.ry} · rz ${t.rz} · k ${t.k}ppm`;
}
function datumLabel(d: DatumVersion | undefined) {
  return d ? `${d.name} ${d.version}` : '—';
}

function registerVersion() {
  store.registerManufacturerVersion();
  $q.notify({
    type: 'info',
    message: '厂家模型基准已换版：未发布结论按新参数重算，已发布结论转入待复核',
    position: 'top'
  });
}
function submit(comp: LiftComponent, scannerId: string) {
  const occupied = store.points.some((p) => p.componentId === comp.id && p.occupied && !p.backfilled);
  store.submitMeasurement(comp.id, scannerId);
  $q.notify({
    type: occupied ? 'warning' : 'positive',
    message: occupied
      ? `${scannerId} 后到并入待复核项，先到扫描仪已占用本次结论`
      : `${scannerId} 实测点已提交，占用本次净空结论`,
    position: 'top'
  });
}
function saveConflict(cl: Conclusion) {
  store.saveConflict(cl.id);
  $q.notify({ type: 'negative', message: '已建立冲突项：现场测量数据保留，重测条已生成', position: 'top' });
}
function publish(cl: Conclusion) {
  store.publishConclusion(cl.id);
  $q.notify({ type: 'positive', message: `结论 ${cl.id} 已发布，基准依据冻结`, position: 'top' });
}
</script>

<template>
  <div class="datum-panel">
    <header class="page-heading">
      <div>
        <div class="eyebrow">DATUM & TRANSFORMATION</div>
        <h1>基准与换算</h1>
      </div>
      <div class="heading-actions">
        <q-btn outline no-caps icon="history" label="换算历史" />
        <q-btn color="primary" no-caps icon="update" label="登记厂家换版" @click="registerVersion" />
      </div>
    </header>

    <section class="content-panel full-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">DATUM VERSIONS</span>
          <h2>测绘基准版本与七参数换算</h2>
        </div>
        <q-badge color="teal" outline>目标基准：{{ datumLabel(store.surveyDatum) }}</q-badge>
      </div>
      <div class="datum-target-banner">
        <q-icon name="info" size="15px" />
        <span
          >现场扫描点按 <b>2026 测绘基准</b> 入库，厂家模型自带基准；构件位置统一按七参数换算到测绘基准后再计算净空，两侧结论共用同一套基准。</span
        >
      </div>
      <div class="datum-grid">
        <article
          v-for="d in datums"
          :key="d.id"
          class="datum-card"
          :class="{ active: d.status === 'active', superseded: d.status === 'superseded' }"
        >
          <div class="datum-card-head">
            <strong>{{ d.name }} <span class="datum-version-tag">{{ d.version }}</span></strong>
            <q-badge :color="d.kind === 'survey' ? 'blue' : 'deep-orange'">
              {{ d.kind === 'survey' ? '测绘基准' : '厂家基准' }}
            </q-badge>
          </div>
          <div class="datum-params">
            <div><span>Δx 平移</span><strong>{{ d.params.dx }}</strong></div>
            <div><span>Δy 平移</span><strong>{{ d.params.dy }}</strong></div>
            <div><span>Δz 平移</span><strong>{{ d.params.dz }}</strong></div>
            <div><span>rx 旋转</span><strong>{{ d.params.rx }}</strong></div>
            <div><span>ry 旋转</span><strong>{{ d.params.ry }}</strong></div>
            <div><span>rz 旋转</span><strong>{{ d.params.rz }}</strong></div>
            <div><span>k 尺度</span><strong>{{ d.params.k }}ppm</strong></div>
            <div><span>登记时间</span><strong>{{ d.registeredAt.slice(0, 10) }}</strong></div>
          </div>
          <p class="datum-note">{{ d.note }}</p>
          <div class="datum-card-foot">
            <q-badge :color="d.status === 'active' ? 'positive' : 'grey'">
              {{ d.status === 'active' ? '现行' : '已作废' }}
            </q-badge>
            <span class="datum-code">{{ d.code }} · {{ d.id }}</span>
          </div>
        </article>
      </div>
    </section>

    <section class="content-panel full-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">COMPONENT POSITION</span>
          <h2>构件位置换算与实测点占用</h2>
        </div>
        <q-badge v-if="store.activeManufacturerDatum" color="deep-orange" outline>
          现行换算：{{ datumLabel(store.activeManufacturerDatum) }}
        </q-badge>
      </div>
      <div class="table-wrap">
        <table class="convert-table">
          <thead>
            <tr>
              <th>构件</th>
              <th>步骤</th>
              <th>厂家模型坐标</th>
              <th>换算至测绘基准</th>
              <th>数据来源</th>
              <th>占用扫描仪</th>
              <th>最小净空</th>
              <th>实测提交（双扫描仪）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.comp.id" :class="{ 'row-over': row.clearance !== null && row.clearance < row.comp.threshold }">
              <td>
                <strong>{{ row.comp.code }}</strong>
                <small>{{ row.comp.name }}</small>
              </td>
              <td class="step-cell">{{ row.comp.stepId }}<small>{{ stepTitle(row.comp.stepId) }}</small></td>
              <td class="pos-cell">{{ fmtPos(row.comp.modelPos) }}</td>
              <td class="pos-cell survey-pos">{{ fmtPos(row.survey) }}</td>
              <td>
                <q-badge v-if="row.point" :color="basisMeta[row.point.backfilled ? 'backfilled' : row.point.migrated ? 'migrated' : 'measured'].color">
                  {{ basisMeta[row.point.backfilled ? 'backfilled' : row.point.migrated ? 'migrated' : 'measured'].label }}
                </q-badge>
                <q-badge v-else color="deep-orange" outline>厂家回填</q-badge>
              </td>
              <td>
                <span v-if="row.conclusion?.occupiedBy" class="scanner-chip">{{ row.conclusion.occupiedBy }}</span>
                <span v-else class="muted">—</span>
                <q-badge v-if="row.pending" color="amber" text-color="dark" class="pending-badge">待复核 ×{{ row.pending }}</q-badge>
              </td>
              <td class="clearance-cell">
                <strong :class="{ danger: row.clearance !== null && row.clearance < row.comp.threshold }">
                  {{ row.clearance !== null ? row.clearance.toFixed(2) : '—' }}m
                </strong>
                <small>阈值 {{ row.comp.threshold }}m</small>
              </td>
              <td>
                <div class="scanner-actions">
                  <q-btn dense size="sm" color="teal" no-caps label="扫描仪 A" @click="submit(row.comp, 'SCAN-A')" />
                  <q-btn dense size="sm" color="blue-grey" no-caps label="扫描仪 B" @click="submit(row.comp, 'SCAN-B')" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="content-panel full-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">CLEARANCE CONCLUSIONS</span>
          <h2>净空结论与基准追溯</h2>
        </div>
        <span class="panel-hint">每条结论标注所依据的基准版本；换版后未发布结论失效重算，已发布保留原依据</span>
      </div>
      <div class="conclusion-list">
        <article
          v-for="cl in conclusions"
          :key="cl.id"
          class="conclusion-card"
          :class="{ over: cl.overLimit, invalid: cl.status === 'invalid' }"
        >
          <div class="conclusion-card-head">
            <div class="conclusion-meta">
              <strong>{{ cl.id }}</strong>
              <q-badge color="blue-grey" outline>{{ cl.componentId }} · {{ stepTitle(cl.stepId) }}</q-badge>
              <q-badge :color="statusMeta[cl.status].color" :text-color="cl.status === 'review' ? 'dark' : undefined">
                {{ statusMeta[cl.status].label }}
              </q-badge>
              <q-badge :color="basisMeta[cl.basis].color">{{ basisMeta[cl.basis].label }}</q-badge>
            </div>
            <span class="datum-ref">
              <q-icon name="transform" size="13px" />
              基准依据：{{ datumLabel(datumOf(cl.datumVersionId)) }}
            </span>
          </div>
          <div class="conclusion-body">
            <span>最小净空 <b :class="{ danger: cl.overLimit }">{{ cl.minClearance.toFixed(2) }}m</b></span>
            <span>控制阈值 <b>{{ cl.threshold }}m</b></span>
            <span v-if="cl.occupiedBy">占用扫描仪 <b>{{ cl.occupiedBy }}</b></span>
            <span v-if="cl.publishedAt">发布时间 <b>{{ cl.publishedAt }}</b></span>
            <span v-if="cl.conflictId" class="conflict-link">
              <q-icon name="warning" size="13px" /> 冲突项 <b>{{ cl.conflictId }}</b>
            </span>
            <span v-if="cl.retestId" class="retest-link">
              <q-icon name="replay" size="13px" /> 重测条 <b>{{ cl.retestId }}</b>
            </span>
          </div>
          <div v-if="cl.reviewScanners.length" class="review-scanners">
            待复核数据：
            <q-badge v-for="s in cl.reviewScanners" :key="s" color="amber" text-color="dark" class="scanner-chip">{{ s }}</q-badge>
          </div>
          <p v-if="cl.reviewReason" class="review-reason">
            <q-icon name="rate_review" size="13px" /> {{ cl.reviewReason }}
          </p>
          <div class="conclusion-actions">
            <q-btn
              v-if="cl.status === 'draft' && cl.overLimit && !cl.conflictId"
              dense
              color="negative"
              no-caps
              icon="warning"
              label="保存冲突（保留现场测量 · 留重测条）"
              @click="saveConflict(cl)"
            />
            <q-btn
              v-if="cl.status === 'draft'"
              dense
              color="teal"
              no-caps
              icon="lock_open"
              label="发布结论"
              @click="publish(cl)"
            />
            <q-btn
              v-if="cl.status === 'review'"
              dense
              color="amber"
              text-color="dark"
              no-caps
              icon="rate_review"
              label="按新参数复核"
              @click="publish(cl)"
            />
            <span v-if="cl.status === 'invalid'" class="invalid-note">该结论引用旧基准，已由同构件新草稿按 {{ datumLabel(datumOf(cl.datumVersionId)) }} 参数重算。</span>
          </div>
        </article>
      </div>
    </section>

    <section class="content-panel full-panel">
      <div class="panel-heading">
        <div>
          <span class="panel-kicker">CONFLICTS & RETESTS</span>
          <h2>冲突项与重测条</h2>
        </div>
        <q-badge color="negative">{{ store.datumConflicts.length }} 项冲突</q-badge>
      </div>
      <div class="conflict-retest-grid">
        <div class="conflict-list">
          <button v-for="item in store.datumConflicts" :key="item.id" class="conflict-item" @click="store.selectStep(item.stepId)">
            <span class="severity" :class="item.severity">{{ item.severity === 'high' ? '阻断' : '预警' }}</span>
            <div>
              <strong>{{ item.id }} · {{ item.stepId }}</strong>
              <small>{{ item.message }}</small>
              <small class="kept-measurement"><q-icon name="save" size="12px" /> 现场测量数据已保留 · 重测条 {{ item.retestId }}</small>
            </div>
            <q-icon name="arrow_forward" />
          </button>
          <div v-if="store.datumConflicts.length === 0" class="empty-state">当前无超限冲突项。</div>
        </div>
        <div class="retest-list">
          <h3>重测条（现场测量保留）</h3>
          <article v-for="rt in store.retests" :key="rt.id" class="retest-item">
            <div class="retest-head">
              <strong>{{ rt.id }}</strong>
              <q-badge color="teal">已保留现场测量</q-badge>
            </div>
            <small>{{ rt.reason }}</small>
            <small>关联构件 {{ rt.componentId }} · 结论 {{ rt.conclusionId }} · 扫描仪 {{ rt.scannerIds.join('、') }}</small>
            <small class="retest-time">开具时间 {{ rt.createdAt }}</small>
          </article>
          <div v-if="store.retests.length === 0" class="empty-state">暂无重测条。</div>
        </div>
      </div>
    </section>
  </div>
</template>
