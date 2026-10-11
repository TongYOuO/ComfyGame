import { screen, waitFor, fireEvent } from '@testing-library/vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { renderWithPlugins } from '@/__tests__/renderHelpers'

const h = vi.hoisted(() => ({
  classifyModelBytes: vi.fn(),
  buildPointCloud: vi.fn(),
  loadSpark: vi.fn(),
  loadCustomModelAssets: vi.fn(),
  persistModelThumbnail: vi.fn(),
  guard: vi.fn(),
  guardDispose: vi.fn(),
  viewInstances: [] as any[],
  controlsInstances: [] as any[],
}))

vi.mock('@/widgets/three/modelFormats', () => ({
  classifyModelBytes: h.classifyModelBytes,
  buildPointCloud: h.buildPointCloud,
  loadSpark: h.loadSpark,
}))

vi.mock('@/widgets/three/scene3d/scene3dAssets', () => ({
  loadCustomModelAssets: h.loadCustomModelAssets,
}))

vi.mock('@/api/nativeAssets', () => ({
  persistModelThumbnail: h.persistModelThumbnail,
}))

vi.mock('@/widgets/three/orbitControlsGuard', () => ({
  guardOrbitControlsDragEnd: h.guard,
}))

vi.mock('three/examples/jsm/utils/SkeletonUtils.js', () => ({
  clone: (obj: unknown) => obj,
}))

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  class OrbitControls {
    enableDamping = false
    target = { copy: vi.fn() }
    listeners: Record<string, Array<() => void>> = {}
    update = vi.fn()
    dispose = vi.fn()
    addEventListener = (ev: string, fn: () => void) => {
      ;(this.listeners[ev] ??= []).push(fn)
    }
    constructor(
      public camera: unknown,
      public element: unknown,
    ) {
      h.controlsInstances.push(this)
    }
  }
  return { OrbitControls }
})

vi.mock('@/widgets/three/RendererView', () => {
  class RendererView {
    canvas = document.createElement('canvas')
    state: Record<string, unknown> = {}
    renderer = { __shared: true }
    setSize = vi.fn()
    renderScene = vi.fn()
    observeResize = vi.fn()
    dispose = vi.fn()
    renderToCanvas = vi.fn(() => {
      const c = document.createElement('canvas')
      ;(c as any).toBlob = (cb: (b: Blob | null) => void) => cb(new Blob(['png']))
      return c
    })
    constructor(container: HTMLElement) {
      container.appendChild(this.canvas)
      h.viewInstances.push(this)
    }
  }
  return { RendererView }
})

import ModelPreview from './ModelPreview.vue'

class MockSplatMesh extends THREE.Object3D {
  static instances: MockSplatMesh[] = []
  initialized = Promise.resolve()
  quaternionSet: number[] | null = null
  dispose = vi.fn()
  constructor(public opts: { fileBytes: ArrayBuffer; fileName: string }) {
    super()
    MockSplatMesh.instances.push(this)
  }
}

class MockSparkRenderer extends THREE.Object3D {
  static instances: MockSparkRenderer[] = []
  constructor(public opts: { renderer: unknown }) {
    super()
    MockSparkRenderer.instances.push(this)
  }
}

function renderPreview(src: string) {
  return renderWithPlugins(ModelPreview, { props: { src } })
}

async function waitForViewChanged(emitted: () => Record<string, unknown[]>) {
  await waitFor(() => expect(emitted()['view-changed']).toBeTruthy())
}

