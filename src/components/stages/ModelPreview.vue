<template>
  <div
    ref="hostEl"
    data-capture-wheel="true"
    tabindex="-1"
    @pointerenter="onHostEnter"
    class="ctv:relative ctv:w-full ctv:h-full ctv:min-h-[220px] ctv:overflow-hidden ctv:rounded-sm ctv:bg-black ctv:touch-none ctv:outline-none"
  >
    <div
      v-if="loading || loadError"
      class="ctv:absolute ctv:inset-0 ctv:flex ctv:flex-col ctv:items-center ctv:justify-center ctv:gap-1.5
             ctv:text-white/50 ctv:pointer-events-none"
    >
      <i :class="['pi', loadError ? 'pi-exclamation-triangle' : 'pi-box', 'ctv:text-[28px] ctv:opacity-60']" />
      <div class="ctv:text-2xs ctv:text-center ctv:px-3">
        {{ loadError ? $t('modelPreview.loadFailed') : $t('modelPreview.loading') }}
      </div>
    </div>
    <div v-if="!loading && !loadError && (clipNames.length || boneNames.length)"
      class="ctv:absolute ctv:bottom-2 ctv:left-2 ctv:right-2 ctv:z-10 ctv:bg-black/80 ctv:p-2 ctv:rounded ctv:text-xs ctv:text-white ctv:flex ctv:flex-wrap ctv:gap-2"
      @pointerdown.stop @wheel.stop>
      <template v-if="clipNames.length">
        <select v-model.number="clipIndex" aria-label="动作片段" class="ctv:bg-gray-800 ctv:max-w-40" @change="selectClip">
          <option v-for="(name, index) in clipNames" :key="index" :value="index">{{ name }}</option>
        </select>
        <button @click="playing = !playing">{{ playing ? '暂停动作' : '播放动作' }}</button>
        <input aria-label="动作进度" type="range" min="0" :max="duration" step="0.01" :value="playhead" @input="seek" class="ctv:w-28" />
        <span>{{ playhead.toFixed(2) }} / {{ duration.toFixed(2) }} 秒</span>
      </template>
      <template v-if="boneNames.length">
        <label><input v-model="showSkeleton" type="checkbox" /> 骨架（{{ boneNames.length }}）</label>
        <select v-model="weightBone" aria-label="骨骼权重" class="ctv:bg-gray-800 ctv:max-w-44" @change="applyWeights">
          <option value="">材质显示</option>
          <option v-for="name in boneNames" :key="name" :value="name">{{ name }}</option>
        </select>
        <span v-if="weightBone">权重：蓝 0 → 红 1</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'

import {
  fetchModelBytes,
  urlFilename,
  useModelPreview,
  type ModelStats,
} from '@/composables/stages/useModelPreview'
import { buildPointCloud, classifyModelBytes, loadSpark } from '@/widgets/three/modelFormats'
import { guardOrbitControlsDragEnd } from '@/widgets/three/orbitControlsGuard'
import { RendererView } from '@/widgets/three/RendererView'
import { buildPrimitiveMesh, parsePrimitiveRecipe } from '@/widgets/three/primitiveGeometry'
import { loadCustomModelAssets } from '@/widgets/three/scene3d/scene3dAssets'
import { applyViewChannel, type ViewChannel } from '@/widgets/three/channelShading'
import type { MaterialParams } from '@/widgets/material/types'

const props = defineProps<{
  src: string
  pickable?: boolean
  partMaterials?: Record<string, MaterialParams | null>
  selectedPart?: string | null
  channel?: ViewChannel
}>()

const emit = defineEmits<{
  (e: 'view-changed'): void
  (e: 'parts-changed', keys: string[]): void
  (e: 'part-pick', key: string | null): void
  (e: 'model-stats', stats: ModelStats): void
}>()

const hostEl = ref<HTMLDivElement | null>(null)

