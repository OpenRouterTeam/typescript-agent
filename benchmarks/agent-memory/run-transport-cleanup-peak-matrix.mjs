import { runRetentionPeakMatrix } from './retention-peak-matrix.mjs';

runRetentionPeakMatrix(new URL('./measure-transport-cleanup-case.mjs', import.meta.url), [
  'legacy-retained',
  'transport-released',
]);
