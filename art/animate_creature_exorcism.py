# Adds the Creature's Exorcism animation (the cutscene when its HP reaches zero) to art/creature.blend
# and exports src/client/assets/creature.glb with every clip: Float, Grab and Exorcism. Developer-only,
# re-run by hand:
#     blender -b art/creature.blend --python art/animate_creature_exorcism.py
# Add `-- --dry-run` to build the action without saving the .blend or exporting.
# It works like art/animate_creature_grab.py: every arm key is solved, so the targets below read as
# places in the scene. Coordinates are the Creature's own (Blender units, Z up, facing -Y, the floor of
# its hem at Z 0, about 32.8 game units per unit).
# The body language: it flinches inward from the flames, then throws its arms up and its head back and
# holds there trembling, reaching a little higher, as it burns away. The game's camera looks steeply
# down and the server turns the Creature to face it, so "back" (+Y) runs up the screen: the arms reach
# back as well as up, which is what draws them above the head on screen, and the head tipped back
# turns the skull's face to the camera. The clip never returns to rest: the Creature is gone by its
# end. The client stretches it over the first part of the cutscene (EXORCISM in exorcism.ts).
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
GLB = ROOT / 'src' / 'client' / 'assets' / 'creature.glb'
DRY_RUN = '--dry-run' in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

CLIP_FRAMES = 80
# Where the claws' middles go (right claw; the left mirrors X): tucked in front of the chest for the
# flinch, and flung up, wide and back for the rest of it.
FLINCH = Vector((0.38, -0.5, 1.0))
UP = Vector((0.85, 1.3, 2.2))
# How much higher it has climbed by the last key, and how far each tremble shakes the claws.
CLIMB = Vector((0.02, 0.14, 0.12))
TREMBLE = 0.035
# How much of the body's lean the hem takes back (1: hangs straight down).
HEM_COUNTER = 0.7
# Body pitch (radians about X; positive leans forward, toward -Y) and head nod (negative looks up).
FLINCH_PITCH, FLINCH_NOD = 0.2, 0.3
ARCH_PITCH, ARCH_NOD = -0.3, -0.62
TREMBLE_FROM = 26
TREMBLE_EVERY = 3

# (frame, body pitch, head nod, claw target or None for the rest pose).
KEYS = [
    (0, 0.0, 0.0, None),
    (9, FLINCH_PITCH, FLINCH_NOD, FLINCH),
    (14, FLINCH_PITCH * 1.15, FLINCH_NOD * 1.15, FLINCH + Vector((-0.02, 0.0, -0.03))),
    (21, ARCH_PITCH * 1.15, ARCH_NOD * 1.1, UP + Vector((0.06, 0.04, 0.06))),
]
for index, frame in enumerate(range(TREMBLE_FROM, CLIP_FRAMES + 1, TREMBLE_EVERY)):
    climb = (frame - TREMBLE_FROM) / (CLIP_FRAMES - TREMBLE_FROM)
    side = 1 if index % 2 == 0 else -1
    KEYS.append((
        frame, ARCH_PITCH - 0.03 * side, ARCH_NOD + 0.04 * side,
        UP + CLIMB * climb + Vector((TREMBLE * side, -TREMBLE * side * 0.5, TREMBLE * side * 0.7)),
    ))
if KEYS[-1][0] != CLIP_FRAMES:
    KEYS.append((CLIP_FRAMES, ARCH_PITCH, ARCH_NOD, UP + CLIMB))

rig = bpy.data.objects['CreatureRig']
float_action = bpy.data.actions['Float']
bones = rig.pose.bones
CLAWS = {'Arm.L': bpy.data.objects['Claw.L'], 'Arm.R': bpy.data.objects['Claw.R']}


def rest_pose():
    """Every bone's transform on Float's first frame, so Exorcism starts where Float does."""
    rig.animation_data.action = float_action
    bpy.context.scene.frame_set(0)
    return {b.name: (b.location.copy(), b.rotation_quaternion.copy(), b.scale.copy()) for b in bones}


def claw_middle(arm):
    claw = CLAWS[arm]
    corners = [claw.matrix_world @ Vector(c) for c in claw.bound_box]
    return sum(corners, Vector()) / 8


def aim_arm(arm, target, rest_rotation):
    """Turns the arm about its shoulder so its claw's middle points at `target` (armature space)."""
    bone = bones[arm]
    bone.rotation_quaternion = rest_rotation
    bpy.context.view_layer.update()
    shoulder = rig.matrix_world @ bone.head
    turn = (claw_middle(arm) - shoulder).rotation_difference(target - shoulder)
    # As in animate_creature_grab.py: a turn in world space becomes the bone's own.
    frame = rig.matrix_world.to_quaternion() @ bone.matrix.to_quaternion()
    bone.rotation_quaternion = rest_rotation @ frame.inverted() @ turn @ frame
    bpy.context.view_layer.update()
    return (claw_middle(arm) - target).length


def build():
    rest = rest_pose()
    old = bpy.data.actions.get('Exorcism')
    if old:
        bpy.data.actions.remove(old)
    action = bpy.data.actions.new('Exorcism')
    action.use_fake_user = True
    rig.animation_data.action = action
    bpy.context.scene.frame_set(0)
    for frame, pitch, nod, target in KEYS:
        for name, (location, rotation, scale) in rest.items():
            bones[name].location, bones[name].rotation_quaternion, bones[name].scale = location, rotation, scale
        # The hem keeps swaying as in Float, so the robe never freezes.
        rig.animation_data.action = float_action
        bpy.context.scene.frame_set(frame % (int(float_action.frame_range[1]) or 1))
        hem = bones['Hem'].rotation_quaternion.copy()
        # Switching the action re-evaluates it on the next update, which would overwrite whatever
        # is posed before then: switch and settle first, then pose.
        rig.animation_data.action = action
        bpy.context.view_layer.update()
        bones['Hem'].rotation_quaternion = hem @ Quaternion(Vector((1, 0, 0)), -HEM_COUNTER * pitch)
        bones['Body'].rotation_quaternion = rest['Body'][1] @ Quaternion(Vector((1, 0, 0)), pitch)
        bones['Head'].rotation_quaternion = rest['Head'][1] @ Quaternion(Vector((1, 0, 0)), nod)
        bpy.context.view_layer.update()
        misses = []
        if target is not None:
            for arm, side in (('Arm.R', -1), ('Arm.L', 1)):
                point = Vector((side * abs(target.x), target.y, target.z))
                misses.append(round(aim_arm(arm, point, rest[arm][1]), 3))
        for bone in bones:
            for path in ('location', 'rotation_quaternion', 'scale'):
                bone.keyframe_insert(path, frame=frame)
        print('EXORCISM key', frame, 'pitch', round(pitch, 3), 'claw miss', misses)
    # Keep Float the active action; Exorcism rides an NLA track so the exporter writes it too.
    rig.animation_data.action = float_action
    for track in list(rig.animation_data.nla_tracks):
        if any(strip.action == action for strip in track.strips) or track.name == 'Exorcism':
            rig.animation_data.nla_tracks.remove(track)
    track = rig.animation_data.nla_tracks.new()
    track.name = 'Exorcism'
    track.strips.new('Exorcism', 0, action)
    track.mute = True
    return action


build()
if not DRY_RUN:
    bpy.ops.wm.save_mainfile()
    bpy.ops.export_scene.gltf(
        filepath=str(GLB), export_format='GLB', use_selection=False, export_animations=True,
        export_animation_mode='ACTIONS', export_anim_slide_to_zero=True,
    )
    print('EXORCISM exported', GLB)
