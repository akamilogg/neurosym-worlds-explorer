# particles3d@1's viewer (SPEC-MUNDO-3D §4): the trajectories of an episode, as Blender did them and as the learner's law
# answers them, in one .blend file, for a person to look at. System 2 never sees it.
#
#   blender -b --factory-startup --python lib/blender/view_trajectories.py -- <trajectories.json> <out.blend>
#
# trajectories.json: {"markers": {"<name>": [x, y, z]}, "real": {"<name>": [[x, y, z] | null, ...]},
#                     "predicted": {"<name>": [[x, y, z], ...]}, "from": <frame the law starts from>}
# In Blender's coordinates. Real paths are grey, the law's are orange from the frame it starts at; markers are spheres.
import bpy, sys, json

argv = sys.argv[sys.argv.index('--') + 1:]
src, out = argv[0], argv[1]
data = json.load(open(src))

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb, 1)
    bsdf.inputs['Emission'].default_value = (*rgb, 1)
    bsdf.inputs['Emission Strength'].default_value = 1.0
    return m


REAL, LAW, MARK = material('real', (0.55, 0.55, 0.6)), material('law', (1.0, 0.45, 0.05)), material('marker', (0.2, 0.5, 1.0))


def path(name, points, mat, bevel):
    pts = [p for p in points if p is not None]
    if len(pts) < 2:
        return
    cu = bpy.data.curves.new(name, 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = bevel
    sp = cu.splines.new('POLY')
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (p[0], p[1], p[2], 1)
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    bpy.context.scene.collection.objects.link(ob)


for name, at in data.get('markers', {}).items():
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=at)
    bpy.context.active_object.name = 'marker ' + name
    bpy.context.active_object.data.materials.append(MARK)
for name, pts in data.get('real', {}).items():
    path('real ' + name, pts, REAL, 0.012)
for name, pts in data.get('predicted', {}).items():
    path('law ' + name, pts, LAW, 0.02)

bpy.ops.wm.save_as_mainfile(filepath=out)
print('saved', out)
