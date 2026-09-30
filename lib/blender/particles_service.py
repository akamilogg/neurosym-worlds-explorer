# particles3d@1's environment: Blender, as a service (SPEC-MUNDO-3D §4).
#
#   blender -b --factory-startup --python lib/blender/particles_service.py -- --port 18500
#
# A persistent headless Blender that answers over HTTP, on 127.0.0.1 only. It keeps no state: every request describes a
# whole scene - the engine's settings, force fields, particles - and Blender simulates it with its own particle system
# (one single-vertex emitter per particle, so each starts exactly where and how it is asked). The answer is what Blender
# did: the position of every particle at every frame. Nothing here computes a law; the harness never sees Blender's.
#
#   GET  /health
#   POST /simulate  {"scene": {engine, fields, particles}, "frames": N, "bound": B}  ->  {"rows": [[[x, y, z] | null, ...], ...]}
#
# A particle further than `bound` from the origin has left the scene: it is null from then on.
#
# The request's Idempotency-Key header is accepted and ignored: the same scene gives the same answer.
import bpy, sys, json, math
from http.server import BaseHTTPRequestHandler, HTTPServer

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PORT = int(argv[argv.index('--port') + 1]) if '--port' in argv else 18500
MAX_FRAMES = 400
MAX_PARTICLES = 24
FIELDS = {'FORCE', 'HARMONIC', 'VORTEX', 'MAGNET', 'CHARGE', 'LENNARDJ', 'DRAG', 'TURBULENCE', 'TEXTURE', 'WIND'}
FALLOFFS = {'SPHERE', 'TUBE', 'CONE'}
INTEGRATORS = {'EULER', 'VERLET', 'MIDPOINT', 'RK4'}
TEXTURES = {'CLOUDS', 'VORONOI', 'MARBLE', 'WOOD', 'STUCCI'}


def clear():
    """Nothing of the previous request survives."""
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.particles, bpy.data.textures):
        for d in list(coll):
            coll.remove(d)


def num(d, k, default, lo=None, hi=None):
    v = d.get(k, default)
    if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
        raise ValueError('%s must be a number' % k)
    if (lo is not None and v < lo) or (hi is not None and v > hi):
        raise ValueError('%s out of range' % k)
    return float(v)


def vec(d, k, default=(0.0, 0.0, 0.0)):
    v = d.get(k, list(default))
    if not isinstance(v, list) or len(v) != 3:
        raise ValueError('%s must be [x, y, z]' % k)
    return tuple(num({'v': x}, 'v', 0.0) for x in v)


def add_field(i, f, scene):
    kind = f.get('type')
    if kind not in FIELDS:
        raise ValueError('unknown field type %r' % kind)
    bpy.ops.object.effector_add(type=kind, location=vec(f, 'location'), rotation=vec(f, 'rotation'))
    ob = bpy.context.active_object
    ob.name = 'F%d' % i
    fd = ob.field
    fd.strength = num(f, 'strength', 1.0, -1e4, 1e4)
    fd.flow = num(f, 'flow', 0.0, -1e3, 1e3)
    shape = f.get('shape')
    if shape in ('POINT', 'LINE', 'PLANE'):
        fd.shape = shape
    falloff = f.get('falloff')
    if falloff:
        if falloff.get('type', 'SPHERE') not in FALLOFFS:
            raise ValueError('unknown falloff')
        fd.falloff_type = falloff.get('type', 'SPHERE')
        fd.falloff_power = num(falloff, 'power', 0.0, 0.0, 10.0)
        if 'min' in falloff:
            fd.use_min_distance = True
            fd.distance_min = num(falloff, 'min', 0.0, 0.0, 1e3)
        if 'max' in falloff:
            fd.use_max_distance = True
            fd.distance_max = num(falloff, 'max', 0.0, 0.0, 1e3)
    if kind == 'DRAG':
        fd.linear_drag = num(f, 'linear', 0.0, -10.0, 10.0)
        fd.quadratic_drag = num(f, 'quadratic', 0.0, -10.0, 10.0)
    if kind == 'TURBULENCE':
        fd.size = num(f, 'size', 1.0, 0.01, 1e3)
        fd.noise = num(f, 'noise', 0.0, 0.0, 10.0)
        fd.seed = int(num(f, 'seed', 1, 1, 128))
        fd.use_global_coords = True
    if kind == 'TEXTURE':
        tex = bpy.data.textures.new('T%d' % i, type=f.get('texture', 'CLOUDS') if f.get('texture', 'CLOUDS') in TEXTURES else 'CLOUDS')
        tex.noise_scale = num(f, 'scale', 1.0, 0.01, 1e3)
        fd.texture = tex
        fd.texture_mode = 'GRADIENT'
        fd.texture_nabla = num(f, 'nabla', 0.025, 0.0001, 1.0)
        fd.use_2d_force = False