beforeEach(() => {
  h.classifyModelBytes.mockReset().mockResolvedValue('mesh')
  h.buildPointCloud.mockReset()
  h.loadSpark.mockReset().mockResolvedValue({
    SplatMesh: MockSplatMesh,
    SparkRenderer: MockSparkRenderer,
  })
  h.loadCustomModelAssets.mockReset().mockResolvedValue({ template: new THREE.Group(), clips: [] })
  h.persistModelThumbnail.mockReset().mockResolvedValue(undefined)
  h.guard.mockReset().mockReturnValue(h.guardDispose)
  h.guardDispose.mockReset()
  h.viewInstances.length = 0
  h.controlsInstances.length = 0
  MockSplatMesh.instances.length = 0
  MockSparkRenderer.instances.length = 0
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('ModelPreview', () => {
  it('loads a mesh, emits view-changed and hides the loading overlay', async () => {
    const { emitted } = renderPreview('/view?filename=a.glb&subfolder=3d&type=input')
    await waitForViewChanged(() => emitted())
    expect(h.loadCustomModelAssets).toHaveBeenCalledWith('/view?filename=a.glb&subfolder=3d&type=input')
    expect(screen.queryByText('Loading model…')).toBeNull()
    expect(screen.queryByText('Failed to load model')).toBeNull()
  })

  it('re-emits view-changed when an orbit interaction ends', async () => {
    const { emitted } = renderPreview('/view?filename=a.glb')
    await waitForViewChanged(() => emitted())
    const controls = h.controlsInstances[0]
    controls.listeners['end'][0]()
    expect(emitted()['view-changed']).toHaveLength(2)
  })

  it('persists a thumbnail snapshot after the settle delay', async () => {
    vi.useFakeTimers()
    renderPreview('/view?filename=a.glb')
    await vi.advanceTimersByTimeAsync(50)
    expect(h.persistModelThumbnail).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(700)
    expect(h.persistModelThumbnail).toHaveBeenCalledTimes(1)
    const [url, blob] = h.persistModelThumbnail.mock.calls[0]
    expect(url).toBe('/view?filename=a.glb')
    expect(blob).toBeInstanceOf(Blob)
    expect(h.viewInstances[0].renderToCanvas).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 256, 256,
    )
  })

  it('shows the failure overlay when loading throws', async () => {
    h.loadCustomModelAssets.mockRejectedValue(new Error('404'))
    renderPreview('/view?filename=broken.glb')
    expect(await screen.findByText('Failed to load model')).toBeInTheDocument()
  })

  it('renders nothing but the viewport for an empty src', async () => {
    renderPreview('')
    await waitFor(() => expect(screen.queryByText('Loading model…')).toBeNull())
    expect(h.classifyModelBytes).not.toHaveBeenCalled()
  })

  it('splat path: lazy-loads spark, adds a SparkRenderer, flips the quaternion', async () => {
    h.classifyModelBytes.mockResolvedValue('splat')
    const { emitted, unmount } = renderPreview('/view?filename=a.splat')
    await waitForViewChanged(() => emitted())

    expect(MockSparkRenderer.instances).toHaveLength(1)
    expect(MockSparkRenderer.instances[0].opts.renderer).toBe(h.viewInstances[0].renderer)
    const splat = MockSplatMesh.instances[0]
    expect(splat.opts.fileName).toBe('a.splat')
    expect(splat.quaternion.w).toBe(0)
    expect(splat.quaternion.x).toBe(1)

    unmount()
    expect(splat.dispose).toHaveBeenCalled()
  })

  it('point-cloud path: builds Points and disposes their resources on unmount', async () => {
    h.classifyModelBytes.mockResolvedValue('pointcloud')
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3))
    const material = new THREE.PointsMaterial()
    const group = new THREE.Group()
    group.add(new THREE.Points(geometry, material))
    h.buildPointCloud.mockReturnValue(group)
    const geoDispose = vi.spyOn(geometry, 'dispose')
    const matDispose = vi.spyOn(material, 'dispose')

    const { emitted, unmount } = renderPreview('/view?filename=cloud.ply')
    await waitForViewChanged(() => emitted())
    expect(h.buildPointCloud).toHaveBeenCalled()

    unmount()
    expect(geoDispose).toHaveBeenCalled()
    expect(matDispose).toHaveBeenCalled()
  })

  it('tears down the renderer view, controls and drag guard on unmount', async () => {
    const { emitted, unmount } = renderPreview('/view?filename=a.glb')
    await waitForViewChanged(() => emitted())
    unmount()
    expect(h.viewInstances[0].dispose).toHaveBeenCalled()
    expect(h.controlsInstances[0].dispose).toHaveBeenCalled()
    expect(h.guardDispose).toHaveBeenCalled()
  })
})


it('plays and seeks embedded clips and restores shared mesh data after weight inspection', async () => {
  const root = new THREE.Group()
  const bone = new THREE.Bone()
  bone.name = 'Hip'
  root.add(bone)
  const geometry = new THREE.BoxGeometry()
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  const weights = new Float32Array(count * 4)
  for (let v = 0; v < count; v++) weights[v * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.SkinnedMesh(geometry, material)
  mesh.bind(new THREE.Skeleton([bone]))
  root.add(mesh)
  const clip = new THREE.AnimationClip('步行', 2, [new THREE.NumberKeyframeTrack('Hip.position[x]', [0, 2], [0, 2])])
  h.loadCustomModelAssets.mockResolvedValue({ template: root, clips: [clip] })
  const { unmount } = renderPreview('/view?filename=animated.glb')
  await screen.findByRole('button', { name: '播放动作' })
  await fireEvent.input(screen.getByRole('slider', { name: '动作进度' }), { target: { value: '1' } })
  expect(bone.position.x).toBeCloseTo(1)
  await fireEvent.click(screen.getByRole('button', { name: '播放动作' }))
  expect(screen.getByRole('button', { name: '暂停动作' })).toBeInTheDocument()
  await fireEvent.update(screen.getByRole('combobox', { name: '骨骼权重' }), 'Hip')
  expect(mesh.geometry).not.toBe(geometry)
  expect(mesh.geometry.getAttribute('color').getX(0)).toBeCloseTo(1)
  await fireEvent.update(screen.getByRole('combobox', { name: '骨骼权重' }), '')
  expect(mesh.geometry).toBe(geometry)
  expect(mesh.material).toBe(material)
  unmount()
})


it('frames the current skin pose instead of a cached rest-pose box', async () => {
  const root = new THREE.Group()
  const bone = new THREE.Bone()
  bone.name = 'Hip'
  root.add(bone)
  const geometry = new THREE.BoxGeometry()
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4))
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) weights[i * 4] = 1
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
  root.add(mesh)
  mesh.bind(new THREE.Skeleton([bone]))
  mesh.computeBoundingBox()
  const clip = new THREE.AnimationClip('pose', 1, [new THREE.NumberKeyframeTrack('Hip.position[x]', [0, 1], [2, 2])])
  h.loadCustomModelAssets.mockResolvedValue({ template: root, clips: [clip] })
  const { emitted, unmount } = renderPreview('/view?filename=posed.glb')
  await waitForViewChanged(() => emitted())
  const center = h.controlsInstances[0].target.copy.mock.calls[0][0]
  expect(center.x).toBeCloseTo(2)
  expect(center.y).toBeCloseTo(0)
  unmount()
})