let view: RendererView | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let disposeDragGuard: (() => void) | null = null
let modelRoot: THREE.Object3D | null = null
let modelDispose: (() => void) | null = null
let sparkRenderer: THREE.Object3D | null = null
let animationId: number | null = null
let mixer: THREE.AnimationMixer | null = null
let action: THREE.AnimationAction | null = null
let clips: THREE.AnimationClip[] = []
let skeletonHelper: THREE.SkeletonHelper | null = null
let lastTick = 0
const clipNames = ref<string[]>([])
const clipIndex = ref(0)
const playing = ref(false)
const playhead = ref(0)
const duration = ref(0)
const boneNames = ref<string[]>([])
const showSkeleton = ref(false)
const weightBone = ref('')
const weightRestores: Array<() => void> = []

function selectClip(): void {
  mixer?.stopAllAction()
  const clip = clips[clipIndex.value]
  action = mixer && clip ? mixer.clipAction(clip).reset().play() : null
  duration.value = clip?.duration ?? 0
  playhead.value = 0
  playing.value = false
  mixer?.update(0)
}

function seek(event: Event): void {
  playing.value = false
  if (!action || !mixer) return
  action.time = Number((event.target as HTMLInputElement).value)
  playhead.value = action.time
  mixer.update(0)
}

function clearWeights(): void {
  for (const restore of weightRestores.splice(0)) restore()
}

function applyWeights(): void {
  clearWeights()
  if (!modelRoot || !weightBone.value) return
  modelRoot.traverse((child) => {
    if (!(child instanceof THREE.SkinnedMesh)) return
    const originalGeometry = child.geometry
    const originalMaterial = child.material
    const indices = originalGeometry.getAttribute('skinIndex')
    const weights = originalGeometry.getAttribute('skinWeight')
    if (!indices || !weights) return
    const boneIndex = child.skeleton.bones.findIndex(b => b.name === weightBone.value)
    const geometry = originalGeometry.clone()
    const colors = new Float32Array(indices.count * 3)
    const color = new THREE.Color()
    for (let v = 0; v < indices.count; v++) {
      let weight = 0
      for (let k = 0; k < indices.itemSize; k++) {
        if (indices.getComponent(v, k) === boneIndex) weight += weights.getComponent(v, k)
      }
      color.setHSL((1 - Math.min(1, weight)) * 2 / 3, 1, 0.5).toArray(colors, v * 3)
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })
    child.geometry = geometry
    child.material = material
    weightRestores.push(() => {
      child.geometry = originalGeometry
      child.material = originalMaterial
      geometry.dispose()
      material.dispose()
    })
  })
}

watch(showSkeleton, visible => { if (skeletonHelper) skeletonHelper.visible = visible })

const mp = useModelPreview(props, emit, {
  getCamera: () => camera,
  getModelRoot: () => modelRoot,
  getCanvasRect: () => view?.canvas.getBoundingClientRect() ?? null,
  renderThumbnail: (size) => {
    if (!view || !scene || !camera) return null
    const captureCamera = camera.clone()
    captureCamera.aspect = 1
    captureCamera.updateProjectionMatrix()
    return view.renderToCanvas(scene, captureCamera, size, size)
  },
})

const { loading, loadError } = mp

async function ensureSparkRenderer(): Promise<void> {
  if (sparkRenderer || !scene || !view) return
  const { SparkRenderer } = await loadSpark()
  if (sparkRenderer || !scene || !view) return
  sparkRenderer = new SparkRenderer({ renderer: view.renderer })
  scene.add(sparkRenderer)
}

function disposeModelRoot(): void {
  clearWeights()
  weightBone.value = ''
  playing.value = false
  mixer?.stopAllAction()
  if (modelRoot) mixer?.uncacheRoot(modelRoot)
  mixer = null
  action = null
  clips = []
  clipNames.value = []
  boneNames.value = []
  if (skeletonHelper) {
    scene?.remove(skeletonHelper)
    skeletonHelper.dispose()
    skeletonHelper = null
  }
  if (modelRoot && scene) scene.remove(modelRoot)
  modelRoot = null
  modelDispose?.()
  modelDispose = null
  mp.disposeParts()
}

