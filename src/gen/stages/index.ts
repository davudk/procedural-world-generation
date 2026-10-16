import type { StageDef } from '../pipeline';
import { baseStage } from './base';
import { platesStage } from './plates';

/** Stages in pipeline order. M0 has placeholders for S1–S2; later milestones append. */
export const STAGES: readonly StageDef[] = [platesStage, baseStage];