def add_particle(i, p, engine, frames, scene):
    me = bpy.data.meshes.new('P%d' % i)
    me.from_pydata([(0.0, 0.0, 0.0)], [], [])
    ob = bpy.data.objects.new('P%d' % i, me)
    ob.location = vec(p, 'location')
    scene.collection.objects.link(ob)
    mod = ob.modifiers.new('ps', 'PARTICLE_SYSTEM')
    ps = mod.particle_system.settings
    born = int(num(p, 'born', 1, 1, frames))
    ps.count = 1
    ps.frame_start = born
    ps.frame_end = born
    ps.lifetime = frames + 10
    ps.emit_from = 'VERT'
    ps.use_emit_random = False
    ps.normal_factor = 0.0
    ps.object_align_factor = vec(p, 'velocity')
    ps.physics_type = 'NEWTON'
    ps.mass = num(p, 'mass', 1.0, 0.001, 1e3)
    ps.use_multiply_size_mass = False
    ps.integrator = engine['integrator']
    ps.subframes = engine['subframes']
    ps.timestep = engine['timestep']
    ps.use_adaptive_subframes = False
    ps.damping = engine['damping']
    ps.drag_factor = engine['drag']
    ps.brownian_factor = 0.0
    ps.effector_weights.gravity = 0.0
    ps.render_type = 'HALO'
    own = p.get('field')
    if own:
        kind = own.get('type')
        if kind not in ('CHARGE', 'LENNARDJ'):
            raise ValueError('a particle field is CHARGE or LENNARDJ')
        ps.force_field_1.type = kind
        ps.force_field_1.strength = num(own, 'strength', 1.0, -1e3, 1e3)
    mod.particle_system.point_cache.frame_end = frames
    return ob


def simulate(body):
    scene_d = body.get('scene') or {}
    frames = int(num(body, 'frames', 60, 2, MAX_FRAMES))
    bound = num(body, 'bound', 1e9, 1e-3, 1e12)
    e = scene_d.get('engine') or {}
    engine = {
        'integrator': e.get('integrator', 'RK4') if e.get('integrator', 'RK4') in INTEGRATORS else 'RK4',
        'subframes': int(num(e, 'subframes', 2, 0, 20)),
        'timestep': num(e, 'timestep', 0.04, 0.001, 1.0),
        'damping': num(e, 'damping', 0.0, 0.0, 1.0),
        'drag': num(e, 'drag', 0.0, 0.0, 1.0),
    }
    particles = scene_d.get('particles') or []
    if not (1 <= len(particles) <= MAX_PARTICLES):
        raise ValueError('1 to %d particles' % MAX_PARTICLES)
    clear()
    scene = bpy.context.scene
    scene.use_gravity = False
    scene.gravity = (0.0, 0.0, 0.0)
    scene.frame_start, scene.frame_end = 1, frames
    for i, f in enumerate(scene_d.get('fields') or []):
        add_field(i, f, scene)
    obs = [add_particle(i, p, engine, frames, scene) for i, p in enumerate(particles)]
    rows = []
    gone = set()
    for f in range(1, frames + 1):
        scene.frame_set(f)
        dg = bpy.context.evaluated_depsgraph_get()
        row = []
        for k, ob in enumerate(obs):
            ps = ob.evaluated_get(dg).particle_systems[0].particles
            p = list(ps[0].location) if len(ps) and ps[0].alive_state == 'ALIVE' else None
            # A particle that left the scene (or that the engine's numbers overflowed) is gone from then on.
            if p is not None and (k in gone or not all(math.isfinite(v) for v in p) or math.sqrt(sum(v * v for v in p)) > bound):
                gone.add(k)
                p = None
            row.append([round(v, 9) for v in p] if p is not None else None)
        rows.append(row)
    return {'rows': rows}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        data = json.dumps(obj, allow_nan=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            return self._send(200, {'ok': True, 'blender': bpy.app.version_string})
        self._send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/simulate':
            return self._send(404, {'error': 'not found'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            body = json.loads(self.rfile.read(n) or b'{}')
            self._send(200, simulate(body))
        except (ValueError, TypeError, KeyError) as err:
            self._send(400, {'error': str(err)})

    def log_message(self, *args):
        pass


print('particles3d service: Blender %s on http://127.0.0.1:%d' % (bpy.app.version_string, PORT), flush=True)
HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
