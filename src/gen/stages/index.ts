import type { StageDef } from '../pipeline';
import { baseStage } from './base';
import { climateStage } from './climate';
import { hydroStage } from './hydro';
import { lemStage, refineStage } from './lem';
import { platesStage } from './plates';
import { stampsStage } from './stamps';

/** Stages in pipeline order (PLAN.md §3). Later milestones append climate, hydrology, … */
export const STAGES: readonly StageDef[] = [platesStage, baseStage, stampsStage, lemStage, refineStage, climateStage, hydroStage];
