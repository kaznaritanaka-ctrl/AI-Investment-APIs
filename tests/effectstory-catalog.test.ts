import { expect, it } from 'vitest';
import { identifyGPU } from '../src/gpu';

it('distinguishes GB300, B300, and GB200 without inventing SKU details', () => {
  for (const [label, model] of [
    ['GB300 NVL72', 'GB300'],
    ['GB300 SXM6', 'GB300'],
    ['HGX B300', 'B300'],
    ['B300 (p6-b300.48xlarge)', 'B300'],
    ['GB200 NVL72', 'GB200'],
    ['B200', 'B200'],
  ]) {
    const identity = identifyGPU(label);
    expect(identity.accelerator_model).toBe(model);
    expect(identity.gpu_sku_id).toBeNull();
  }
  expect(identifyGPU('unknown synthetic accelerator').accelerator_model).toBeNull();
});
