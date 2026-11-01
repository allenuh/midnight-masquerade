# Adds the Creature's Grab animation (the catch cutscene) to art/creature.blend and exports
# src/client/assets/creature.glb with both clips, Float and Grab. Developer-only, re-run by hand:
#     blender -b art/creature.blend --python art/animate_creature_grab.py
# Add `-- --dry-run` to build the action without saving the .blend or exporting.
# The rig is six rigid bones (Root, Body, Hem, Head, Arm.L, Arm.R); each sleeve and claw rides its
# arm bone. Rather than hand-tuned quaternions, every arm key is solved: the arm is turned about its
# shoulder until its claw's middle points at a target, so the targets below read as places in the
# scene. Coordinates are the Creature's own (Blender units, Z up, facing -Y, the floor of its hem at
# Z 0); the game scales it to CREATURE_HEIGHT (scene.ts), about 32.8 game units per unit.
# The catch: the Hunter stands HUNTER_DISTANCE in front (about CATCH.GRAB_DISTANCE game units, which
# the client slides the Creature to during the lunge), facing it. The claws wind up wide and high,
# then clamp on the Hunter's upper arms, squeeze with a tremble, and let go back to the rest pose.
# The clip is CLIP_FRAMES long; the client stretches it to the room's catch length. The exporter
# writes every action on the rig's NLA tracks as its own clip, with "slide animation to zero".
import math
import sys
from pathlib import Path

import bpy
from mathutils import Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
GLB = ROOT / 'src' / 'client' / 'assets' / 'creature.glb'
DRY_RUN = '--dry-run' in (sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

CLIP_FRAMES = 48
HUNTER_DISTANCE = 0.76
# Where the claws' middles go (right claw; the left mirrors X): open wide and raised for the
# wind-up, and on the Hunter's upper arms for the clamp. The Hunter is about 0.9 units wide across
# its arms, and its upper arms are about 0.95 above the Creature's floor.
OPEN = Vector((1.0, -0.15, 1.5))
CLAMP = Vector((0.56, -HUNTER_DISTANCE, 0.95))
SQUEEZE = 0.035
# How much of the body's lean the hem takes back (1: hangs straight down).
HEM_COUNTER = 0.7
# Body pitch (radians about X; positive leans forward, toward -Y) and head nod at each key, and
# the keys: (frame, body pitch, head nod, claw target or None for the rest pose).
KEYS = [
    (0, 0.0, 0.0, None),
    (5, -0.12, -0.12, OPEN),
    (9, -0.14, -0.15, OPEN + Vector((0.05, 0.05, 0.05))),
    (14, 0.32, 0.22, CLAMP),
    (18, 0.30, 0.25, CLAMP - Vector((SQUEEZE, 0, 0))),
    (22, 0.33, 0.22, CLAMP),
    (26, 0.30, 0.26, CLAMP - Vector((SQUEEZE, 0, 0.01))),
    (30, 0.33, 0.22, CLAMP),
    (34, 0.31, 0.25, CLAMP - Vector((SQUEEZE, 0, 0))),
    (38, 0.32, 0.22, CLAMP),
    (CLIP_FRAMES, 0.0, 0.0, None),
]

rig = bpy.data.objects['CreatureRig']
float_action = bpy.data.actions['Float']
bones = rig.pose.bones
CLAWS = {'Arm.L': bpy.data.objects['Claw.L'], 'Arm.R': bpy.data.objects['Claw.R']}


def rest_pose():
    """Every bone's transform on Float's first frame, so Grab starts and ends where Float does."""
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
    # A turn in world space becomes the bone's own. `frame` is the bone's posed orientation with its
    # rest rotation applied, frame = F * q_rest, and turn * F * q_rest = F * q_new gives
    # q_new = q_rest * frame^-1 * turn * frame.
    frame = rig.matrix_world.to_quaternion() @ bone.matrix.to_quaternion()
    bone.rotation_quaternion = rest_rotation @ frame.inverted() @ turn @ frame
    bpy.context.view_layer.update()
    return (claw_middle(arm) - target).length


def build():
    rest = rest_pose()
    old = bpy.data.actions.get('Grab')
    if old:
        bpy.data.actions.remove(old)
    grab = bpy.data.actions.new('Grab')
    grab.use_fake_user = True
    rig.animation_data.action = grab
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
        rig.animation_data.action = grab
        bpy.context.view_layer.update()
        # The hem hangs from the body, so a lean would swing it back like a cape: undo most of the
        # pitch on it, leaving a little trail.
        bones['Hem'].rotation_quaternion = hem @ Quaternion(Vector((1, 0, 0)), -HEM_COUNTER * pitch)
        # Body pitch is about the world X axis at the body's base; its bone's local X is world X.
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
        print('GRAB key', frame, 'pitch', pitch, 'claw miss', misses)
    # Keep Float the active action; Grab rides an NLA track so the exporter writes both.
    rig.animation_data.action = float_action
    for track in list(rig.animation_data.nla_tracks):
        if any(strip.action == grab for strip in track.strips) or track.name == 'Grab':
            rig.animation_data.nla_tracks.remove(track)
    track = rig.animation_data.nla_tracks.new()
    track.name = 'Grab'
    track.strips.new('Grab', 0, grab)
    track.mute = True
    return grab


build()
if not DRY_RUN:
    bpy.ops.wm.save_mainfile()
    bpy.ops.export_scene.gltf(
        filepath=str(GLB), export_format='GLB', use_selection=False, export_animations=True,
        export_animation_mode='ACTIONS', export_anim_slide_to_zero=True,
    )
    print('GRAB exported', GLB)
