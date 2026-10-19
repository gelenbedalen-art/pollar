/** Compatibility names backed by the current generated ramp contract. */
import type { paths } from './schema';
export type {
  RampContinuationBody as RampContinuation,
  RampAction as RampWorkflowAction,
  RampsRoutesResponse as RampWorkflowRoutes,
  RampTerms as RampWorkflowTerms,
  RampsTransactionResponse as RampWorkflowView,
} from '../types';
export type RampWorkflowPaths = Pick<paths, '/ramps/routes' | '/ramps/transaction/{txId}/continue'>;
