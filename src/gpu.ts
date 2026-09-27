import { z } from 'zod';
import { DecimalString, type Source, type Evidence } from './schema';
export const GPUSchema = z
  .object({
    provider: z.string(),
    offer_id: z.string(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .nullable(),
    region: z.string().nullable(),
    region_evidence: z.string().nullable(),
    accelerator_model: z.string().nullable(),
    vram_gb: DecimalString.nullable(),
    form_factor: z.enum(['SXM', 'PCIe', 'unknown']),
    interconnect: z.string().nullable(),
    gpu_count: z.number().int().positive().nullable(),
    dedicated_or_shared: z.enum(['dedicated', 'shared', 'unknown']),
    contract_type: z.enum(['on_demand', 'spot', 'reserved', 'monthly', 'unknown']),
    interruptible: z.boolean().nullable(),
    minimum_term: z.string().nullable(),
    commitment: z.string().nullable(),
    amount_decimal: DecimalString.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    billing_unit: z.enum(['gpu_hour', 'node_hour', 'second', 'month']),
    includes_cpu_ram_storage: z.string().nullable(),
    egress_notes: z.string().nullable(),
    tax_status: z.enum(['included', 'excluded', 'unknown']),
    availability_status: z.enum(['available', 'unavailable', 'unknown']),
    availability_evidence: z.string().nullable(),
    observation_basis: z.literal('advertised_quote'),
    synthetic: z.boolean(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.country || v.region) && !v.region_evidence)
      c.addIssue({
        code: 'custom',
        message: 'region_evidence_required',
        path: ['region_evidence'],
      });
    if (v.availability_status !== 'unknown' && !v.availability_evidence)
      c.addIssue({
        code: 'custom',
        message: 'availability_evidence_required',
        path: ['availability_evidence'],
      });
  });
export type GPUQuote = z.infer<typeof GPUSchema>;
export interface GPUAdapter {
  readonly source: Source;
  // Acquisition remains under the common policy/network gate.
  parse(evidence: Evidence): { quotes: GPUQuote[]; issues: string[]; complete: boolean };
}
// Importers must supply evidence, source policy and all contract dimensions;
// no provider-minimum synthesis or default US region is permitted.