function onHostEnter(): void {
  hostEl.value?.focus({ preventScroll: true })
}

function syncSize(): void {
  if (!view || !hostEl.value || !camera) return
  const w = hostEl.value.clientWidth || 300
  const h = hostEl.value.clientHeight || 220
  const scale = Math.min(window.devicePixelRatio || 1, 2)
  view.setSize(w * scale, h * scale)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  if (scene) view.renderScene(scene, camera)
}

function frameModel(root: THREE.Object3D): void {
  if (!camera || !controls) return
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root, true)
  const center = new THREE.Vector3()
  const size = new THREE.Vector3()
  bounds.getCenter(center)
  bounds.getSize(size)
  let maxDim = Math.max(size.x, size.y, size.z)
  if (!Number.isFinite(maxDim) || maxDim <= 0) {
    center.set(0, 0, 0)
    maxDim = 2
  }
  const dist = maxDim * 1.8
  camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.7)
  camera.near = Math.max(maxDim / 1000, 0.001)
  camera.far = Math.max(maxDim * 100, 100)
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.update()
}

interface LoadedModel {
  root: THREE.Object3D
  dispose: (() => void) | null
  clips?: THREE.AnimationClip[]
}

async function loadModelObject(url: string): Promise<LoadedModel> {
  const prim = parsePrimitiveRecipe(url)
  if (prim) {
    const group = new THREE.Group()
    group.add(buildPrimitiveMesh(prim.kind, prim.params))
    return { root: group, dispose: null }
  }

  let bytes: ArrayBuffer | null = null
  const fetchBytes = async () => (bytes ??= await fetchModelBytes(url))
  const kind = await classifyModelBytes(url, fetchBytes)

  if (kind === 'splat') {
    const [{ SplatMesh }] = await Promise.all([loadSpark(), ensureSparkRenderer()])
    const splat = new SplatMesh({
      fileBytes: await fetchBytes(),
      fileName: urlFilename(url),
    })
    await splat.initialized
    splat.quaternion.set(1, 0, 0, 0)
    const group = new THREE.Group()
    group.add(splat)
    return { root: group, dispose: () => splat.dispose() }
  }

  if (kind === 'pointcloud') {
    const group = buildPointCloud(await fetchBytes())
    return {
      root: group,
      dispose: () => {
        group.traverse((child) => {
          if (child instanceof THREE.Points) {
            child.geometry.dispose()
            const mat = child.material
            for (const m of Array.isArray(mat) ? mat : [mat]) m.dispose()
          }
        })
      },
    }
  }

  const assets = await loadCustomModelAssets(url)
  return { root: cloneSkinned(assets.template), dispose: null, clips: assets.clips }
}

async function loadModel(url: string): Promise<void> {
  const mySeq = mp.beginLoad()
  disposeModelRoot()
  if (!url) {
    loading.value = false
    loadError.value = false
    return
  }
  loading.value = true
  loadError.value = false
  try {
    const loaded = await loadModelObject(url)
    if (mp.isStale(mySeq) || !scene) {
      loaded.dispose?.()
      return
    }
    modelRoot = loaded.root
    modelDispose = loaded.dispose
    scene.add(loaded.root)
    mp.registerParts(loaded.root)
    mp.applyPartMaterials(true)
    if (props.selectedPart) mp.setHighlight(props.selectedPart)
    if ((props.channel ?? 'material') !== 'material') {
      applyViewChannel(loaded.root, props.channel as ViewChannel)
    }
    clips = loaded.clips ?? []
    clipNames.value = clips.map(c => c.name || '未命名动作')
    clipIndex.value = 0
    if (clips.length) {
      mixer = new THREE.AnimationMixer(loaded.root)
      selectClip()
    }
    const bones = new Set<string>()
    loaded.root.traverse(child => { if (child instanceof THREE.Bone) bones.add(child.name) })
    boneNames.value = [...bones]
    if (bones.size) {
      skeletonHelper = new THREE.SkeletonHelper(loaded.root)
      skeletonHelper.visible = showSkeleton.value
      for (const material of Array.isArray(skeletonHelper.material) ? skeletonHelper.material : [skeletonHelper.material]) material.depthTest = false
      skeletonHelper.renderOrder = 1000
      scene.add(skeletonHelper)
    }
    frameModel(loaded.root)
    loading.value = false
    emit('view-changed')
    mp.scheduleThumbnailPersist(url)
  } catch (e) {
    console.error('[ComfyTV/ModelPreview] failed to load model', url, e)
    if (mp.isStale(mySeq)) return
    loading.value = false
    loadError.value = true
  }
}

