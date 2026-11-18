import { declarationEdits } from '../schema/patch.ts';

export const animationTypes = {
  'bp/animations': [
    'AnimationDocument', 'Animation', 'AnimationBone', 'AnimationChannel', 'AnimationKeyframe',
    'AnimationRotation', 'AnimationAxisRotation', 'AnimationRelativeTo', 'AnimationParticleEffect', 'AnimationSoundEffect', 'AnimationTimeline',
  ],
  'bp/animation_controllers': [
    'AnimationControllerDocument', 'AnimationController', 'AnimationControllerState',
    'AnimationControllerVariable', 'AnimationBlendTransition', 'AnimationRemapCurve',
  ],
} as const;

/** Correct native animation declarations while retaining upstream fields and documentation. */
export function normalizeAnimations(text: string, controller: boolean): string {
  const { members, replace, finish } = declarationEdits(text);

  let names: Record<string, string>;
  let imports: string;
  let extra = '';

  if (controller) {
    const prefix = 'ActorAnimationControllerAnimationControllersStates';

    members(prefix, {
      animations: 'ConditionalReference[]',
      transitions: 'ConditionalReference[]',
      particle_effects: '(string | AnimationParticleEffect)[]',
      sound_effects: '(string | AnimationSoundEffect)[]',
    });
    members(prefix + 'Variables', { input: 'MolangExpression' });
    replace(prefix + 'BlendTransition', `export type ${prefix}BlendTransition = number | Record<string, number>;`);
    replace(prefix + 'VariablesRemapCurve', `export type ${prefix}VariablesRemapCurve = Record<string, number>;`);

    for (const suffix of ['Animations', 'Transitions', 'ParticleEffects', 'SoundEffects']) {
      replace(prefix + suffix, '');
    }

    names = {
      ActorAnimationController: 'AnimationControllerDocument',
      ActorAnimationControllerAnimationControllers: 'AnimationController',
      [prefix]: 'AnimationControllerState',
      [prefix + 'BlendTransition']: 'AnimationBlendTransition',
      [prefix + 'Variables']: 'AnimationControllerVariable',
      [prefix + 'VariablesRemapCurve']: 'AnimationRemapCurve',
    };
    imports = 'import type { MolangExpression, ConditionalReference } from \'../common/index\';\n'
      + 'import type { AnimationParticleEffect, AnimationSoundEffect } from \'./document\';\n';
  } else {
    const prefix = 'ActorAnimationAnimations';

    members(prefix, {
      loop: 'boolean | \'hold_on_last_frame\'',
      loopLessThanhold_on_last_frame: null,
      start_delay: 'MolangExpression', loop_delay: 'MolangExpression',
      anim_time_update: 'MolangExpression', blend_weight: 'MolangExpression',
      animation_length: 'number',
      particle_effects: 'Record<string, AnimationParticleEffect | AnimationParticleEffect[]>',
      sound_effects: 'Record<string, AnimationSoundEffect | AnimationSoundEffect[]>',
    });
    members(prefix + 'Bones', { position: 'AnimationChannel', rotation: 'AnimationRotation', scale: 'AnimationChannel' });
    members(prefix + 'BonesRelativeTo', { rotationLessThanentity: null, rotation: '\'entity\'' });
    members(prefix + 'BonesPosition', { lerp_modeLessThanlinearcatmullrom: null, lerp_mode: '\'linear\' | \'catmullrom\'', pre: 'MolangVector3', post: 'MolangVector3' });
    members(prefix + 'ParticleEffects', { pre_effect_script: 'MolangExpression' });
    replace(prefix + 'BonesRotation', '');
    replace(prefix + 'BonesScale', '');
    replace(prefix + 'Timeline', `export type ${prefix}Timeline = string | string[];`);
    names = {
      ActorAnimation: 'AnimationDocument',
      [prefix]: 'Animation',
      [prefix + 'Bones']: 'AnimationBone',
      [prefix + 'BonesRelativeTo']: 'AnimationRelativeTo',
      [prefix + 'BonesPosition']: 'AnimationKeyframe',
      [prefix + 'ParticleEffects']: 'AnimationParticleEffect',
      [prefix + 'SoundEffects']: 'AnimationSoundEffect',
      [prefix + 'Timeline']: 'AnimationTimeline',
    };
    imports = 'import type { MolangExpression, MolangVector3 } from \'../common/index\';\n';
    extra = '\n/** A constant transform or timestamped scalar, vector and interpolated keyframes. */\n'
      + 'export type AnimationChannel = MolangExpression | MolangVector3 | Record<string, MolangExpression | MolangVector3 | AnimationKeyframe>;\n'
      + '/** Ordered rotations can name an axis for each operation. */\n'
      + 'export interface AnimationAxisRotation { x?: MolangExpression; y?: MolangExpression; z?: MolangExpression; }\n'
      + 'export type AnimationRotation = AnimationChannel | (MolangExpression | AnimationAxisRotation)[];\n';
  }

  return finish(names, imports, extra);
}
