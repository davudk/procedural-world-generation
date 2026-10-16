import type { StageDef } from '../pipeline';
import { baseStage } from './base';
import { biomeStage } from './biome';
import { climateStage } from './climate';
import { glacialStage } from './glacial';
import { hydroStage } from './hydro';
import { landformsStage } from './landforms';
import { lemStage, refineStage } from './lem';
import { platesStage } from './plates';
import { stampsStage } from './stamps';

/** Stages in pipeline order (PLAN.md §3). */
export const STAGES: readonly StageDef[] = [
  platesStage, baseStage, stampsStage, lemStage, refineStage, climateStage, glacialStage, landformsStage, hydroStage, biomeStage,
];