function animate(): void {
  animationId = requestAnimationFrame(animate)
  if (!view || !scene || !camera) return
  const now = performance.now()
  const delta = Math.min((now - lastTick) / 1000, 0.1)
  lastTick = now
  if (playing.value && mixer && action) {
    mixer.update(delta)
    playhead.value = action.time
  }
  controls?.update()
  view.renderScene(scene, camera)
}

onMounted(() => {
  if (!hostEl.value) return

  scene = new THREE.Scene()
  scene.add(new THREE.AmbientLight(0xffffff, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 1.4)
  key.position.set(3, 5, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.5)
  fill.position.set(-4, 2, -3)
  scene.add(fill)

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000)
  camera.position.set(2, 1.5, 2)

  view = new RendererView(hostEl.value)
  view.state.clearColor = new THREE.Color(0x141418)
  view.state.clearAlpha = 1

  controls = new OrbitControls(camera, view.canvas)
  controls.enableDamping = true
  disposeDragGuard = guardOrbitControlsDragEnd(controls, view.canvas)
  controls.addEventListener('end', () => emit('view-changed'))

  view.canvas.addEventListener('pointerdown', mp.onPickDown)
  view.canvas.addEventListener('pointerup', mp.onPickUp)

  syncSize()
  view.observeResize(hostEl.value, syncSize)
  animate()

  void loadModel(props.src)
})

watch(() => props.src, (url) => { void loadModel(url || '') })

watch(() => props.channel, (ch) => {
  if (!modelRoot) return
  clearWeights()
  weightBone.value = ''
  mp.clearHighlight()
  applyViewChannel(modelRoot, (ch ?? 'material') as ViewChannel)
  if ((ch ?? 'material') === 'material') {
    mp.applyPartMaterials(true)
    if (props.selectedPart) mp.setHighlight(props.selectedPart)
  }
  emit('view-changed')
})

onBeforeUnmount(() => {
  mp.teardown()
  if (animationId != null) cancelAnimationFrame(animationId)
  animationId = null
  view?.canvas.removeEventListener('pointerdown', mp.onPickDown)
  view?.canvas.removeEventListener('pointerup', mp.onPickUp)
  disposeDragGuard?.()
  disposeDragGuard = null
  controls?.dispose()
  controls = null
  disposeModelRoot()
  if (sparkRenderer) {
    scene?.remove(sparkRenderer)
    ;(sparkRenderer as unknown as { dispose?: () => void }).dispose?.()
    sparkRenderer = null
  }
  view?.dispose()
  view = null
  scene = null
  camera = null
})

defineExpose({
  cameraState(): { position: number[]; target: number[]; fov: number } | null {
    if (!camera || !controls) return null
    return {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
    }
  },
  captureCanvas(width: number, height: number): HTMLCanvasElement | null {
    if (!view || !scene || !camera) return null
    const captureCamera = camera.clone()
    captureCamera.aspect = width / height
    captureCamera.updateProjectionMatrix()
    const restoreHighlight = mp.suspendHighlight()
    try {
      return view.renderToCanvas(scene, captureCamera, width, height)
    } finally {
      restoreHighlight()
    }
  },
})
</script>
